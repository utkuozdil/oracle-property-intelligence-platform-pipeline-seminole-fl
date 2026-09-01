/**
 * Source A — the Building Public Request Portal, the bulk census.
 *
 * ASP.NET WebForms 4 with a Telerik RadGrid 2014.1.326.35, queried by application type x
 * calendar month rather than by parcel. That inversion is the whole reason this tier is
 * affordable: it replaces one request per parcel with a few hundred month-window searches.
 *
 * Three things about it are counter-intuitive enough to have their own guards below:
 * the dropdown posts codes and not labels, a range spanning two months is rejected in a
 * way that renders as "no records", and the pager's Next button survives the last page.
 */
import {
  ALL_TYPES_CODE,
  BROWSER_USER_AGENT,
  CENSUS_COLUMN_COUNT,
  CONTROL_ID_PREFIX,
  CONTROL_PREFIX,
  DATE_VALIDATOR_ID,
  GRID_TABLE_ID,
  PICKER_MAX_DATE,
  PICKER_MIN_DATE,
  ROOFING_TYPE_CODES,
  SOURCE_A_DELAY_MS,
  SOURCE_A_ORIGIN,
  SOURCE_A_URL,
  SUBMIT_BUTTON_VALUE,
} from './config';
import { parseUsDate } from './dates';
import { hiddenInputs, parseAttributes, spanById, startTags, tableById, tableRows } from './html';
import {
  CookieJar,
  jitteredDelayMs,
  requestWithRetry,
  sleep,
  type FetchOutcome,
} from './http';
import type { CensusResponseState, CensusRow } from './model';

/**
 * A query the server refused. Never recorded as zero rows: a rejected month that is
 * counted as empty silently deletes that month from the census, and the rejection renders
 * an empty grid rather than an error page.
 */
export class CensusQueryRejectedError extends Error {
  override readonly name = 'CensusQueryRejectedError';
  constructor(
    readonly validatorMessage: string,
    readonly query: { applicationType: string; periodStart: string; periodEnd: string },
  ) {
    super(
      `Source A rejected ${query.applicationType} ${query.periodStart}..${query.periodEnd}: ` +
        `"${validatorMessage}"`,
    );
  }
}

/** The response carried no grid at all, so it cannot be read as empty either. */
export class CensusGridMissingError extends Error {
  override readonly name = 'CensusGridMissingError';
}

/** Collected fewer rows than the server said existed. A coverage shortfall, not a warning. */
export class CensusShortfallError extends Error {
  override readonly name = 'CensusShortfallError';
}

const REQUEST_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: SOURCE_A_URL,
  Origin: SOURCE_A_ORIGIN,
};

/** `2026-08-01` -> `8/1/2026`, the format the visible `dateInput` carries. */
export function toUsDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${Number(month)}/${Number(day)}/${Number(year)}`;
}

/** Last day of a `YYYY-MM` month, so a shard never spills into the next one. */
export function monthBounds(month: string): { periodStart: string; periodEnd: string } {
  const [year, monthIndex] = month.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  return {
    periodStart: `${month}-01`,
    periodEnd: `${month}-${String(lastDay).padStart(2, '0')}`,
  };
}

/** Every `YYYY-MM` from `fromMonth` to `toMonth` inclusive. */
export function monthsBetween(fromMonth: string, toMonth: string): string[] {
  const months: string[] = [];
  const [fromYear, fromIndex] = fromMonth.split('-').map(Number) as [number, number];
  const [toYear, toIndex] = toMonth.split('-').map(Number) as [number, number];
  let cursor = fromYear * 12 + (fromIndex - 1);
  const end = toYear * 12 + (toIndex - 1);
  while (cursor <= end) {
    months.push(`${Math.floor(cursor / 12)}-${String((cursor % 12) + 1).padStart(2, '0')}`);
    cursor += 1;
  }
  return months;
}

function telerikClientState(isoDate: string): string {
  return JSON.stringify({
    enabled: true,
    emptyMessage: '',
    validationText: `${isoDate}-00-00-00`,
    valueAsString: `${isoDate}-00-00-00`,
    minDateStr: `${PICKER_MIN_DATE}-00-00-00`,
    maxDateStr: `${PICKER_MAX_DATE}-00-00-00`,
    lastSetTextBoxValue: toUsDate(isoDate),
  });
}

/**
 * The search criteria, which must be present on *every* postback — including pager clicks.
 *
 * A pager postback that omits them posts the date pickers back empty, and the server
 * re-binds the grid against an empty range: the response looks like a valid short page and
 * quietly truncates the month.
 */
export function criteriaFields(query: {
  applicationType: string;
  periodStart: string;
  periodEnd: string;
}): Record<string, string> {
  return {
    // The dropdown's option values are short codes. Posting the display label is not a
    // valid option value, so ASP.NET discards it and silently reverts to `ALL`.
    [`${CONTROL_PREFIX}TypeDropDownList`]: query.applicationType,
    [`${CONTROL_PREFIX}StartDatePicker`]: query.periodStart,
    [`${CONTROL_PREFIX}StartDatePicker$dateInput`]: toUsDate(query.periodStart),
    [`${CONTROL_PREFIX}EndDatePicker`]: query.periodEnd,
    [`${CONTROL_PREFIX}EndDatePicker$dateInput`]: toUsDate(query.periodEnd),
    [`${CONTROL_ID_PREFIX}StartDatePicker_dateInput_ClientState`]: telerikClientState(
      query.periodStart,
    ),
    [`${CONTROL_ID_PREFIX}EndDatePicker_dateInput_ClientState`]: telerikClientState(
      query.periodEnd,
    ),
  };
}

/** The `"N items in M pages"` figures, absent whenever the result fits on one page. */
export function statedTotals(html: string): { total: number; pages: number } | null {
  const marker = html.indexOf('rgInfoPart');
  if (marker < 0) return null;
  const open = html.indexOf('>', marker);
  const close = html.indexOf('</div>', open);
  if (open < 0 || close < 0) return null;
  // The count is wrapped in `<strong>`: `<strong>176</strong> items in <strong>4</strong>`.
  const text = html
    .slice(open + 1, close)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ');
  const match = /([\d,]+)\s+items?\s+in\s+([\d,]+)\s+pages?/i.exec(text);
  if (!match) return null;
  return {
    total: Number((match[1] ?? '').replace(/,/g, '')),
    pages: Number((match[2] ?? '').replace(/,/g, '')),
  };
}

/**
 * The message of the date validator, but only when the server actually left it visible.
 *
 * ASP.NET renders the span up front carrying its error text and hides it with
 * `visibility:hidden` until it fires. Treating "the span has text" as the rejection signal
 * marks every successful response rejected; ignoring the span marks every rejected month
 * empty. Visibility is the signal.
 */
export function activeValidatorMessage(html: string): string | null {
  const span = spanById(html, DATE_VALIDATOR_ID);
  if (!span || !span.visible) return null;
  return span.text || null;
}

export function classifyResponse(html: string): CensusResponseState {
  if (activeValidatorMessage(html)) return 'REJECTED';
  const table = tableById(html, GRID_TABLE_ID);
  if (!table) return 'NO_GRID';
  if (/class="[^"]*\brgNoRecords\b/.test(table)) return 'EMPTY';
  return statedTotals(html) ? 'PAGED' : 'SINGLE_PAGE';
}

/**
 * The pager's Next control name, scraped rather than constructed.
 *
 * The index shifts with how many numeric page links are rendered — `ctl14` on a 4-page
 * result, `ctl28` on a 38-page one — so it can never be hardcoded.
 */
export function pageNextControl(html: string): string | null {
  for (const tag of startTags(html, 'input')) {
    const attributes = parseAttributes(tag);
    if ((attributes.type ?? '').toLowerCase() !== 'submit') continue;
    if ((attributes.class ?? '').split(/\s+/).includes('rgPageNext')) return attributes.name ?? null;
  }
  return null;
}

/** `MM/DD/YY` with the century resolved so a two-digit year never lands in the future. */
export function resolveIssueDate(raw: string, referenceYear?: number): string | null {
  return parseUsDate(raw, referenceYear);
}

/** `33,729` -> 33729. Blank and `.00` variants are common; a non-numeric stays null. */
export function parseValuation(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** `R100 REROOF RESIDENTIAL` -> `R100`. The description's leading token is the type code. */
export function applicationCodeOf(description: string): string | null {
  const match = /^([A-Z0-9]{3,4})\s/.exec(description.trim());
  return match?.[1] ?? null;
}

/**
 * `BPRF BLDG PERMIT/ROOF` -> `BPRF`. The `permitType` column's own leading token.
 *
 * Deliberately not {@link applicationCodeOf} with a different argument: that one fixes the
 * code at three or four characters, which is right for the description vocabulary and wrong
 * here — `RR REROOF` is the single most common roofing code in the county and is two.
 */
export function permitTypeCodeOf(permitType: string): string | null {
  const match = /^([A-Z0-9]+)\s/.exec(permitType.trim());
  return match?.[1] ?? null;
}

/**
 * Grid rows for one page.
 *
 * `appNo` is not unique — one application yields a row per structure and permit-type
 * sequence — so every row also carries the composite key it is deduplicated on. Rows that
 * do not have exactly the expected cell count are returned as rejects rather than mapped
 * positionally against a layout that has evidently changed.
 */
export function parseCensusPage(
  html: string,
  context: { applicationType: string; month: string },
): { rows: CensusRow[]; malformed: number } {
  const table = tableById(html, GRID_TABLE_ID);
  if (!table) throw new CensusGridMissingError('grid table absent from response');

  const rows: CensusRow[] = [];
  let malformed = 0;

  for (const row of tableRows(table)) {
    if (!row.classes.includes('rgRow') && !row.classes.includes('rgAltRow')) continue;
    if (row.cells.length !== CENSUS_COLUMN_COUNT) {
      malformed += 1;
      continue;
    }
    const [
      appNo,
      description,
      parcelId,
      propertyAddress,
      cityCode,
      stateCode,
      zipCode,
      propertySubdivision,
      structureSequence,
      permitTypeSequence,
      issueDate,
      permitType,
      ownerName,
      contractorName,
      valuationAmount,
    ] = row.cells as string[];

    const code = applicationCodeOf(description ?? '');
    rows.push({
      appNo: appNo ?? '',
      description: description ?? '',
      parcelId: parcelId ?? '',
      propertyAddress: propertyAddress ?? '',
      cityCode: cityCode ?? '',
      stateCode: stateCode ?? '',
      zipCode: zipCode ?? '',
      propertySubdivision: propertySubdivision ?? '',
      structureSequence: structureSequence ?? '',
      permitTypeSequence: permitTypeSequence ?? '',
      issueDate: issueDate ?? '',
      permitType: permitType ?? '',
      ownerName: ownerName ?? '',
      contractorName: contractorName ?? '',
      valuationAmount: valuationAmount ?? '',
      rowKey: `${appNo}|${structureSequence}|${permitTypeSequence}`,
      issuedOn: resolveIssueDate(issueDate ?? ''),
      valuationUsd: parseValuation(valuationAmount ?? ''),
      roofingRelevant: code !== null && ROOFING_TYPE_CODES.has(code),
      applicationType: context.applicationType,
      month: context.month,
    });
  }

  return { rows, malformed };
}

export interface CensusPage {
  html: string;
  state: CensusResponseState;
  durationMs: number;
}

/**
 * One portal session.
 *
 * A single GET is enough for an entire sweep: every search response carries a fresh, valid
 * viewstate that builds the next search, so N searches cost 1 GET + N POSTs rather than 2N.
 */
export class CensusSession {
  private readonly jar = new CookieJar();
  private hidden: Record<string, string> = {};
  private ready = false;

  async open(): Promise<void> {
    const response = await requestWithRetry(
      SOURCE_A_URL,
      { method: 'GET', headers: { ...REQUEST_HEADERS, 'User-Agent': userAgent() } },
      { baseDelayMs: SOURCE_A_DELAY_MS },
    );
    this.absorb(response);
    this.hidden = hiddenInputs(response.body);
    if (!this.hidden.__VIEWSTATE) {
      throw new Error('Source A initial GET carried no __VIEWSTATE — the portal has changed');
    }
    this.ready = true;
  }

  cookieNames(): string[] {
    return this.jar.names();
  }

  private absorb(response: FetchOutcome): void {
    this.jar.absorb(response.headers);
  }

  private async post(fields: Record<string, string>): Promise<CensusPage> {
    const response = await requestWithRetry(
      SOURCE_A_URL,
      {
        method: 'POST',
        headers: {
          ...REQUEST_HEADERS,
          'User-Agent': userAgent(),
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(this.jar.header() ? { Cookie: this.jar.header() } : {}),
        },
        body: new URLSearchParams(fields).toString(),
      },
      { baseDelayMs: SOURCE_A_DELAY_MS },
    );
    this.absorb(response);
    const state = classifyResponse(response.body);
    // Only adopt a viewstate that came back with a grid; a rejected response's viewstate
    // carries the bad range forward into the next search.
    if (state !== 'NO_GRID') this.hidden = hiddenInputs(response.body);
    return { html: response.body, state, durationMs: response.durationMs };
  }

  /** The first page of a search. */
  async search(query: {
    applicationType: string;
    periodStart: string;
    periodEnd: string;
  }): Promise<CensusPage> {
    if (!this.ready) throw new Error('CensusSession.open() must be called before search()');
    const page = await this.post({
      ...this.hidden,
      __EVENTTARGET: '',
      __EVENTARGUMENT: '',
      ...criteriaFields(query),
      // `SelectImageButton` is a `type=image` control and must not be sent: only the
      // clicked button posts, and sending both makes the postback ambiguous.
      [`${CONTROL_PREFIX}SubmitRequestButton`]: SUBMIT_BUTTON_VALUE,
    });
    if (page.state === 'REJECTED') {
      throw new CensusQueryRejectedError(activeValidatorMessage(page.html) ?? 'unknown', query);
    }
    return page;
  }

  /** The next page of the current result set, or null when the pager is exhausted. */
  async nextPage(
    current: string,
    query: { applicationType: string; periodStart: string; periodEnd: string },
  ): Promise<CensusPage | null> {
    const control = pageNextControl(current);
    if (!control) return null;
    return this.post({
      ...hiddenInputs(current),
      __EVENTTARGET: '',
      __EVENTARGUMENT: '',
      ...criteriaFields(query),
      [control]: ' ',
    });
  }
}

/** A default `curl`/`node` agent is filtered by the host, so this is load-bearing. */
function userAgent(): string {
  return BROWSER_USER_AGENT;
}

/**
 * Whether two rows carrying the same key are the same row.
 *
 * Compares only what the grid actually rendered; the derived fields are functions of these.
 */
function sameRow(left: CensusRow, right: CensusRow): boolean {
  return (
    left.description === right.description &&
    left.parcelId === right.parcelId &&
    left.propertyAddress === right.propertyAddress &&
    left.issueDate === right.issueDate &&
    left.permitType === right.permitType &&
    left.ownerName === right.ownerName &&
    left.contractorName === right.contractorName &&
    left.valuationAmount === right.valuationAmount
  );
}

export interface SweepOutcome {
  state: CensusResponseState;
  statedTotal: number | null;
  statedPages: number | null;
  pagesFetched: number;
  rowsSeen: number;
  rows: CensusRow[];
  malformedRows: number;
  latencies: number[];
  warnings: string[];
}

/**
 * Every page of one application type over one month, deduplicated.
 *
 * Termination does not trust the pager. `rgPageNext` is still rendered on the last page and
 * re-serves it indefinitely — a naive "follow Next until it disappears" loop measured here
 * fetched 61 pages of a 38-page result and inflated 1,884 rows to 2,666. The loop is bounded
 * by the server's own stated page count, and a page identical to its predecessor also ends
 * it, so a result with no stated total cannot spin either.
 */
export async function sweepMonth(
  session: CensusSession,
  query: { applicationType: string; periodStart: string; periodEnd: string; month: string },
  onPage: (page: { html: string; index: number }) => Promise<void>,
): Promise<SweepOutcome> {
  const warnings: string[] = [];
  const latencies: number[] = [];
  const deduplicated = new Map<string, CensusRow>();
  let rowsSeen = 0;
  let malformedRows = 0;
  let keyConflicts = 0;

  let page = await session.search(query);
  latencies.push(page.durationMs);
  await onPage({ html: page.html, index: 1 });

  const totals = statedTotals(page.html);
  if (page.state === 'EMPTY') {
    return {
      state: 'EMPTY',
      statedTotal: 0,
      statedPages: 0,
      pagesFetched: 1,
      rowsSeen: 0,
      rows: [],
      malformedRows: 0,
      latencies,
      warnings,
    };
  }
  if (page.state === 'NO_GRID') {
    throw new CensusGridMissingError(
      `Source A returned no grid for ${query.applicationType} ${query.month}`,
    );
  }

  const absorb = (html: string): void => {
    const parsed = parseCensusPage(html, {
      applicationType: query.applicationType,
      month: query.month,
    });
    malformedRows += parsed.malformed;
    rowsSeen += parsed.rows.length + parsed.malformed;
    for (const row of parsed.rows) {
      /**
       * Overwriting on a repeated key is only safe if the two rows are the same row. Pages
       * overlap because row order varies between identical queries, so collisions are
       * expected and the overlap is the point. A collision whose *content* differs means
       * something else: the composite key does not identify a row, and every collision is
       * silently discarding a real permit. That has to surface rather than be absorbed.
       */
      const seen = deduplicated.get(row.rowKey);
      if (seen && !sameRow(seen, row)) keyConflicts += 1;
      deduplicated.set(row.rowKey, row);
    }
  };

  absorb(page.html);
  let previousSignature = pageSignature(page.html);
  let pagesFetched = 1;
  const pageCeiling = totals?.pages ?? 1;

  while (pagesFetched < pageCeiling) {
    await sleep(jitteredDelayMs(SOURCE_A_DELAY_MS));
    const next = await session.nextPage(page.html, query);
    if (!next) {
      warnings.push(`pager ended at page ${pagesFetched} of a stated ${pageCeiling}`);
      break;
    }
    if (next.state === 'REJECTED') {
      throw new CensusQueryRejectedError(activeValidatorMessage(next.html) ?? 'unknown', query);
    }
    const signature = pageSignature(next.html);
    if (signature === previousSignature) {
      // The last page re-served. Expected on the final click, so not a warning unless it
      // happens before the stated page count is reached.
      if (pagesFetched < pageCeiling) {
        warnings.push(`page ${pagesFetched + 1} repeated page ${pagesFetched}`);
      }
      break;
    }
    previousSignature = signature;
    page = next;
    pagesFetched += 1;
    latencies.push(next.durationMs);
    await onPage({ html: next.html, index: pagesFetched });
    absorb(next.html);
  }

  if (totals && rowsSeen < totals.total) {
    throw new CensusShortfallError(
      `${query.applicationType} ${query.month}: collected ${rowsSeen} rows but the server ` +
        `stated ${totals.total} — refusing to record a partial month`,
    );
  }
  if (totals && rowsSeen > totals.total) {
    warnings.push(`collected ${rowsSeen} rows against a stated total of ${totals.total}`);
  }
  if (malformedRows > 0) {
    warnings.push(`${malformedRows} rows did not have ${CENSUS_COLUMN_COUNT} cells`);
  }
  if (keyConflicts > 0) {
    warnings.push(
      `${keyConflicts} rows shared (AppNo, StructureSequence, PermitTypeSequence) with ` +
        'differing content — the dedupe key does not identify a row',
    );
  }

  return {
    state: page.state,
    statedTotal: totals?.total ?? deduplicated.size,
    statedPages: totals?.pages ?? 1,
    pagesFetched,
    rowsSeen,
    rows: [...deduplicated.values()],
    malformedRows,
    latencies,
    warnings,
  };
}

/**
 * A page's row identity, so a re-served page can be recognised.
 *
 * Row *order* is not stable between identical queries, so the signature is order
 * independent: an ordered digest would treat a reshuffled page as a new one.
 */
function pageSignature(html: string): string {
  const table = tableById(html, GRID_TABLE_ID);
  if (!table) return '';
  return tableRows(table)
    .filter((row) => row.classes.includes('rgRow') || row.classes.includes('rgAltRow'))
    .map((row) => row.cells.join('\u0001'))
    .sort()
    .join('\u0002');
}

export const CENSUS_ALL_TYPES = ALL_TYPES_CODE;

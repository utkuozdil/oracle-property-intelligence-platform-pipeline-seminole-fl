/**
 * Source B — Click2Gov, status and open duration.
 *
 * Keyed by application number, which joins directly to Source A's `AppNo`. That is the
 * only cap-free path: address, parcel, and name search all truncate at exactly 50 rows
 * with no warning and no pagination, so none of them can be used to enumerate anything.
 * Source A is therefore a hard prerequisite for this source, not an alternative to it.
 */
import {
  BROWSER_USER_AGENT,
  SOURCE_B_ROOT,
  SOURCE_B_URL,
  SOURCE_B_DELAY_MS,
  mapStatus,
  normalizeStatus,
} from './config';
import { parseUsDate } from './dates';
import { pageTitle, staticFormFields, tableRows } from './html';
import { CookieJar, requestWithRetry } from './http';
import type { InspectionRow, PermitStatusRecord, RoofingMatchRule } from './model';

/** Click2Gov served an error page instead of a detail page. */
export class PermitDetailUnavailableError extends Error {
  override readonly name = 'PermitDetailUnavailableError';
}

/**
 * `26-12426` -> `{ appYear: '26', appNumber: '12426' }`.
 *
 * Result lists render the number zero-padded to eight digits (`26-00012426`) but the search
 * accepts it unpadded, so the padding is stripped rather than reproduced.
 */
export function splitApplicationNumber(appNo: string): { appYear: string; appNumber: string } {
  const [year, number] = appNo.split('-');
  if (!year || !number) throw new Error(`malformed application number: ${appNo}`);
  return { appYear: year, appNumber: String(Number(number)) };
}

/**
 * The `OWASP_CSRFTOKEN` for this session, lifted out of the detail page's own navigation.
 *
 * It is genuinely optional on the select POST — a bare, cookie-less POST returns the full
 * Status Detail page. It is *not* optional on the sub-views: they carry it as a query
 * parameter, and a sub-view GET without it returns Click2Gov's generic error page rather
 * than an empty result, which is how a missing token would otherwise read as "no
 * inspections" and silently strip every close date.
 */
export function csrfTokenOf(html: string): string | null {
  return /OWASP_CSRFTOKEN=([A-Z0-9-]+)/i.exec(html)?.[1] ?? null;
}

function headers(jar: CookieJar | null, extra: Record<string, string> = {}): Record<string, string> {
  const cookie = jar?.header();
  return {
    'User-Agent': BROWSER_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra,
  };
}

export interface StatusDetailFetch {
  html: string;
  durationMs: number;
  csrfToken: string | null;
  jar: CookieJar;
}

/**
 * The single stateless POST that returns a permit's Status Detail page.
 *
 * `searchMethod=0` resolves to exactly one permit, so there is no result list to page and
 * no cap to hit. Session cookies are captured anyway, because the sub-views read the
 * selected permit out of server-side session state.
 */
export async function fetchStatusDetail(appNo: string): Promise<StatusDetailFetch> {
  const { appYear, appNumber } = splitApplicationNumber(appNo);
  const jar = new CookieJar();
  const response = await requestWithRetry(
    SOURCE_B_URL,
    {
      method: 'POST',
      headers: headers(null, { 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: new URLSearchParams({
        validatePermitView: 'true',
        searchType: '0',
        searchMethod: '0',
        'permit.appYear': appYear,
        'permit.appNumber': appNumber,
        finish: 'Continue',
      }).toString(),
    },
    // latin1: the response declares ISO-8859-1, and decoding it as UTF-8 mangles every
    // accented owner name into replacement characters.
    { encoding: 'latin1', baseDelayMs: SOURCE_B_DELAY_MS },
  );
  jar.absorb(response.headers);

  const title = pageTitle(response.body) ?? '';
  if (!/status detail/i.test(title)) {
    throw new PermitDetailUnavailableError(
      `Source B returned "${title}" for ${appNo} rather than a Status Detail page`,
    );
  }

  return {
    html: response.body,
    durationMs: response.durationMs,
    csrfToken: csrfTokenOf(response.body),
    jar,
  };
}

/**
 * The inspections sub-view for the permit currently selected in `jar`'s session.
 *
 * Returns null when the view is unreachable. That is deliberately not an error: the close
 * date is derived from this page, and a permit whose close date cannot be established must
 * be recorded with a null close date rather than dropped or retried forever.
 */
export async function fetchInspections(
  jar: CookieJar,
  csrfToken: string | null,
): Promise<{ html: string; durationMs: number } | null> {
  if (!csrfToken) return null;
  const url = `${SOURCE_B_ROOT}selectinsp.html?OWASP_CSRFTOKEN=${csrfToken}&projectInspView=true`;
  const response = await requestWithRetry(
    url,
    { method: 'GET', headers: headers(jar, { Referer: `${SOURCE_B_ROOT}permitinfo.html` }) },
    { encoding: 'latin1', baseDelayMs: SOURCE_B_DELAY_MS },
  );
  const title = pageTitle(response.body) ?? '';
  if (!/inspection/i.test(title)) return null;
  return { html: response.body, durationMs: response.durationMs };
}

const INSPECTION_HEADERS = ['inspection type', 'scheduled date', 'status', 'result date'];

/**
 * Inspection rows. The header row is matched on its labels rather than skipped by index,
 * because a permit with no inspections renders the header and nothing else — which is the
 * signal that the permit is still open, not that the page failed.
 */
export function parseInspections(html: string): InspectionRow[] {
  const rows: InspectionRow[] = [];
  for (const row of tableRows(html)) {
    const cells = row.cells;
    if (cells.length < 4) continue;
    const lowered = cells.slice(0, 4).map((cell) => cell.toLowerCase());
    if (INSPECTION_HEADERS.every((label, index) => lowered[index] === label)) continue;
    const [inspectionType, scheduledDate, status, resultDate, permitDescription] = cells as string[];
    if (!inspectionType) continue;
    rows.push({
      inspectionType,
      scheduledDate: normalizeDate(scheduledDate ?? ''),
      status: status ?? '',
      resultDate: normalizeDate(resultDate ?? ''),
      permitDescription: permitDescription ?? '',
    });
  }
  return rows;
}

/**
 * `10/25/2021` or `08/26/26` -> `2021-10-25`.
 *
 * Source B reaches permits back to 1984, so the century rule has to cope with two-digit
 * years from either century. `12/31/84` is a real 1984 application date — the legacy
 * migration into Click2Gov dated pre-1996 permits to December 31 of their application year.
 */
export function normalizeDate(raw: string, referenceYear?: number): string | null {
  return parseUsDate(raw, referenceYear);
}

/**
 * The close date: the result date of the terminal inspection.
 *
 * Source B has no close or completion date field anywhere, so "closed on" is the latest
 * result date among inspections that actually resolved. An inspection with no result date
 * has not happened yet and contributes nothing.
 */
export function terminalInspectionDate(inspections: readonly InspectionRow[]): string | null {
  const resolved = inspections
    .map((inspection) => inspection.resultDate)
    .filter((date): date is string => date !== null);
  if (resolved.length === 0) return null;
  return resolved.reduce((latest, date) => (date > latest ? date : latest));
}

export function daysBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

function parseMoney(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function parseInteger(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[,\s]/g, '');
  if (!/^\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}

const emptyToNull = (value: string | undefined): string | null => (value ? value : null);

export interface BuildStatusRecordOptions {
  runId: string;
  appNo: string;
  statusHtml: string;
  inspectionsHtml: string | null;
  statusRawKey: string;
  inspectionsRawKey: string | null;
  /** Injected so open duration is reproducible in a test rather than clock-dependent. */
  now: Date;
  /** From the census, which holds the application-type code. Defaults to not roofing. */
  roofingRelevant?: boolean;
  /** Which census roofing vocabularies selected this application. */
  roofingMatchedBy?: RoofingMatchRule[];
  censusIssuedOn?: string | null;
}

/**
 * A status record assembled from the detail page plus, when it was reachable, the
 * inspections view.
 *
 * Open duration is modelled in three states rather than two. A permit that is open runs to
 * `now`; a permit that is closed runs to its terminal inspection's result date; and a
 * permit that reads terminal but whose close date could not be established is `unknown`
 * with a null duration. Collapsing that third case into either of the others is what turns
 * a missing close date into a fabricated one.
 */
export function buildStatusRecord(options: BuildStatusRecordOptions): {
  record: PermitStatusRecord;
  unmappedStatus: string | null;
} {
  const fields = staticFormFields(options.statusHtml);
  const rawStatus = normalizeStatus(fields.Application ?? '');
  const mapping = mapStatus(rawStatus);
  const inspections = options.inspectionsHtml ? parseInspections(options.inspectionsHtml) : [];
  const applicationDate = normalizeDate(fields['Application Date'] ?? '');
  const closedDate = mapping?.terminal ? terminalInspectionDate(inspections) : null;

  let openDurationDays: number | null = null;
  let openDurationBasis: PermitStatusRecord['openDurationBasis'] = 'unknown';
  if (applicationDate && mapping) {
    if (mapping.terminal) {
      if (closedDate) {
        openDurationDays = daysBetween(applicationDate, closedDate);
        openDurationBasis = 'closed';
      }
    } else {
      openDurationDays = daysBetween(applicationDate, options.now.toISOString().slice(0, 10));
      openDurationBasis = 'still_open';
    }
  }

  return {
    record: {
      runId: options.runId,
      appNo: options.appNo,
      parcelId: emptyToNull(fields['Parcel ID']),
      address: emptyToNull(fields.Address),
      applicationDate,
      applicationType: emptyToNull(fields['Application Type']),
      owner: emptyToNull(fields.Owner),
      tenantName: emptyToNull(fields['Tenant Name']),
      generalContractor: emptyToNull(fields['General Contractor']),
      zoningDescription: emptyToNull(fields['Zoning Description']),
      valuationUsd: parseMoney(fields.Valuation),
      squareFootage: parseInteger(fields['Square Footage']),
      rawStatus,
      canonicalStatus: mapping?.canonical ?? 'unknown',
      lifecycle: mapping?.lifecycle ?? 'unknown',
      terminal: mapping?.terminal ?? false,
      harvestedAt: options.now.toISOString(),
      roofingRelevant: options.roofingRelevant ?? false,
      roofingMatchedBy: options.roofingMatchedBy ?? [],
      censusIssuedOn: options.censusIssuedOn ?? null,
      closedDate,
      closedDateSource: closedDate ? 'terminal_inspection' : 'unavailable',
      openDurationDays,
      openDurationBasis,
      inspections,
      statusRawKey: options.statusRawKey,
      inspectionsRawKey: options.inspectionsRawKey,
    },
    // An unrecognised status is never bucketed by guess. Seven values were observed and the
    // full enumeration is undocumented, so anything else is quarantined and alerted.
    unmappedStatus: mapping ? null : rawStatus || '(blank)',
  };
}

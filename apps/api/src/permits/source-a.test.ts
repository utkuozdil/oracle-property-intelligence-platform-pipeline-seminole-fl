/**
 * Source A parsing, against HTML captured from the live portal on 2026-09-01.
 *
 * The fixtures are the whole point of this suite. Three of the assertions below encode
 * behaviour that contradicts `docs/seminole-permit-harvest-findings.md`, and each of the
 * three would silently lose data if the doc were implemented literally.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CENSUS_COLUMN_COUNT, DATE_VALIDATOR_ID, GRID_TABLE_ID } from './config';
import { hiddenInputs, spanById, tableById } from './html';
import {
  activeValidatorMessage,
  applicationCodeOf,
  classifyResponse,
  criteriaFields,
  monthBounds,
  monthsBetween,
  pageNextControl,
  parseCensusPage,
  parseValuation,
  resolveIssueDate,
  statedTotals,
  toUsDate,
} from './source-a';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '__fixtures__', name), 'utf8');

const paged = fixture('source-a-paged.html');
const singlePage = fixture('source-a-single-page.html');
const empty = fixture('source-a-empty.html');
const rejected = fixture('source-a-rejected.html');

describe('response classification', () => {
  it('tells the four states apart on real responses', () => {
    expect(classifyResponse(paged)).toBe('PAGED');
    expect(classifyResponse(singlePage)).toBe('SINGLE_PAGE');
    expect(classifyResponse(empty)).toBe('EMPTY');
    expect(classifyResponse(rejected)).toBe('REJECTED');
  });

  /**
   * The documented signature for a rejected query is "grid table absent, body ~74 KB". It is
   * not: the live portal renders the full page with a populated `rgNoRecords` grid, 159 KB of
   * it. Classifying on the grid's absence marks a rejected month EMPTY and deletes it from
   * the census — the exact failure the doc warns is the most dangerous one available.
   */
  it('rejects a cross-month range even though it renders a grid that says "no records"', () => {
    expect(tableById(rejected, GRID_TABLE_ID)).not.toBeNull();
    expect(rejected).toContain('No records to display');
    expect(rejected.length).toBeGreaterThan(100_000);
    expect(classifyResponse(rejected)).toBe('REJECTED');
    expect(activeValidatorMessage(rejected)).toBe('The dates must be in the same month.');
  });

  /**
   * ASP.NET renders every validator span up front carrying its error text and suppresses it
   * with `visibility:hidden`. So "the span has text" is true on a perfectly good response,
   * and visibility is the only usable signal.
   */
  it('ignores the validator span when the server left it hidden', () => {
    const span = spanById(paged, DATE_VALIDATOR_ID);
    expect(span?.text).toBe('The end date must be after the start.');
    expect(span?.visible).toBe(false);
    expect(activeValidatorMessage(paged)).toBeNull();
  });

  it('reports no stated total for a single-page result', () => {
    // `.rgInfoPart` is absent whenever the result fits on one page, so a total derived only
    // from "N items in M pages" would read 13 real rows as zero.
    expect(statedTotals(singlePage)).toBeNull();
    expect(parseCensusPage(singlePage, { applicationType: 'C110', month: '2026-08' }).rows).toHaveLength(13);
  });
});

describe('stated totals', () => {
  /** The count is wrapped in `<strong>`, so a text-only regex over the raw HTML misses it. */
  it('reads the count through the interleaved <strong> tags', () => {
    expect(paged).toContain('<strong>176</strong> items in <strong>4</strong> pages');
    expect(statedTotals(paged)).toEqual({ total: 176, pages: 4 });
  });

  it('returns null when no pager information was rendered', () => {
    expect(statedTotals(empty)).toBeNull();
    expect(statedTotals('<div>nothing here</div>')).toBeNull();
  });
});

describe('pager control', () => {
  /**
   * The control index shifts with the number of numeric page links rendered — `ctl14` on this
   * 4-page result, `ctl28` on a 38-page one — so it can never be hardcoded.
   */
  it('scrapes the Next control rather than constructing its index', () => {
    expect(pageNextControl(paged)).toBe(
      'ctl00$ContentPlaceHolder7$BuildingPublicRequestPortal1$PermitListingForTypeRadGrid$ctl00$ctl03$ctl01$ctl14',
    );
  });

  it('finds no Next control on an unpaged result', () => {
    expect(pageNextControl(singlePage)).toBeNull();
    expect(pageNextControl(empty)).toBeNull();
  });
});

describe('row parsing', () => {
  const { rows, malformed } = parseCensusPage(paged, {
    applicationType: 'R100',
    month: '2026-08',
  });

  it('reads a full page of 15-cell rows with nothing malformed', () => {
    expect(rows).toHaveLength(50);
    expect(malformed).toBe(0);
    for (const row of rows) expect(row.appNo).toMatch(/^\d{2}-\d+$/);
  });

  it('maps the positional columns onto their documented names', () => {
    const row = rows.find((candidate) => candidate.appNo === '26-12426');
    expect(row).toMatchObject({
      appNo: '26-12426',
      description: 'R100 REROOF RESIDENTIAL',
      parcelId: '15-21-30-509-0000-0380',
      propertyAddress: '103 GULL CT',
      cityCode: 'CASSELBERRY',
      stateCode: 'FL',
      zipCode: '327070000',
      propertySubdivision: 'DEER RUN UNIT 06',
      issueDate: '08/31/26',
      permitType: 'RR REROOF',
      ownerName: 'NEUMANN, WILLIAM J & MARICONDA',
      contractorName: 'ERIE CONSTRUCTION MID-WEST(CCC',
      valuationAmount: '33,729',
      valuationUsd: 33_729,
      issuedOn: '2026-08-31',
      roofingRelevant: true,
    });
  });

  it('carries the composite row key, because AppNo alone is not unique', () => {
    const row = rows.find((candidate) => candidate.appNo === '26-12426');
    expect(row?.rowKey).toBe('26-12426|0 0|RR 0');
    // 50 rows on this page but fewer distinct application numbers: one application yields a
    // row per structure and permit-type sequence.
    const distinctAppNos = new Set(rows.map((candidate) => candidate.appNo));
    expect(distinctAppNos.size).toBeLessThanOrEqual(rows.length);
  });

  it('deduplicates on the composite key without collapsing distinct records', () => {
    const keys = new Set(rows.map((row) => row.rowKey));
    const wholeRows = new Set(
      rows.map((row) => [row.appNo, row.parcelId, row.issueDate, row.permitType].join('|')),
    );
    // Measured over a full month of ALL TYPES: 1,884 rows reduced to 1,499 by composite key,
    // and to exactly the same 1,499 by whole-row identity. The composite key is a true key.
    expect(keys.size).toBe(wholeRows.size);
  });

  it('rejects a row whose cell count has changed rather than mapping it positionally', () => {
    const mangled = paged.replace(
      '<td align="right">33,729</td>',
      '<td align="right">33,729</td><td>surprise</td>',
    );
    const result = parseCensusPage(mangled, { applicationType: 'R100', month: '2026-08' });
    expect(result.malformed).toBe(1);
    expect(result.rows).toHaveLength(49);
    expect(CENSUS_COLUMN_COUNT).toBe(15);
  });

  it('finds no rows in an empty grid', () => {
    expect(parseCensusPage(empty, { applicationType: 'EZRO', month: '2026-08' }).rows).toEqual([]);
  });
});

describe('viewstate round-tripping', () => {
  it('recovers every hidden field the portal ships', () => {
    const fields = hiddenInputs(paged);
    expect(fields.__VIEWSTATEGENERATOR).toBe('7191D65C');
    expect((fields.__VIEWSTATE ?? '').length).toBeGreaterThan(10_000);
    expect((fields.__EVENTVALIDATION ?? '').length).toBeGreaterThan(1_000);
    // The Telerik client-state fields ship empty and post fine empty.
    expect(fields).toHaveProperty(
      'ctl00_ContentPlaceHolder7_BuildingPublicRequestPortal1_PermitListingForTypeRadGrid_ClientState',
    );
  });
});

describe('search criteria', () => {
  it('posts the application type as its option code, not its label', () => {
    const fields = criteriaFields({
      applicationType: 'R100',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
    });
    const dropdown =
      fields['ctl00$ContentPlaceHolder7$BuildingPublicRequestPortal1$TypeDropDownList'];
    // Posting `REROOF RESIDENTIAL` is not a valid option value, so ASP.NET discards it and
    // silently falls back to `ALL` — which is how "the permit type reverted to its default".
    expect(dropdown).toBe('R100');
    expect(dropdown).not.toBe('REROOF RESIDENTIAL');
  });

  it('sends both the ISO picker value and the US-format visible input', () => {
    const fields = criteriaFields({
      applicationType: 'ALL',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
    });
    expect(fields['ctl00$ContentPlaceHolder7$BuildingPublicRequestPortal1$StartDatePicker']).toBe(
      '2026-08-01',
    );
    expect(
      fields['ctl00$ContentPlaceHolder7$BuildingPublicRequestPortal1$StartDatePicker$dateInput'],
    ).toBe('8/1/2026');
  });
});

describe('date and money helpers', () => {
  it('formats the visible date input without zero padding', () => {
    expect(toUsDate('2026-08-01')).toBe('8/1/2026');
    expect(toUsDate('1996-12-31')).toBe('12/31/1996');
  });

  it('bounds a month to its own last day, February included', () => {
    expect(monthBounds('2026-08')).toEqual({ periodStart: '2026-08-01', periodEnd: '2026-08-31' });
    expect(monthBounds('2026-02')).toEqual({ periodStart: '2026-02-01', periodEnd: '2026-02-28' });
    expect(monthBounds('2024-02')).toEqual({ periodStart: '2024-02-01', periodEnd: '2024-02-29' });
  });

  it('enumerates months across a year boundary', () => {
    expect(monthsBetween('2025-11', '2026-02')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    expect(monthsBetween('2026-08', '2026-08')).toEqual(['2026-08']);
  });

  /** The pivot is the 1996 data horizon, not a naive 50. A pivot at 50 dates 1996 to 2096. */
  it('resolves two-digit years against the data horizon', () => {
    expect(resolveIssueDate('08/31/26')).toBe('2026-08-31');
    expect(resolveIssueDate('03/15/96')).toBe('1996-03-15');
    expect(resolveIssueDate('11/01/99')).toBe('1999-11-01');
    expect(resolveIssueDate('01/02/00')).toBe('2000-01-02');
    expect(resolveIssueDate('')).toBeNull();
    expect(resolveIssueDate('not a date')).toBeNull();
  });

  it('parses the comma-formatted valuation and tolerates a blank', () => {
    expect(parseValuation('33,729')).toBe(33_729);
    expect(parseValuation('$1,250,000')).toBe(1_250_000);
    expect(parseValuation('')).toBeNull();
    expect(parseValuation('CONFIDENTIAL')).toBeNull();
  });

  it('reads the application code off the description', () => {
    expect(applicationCodeOf('R100 REROOF RESIDENTIAL')).toBe('R100');
    expect(applicationCodeOf('EZRO EZ REROOF RESIDENTIAL')).toBe('EZRO');
    expect(applicationCodeOf('')).toBeNull();
  });
});

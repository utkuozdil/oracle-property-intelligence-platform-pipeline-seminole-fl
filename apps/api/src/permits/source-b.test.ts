/**
 * Source B parsing, against Click2Gov HTML captured live on 2026-09-01.
 *
 * The pair of fixtures is a matched open/closed pair on the same parcel, which is what makes
 * the open-duration assertions meaningful: `21-13064` reproduces the documented 110-day
 * duration exactly, and `26-12426` is the open twin with no close date to be had.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isTerminalStatus, mapStatus } from './config';
import { staticFormFields } from './html';
import {
  buildStatusRecord,
  csrfTokenOf,
  daysBetween,
  normalizeDate,
  parseInspections,
  splitApplicationNumber,
  terminalInspectionDate,
} from './source-b';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '__fixtures__', name), 'latin1');

const statusClosed = fixture('source-b-status-closed.html');
const statusOpen = fixture('source-b-status-open.html');
const inspectionsClosed = fixture('source-b-inspections-closed.html');
const inspectionsNone = fixture('source-b-inspections-none.html');

const NOW = new Date('2026-09-01T12:00:00Z');

describe('the application-number join', () => {
  it('splits Source A AppNo into the two fields Source B takes', () => {
    expect(splitApplicationNumber('26-12426')).toEqual({ appYear: '26', appNumber: '12426' });
  });

  /** Result lists render it zero-padded to eight digits; the search takes it unpadded. */
  it('strips the zero padding a result list would show', () => {
    expect(splitApplicationNumber('26-00012426')).toEqual({ appYear: '26', appNumber: '12426' });
  });

  it('refuses a malformed application number', () => {
    expect(() => splitApplicationNumber('12426')).toThrow();
  });
});

describe('status detail extraction', () => {
  /**
   * Click2Gov is a Bootstrap grid, not a table: the value lives in a
   * `<p class="form-control-static">` after the `<label>`, so a table-cell pair walk finds
   * nothing at all here.
   */
  it('reads every documented field off the Bootstrap layout', () => {
    expect(staticFormFields(statusClosed)).toMatchObject({
      'Parcel ID': '15-21-30-509-0000-0380',
      Address: '103 GULL CT',
      'Application Date': '07/07/21',
      Owner: 'NEUMANN, WILLIAM J & MARICONDA',
      'Application Number': '21 - 13064',
      'Application Type': 'REROOF RESIDENTIAL',
      Valuation: '$23,022',
      'Square Footage': '000002965',
      'Tenant Name': 'Nancy Mariconda',
      Application: 'PERMIT COMPLETE',
      'General Contractor': 'ROSSER ROOFING SOLUTIONS',
      'Zoning Description': 'PLANNED UNIT DEVELOPMENT',
    });
  });

  it('leaves a genuinely blank field blank rather than borrowing the next value', () => {
    const fields = staticFormFields(statusClosed);
    expect(fields['Tenant Unit Number']).toBe('');
    // The field after it must still be its own value, not shifted up.
    expect(fields['General Contractor']).toBe('ROSSER ROOFING SOLUTIONS');
  });

  /**
   * The sub-views carry the token as a query parameter and return Click2Gov's generic error
   * page without it — which would read as "no inspections" and strip every close date.
   */
  it('lifts the CSRF token the sub-views require out of the detail page', () => {
    expect(csrfTokenOf(statusClosed)).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){7}$/);
    expect(csrfTokenOf('<html>no token here</html>')).toBeNull();
  });
});

describe('inspection parsing', () => {
  it('reads the inspection rows and skips the header', () => {
    expect(parseInspections(inspectionsClosed)).toEqual([
      {
        inspectionType: 'ROOF IN-PROGRESS RESIDENTIAL',
        scheduledDate: '2021-10-21',
        status: 'APPROVED',
        resultDate: '2021-10-21',
        permitDescription: 'REROOF',
      },
      {
        inspectionType: 'FINAL ROOF',
        scheduledDate: '2021-10-25',
        status: 'APPROVED',
        resultDate: '2021-10-25',
        permitDescription: 'REROOF',
      },
    ]);
  });

  /**
   * An open permit's inspections exist but carry no dates at all — the roof inspections are
   * listed because they are required, not because they happened. So "has inspection rows" is
   * not a proxy for "is closed", and only a *resolved* row can date a closure.
   */
  it('reads an open permit’s undated inspection rows', () => {
    expect(parseInspections(inspectionsNone)).toEqual([
      {
        inspectionType: 'ROOF IN-PROGRESS RESIDENTIAL',
        scheduledDate: null,
        status: '',
        resultDate: null,
        permitDescription: '',
      },
      {
        inspectionType: 'FINAL ROOF',
        scheduledDate: null,
        status: '',
        resultDate: null,
        permitDescription: '',
      },
    ]);
  });

  it('takes the latest resolved result date as the close date', () => {
    expect(terminalInspectionDate(parseInspections(inspectionsClosed))).toBe('2021-10-25');
    // Two rows, neither resolved: there is no close date to be had.
    expect(terminalInspectionDate(parseInspections(inspectionsNone))).toBeNull();
  });

  it('ignores an inspection that has been scheduled but not resolved', () => {
    expect(
      terminalInspectionDate([
        {
          inspectionType: 'FINAL ROOF',
          scheduledDate: '2026-09-10',
          status: 'SCHEDULED',
          resultDate: null,
          permitDescription: 'REROOF',
        },
      ]),
    ).toBeNull();
  });
});

describe('open duration', () => {
  /** The documented worked example: opened 07/07/21, FINAL ROOF approved 10/25/2021. */
  it('reproduces the 110-day closed duration from the two sources', () => {
    const { record, unmappedStatus } = buildStatusRecord({
      runId: 'test',
      appNo: '21-13064',
      statusHtml: statusClosed,
      inspectionsHtml: inspectionsClosed,
      statusRawKey: 'raw/status.html',
      inspectionsRawKey: 'raw/inspections.html',
      now: NOW,
    });
    expect(unmappedStatus).toBeNull();
    expect(record).toMatchObject({
      rawStatus: 'PERMIT COMPLETE',
      canonicalStatus: 'complete',
      lifecycle: 'closed',
      terminal: true,
      applicationDate: '2021-07-07',
      closedDate: '2021-10-25',
      closedDateSource: 'terminal_inspection',
      openDurationDays: 110,
      openDurationBasis: 'closed',
      valuationUsd: 23_022,
      squareFootage: 2_965,
    });
  });

  it('measures an open permit against now, with no close date', () => {
    const { record } = buildStatusRecord({
      runId: 'test',
      appNo: '26-12426',
      statusHtml: statusOpen,
      inspectionsHtml: inspectionsNone,
      statusRawKey: 'raw/status.html',
      inspectionsRawKey: 'raw/inspections.html',
      now: NOW,
    });
    expect(record).toMatchObject({
      rawStatus: 'ON HOLD',
      canonicalStatus: 'blocked',
      lifecycle: 'open',
      terminal: false,
      applicationDate: '2026-08-26',
      closedDate: null,
      closedDateSource: 'unavailable',
      openDurationBasis: 'still_open',
      openDurationDays: 6,
    });
  });

  /**
   * The third state, and the reason this is not a boolean. A permit can read terminal and
   * still have no derivable close date — Source B has no close-date field, so if the
   * inspections view was unreachable or carried no result date there is nothing to compute
   * from. Reporting that as either "still open" or "closed today" fabricates the signal.
   */
  it('leaves the duration unknown when a closed permit has no close date', () => {
    const { record } = buildStatusRecord({
      runId: 'test',
      appNo: '21-13064',
      statusHtml: statusClosed,
      inspectionsHtml: null,
      statusRawKey: 'raw/status.html',
      inspectionsRawKey: null,
      now: NOW,
    });
    expect(record.terminal).toBe(true);
    expect(record.closedDate).toBeNull();
    expect(record.closedDateSource).toBe('unavailable');
    expect(record.openDurationDays).toBeNull();
    expect(record.openDurationBasis).toBe('unknown');
  });

  it('counts days inclusively of neither endpoint', () => {
    expect(daysBetween('2021-07-07', '2021-10-25')).toBe(110);
    expect(daysBetween('2026-08-26', '2026-09-01')).toBe(6);
    expect(daysBetween('nonsense', '2026-09-01')).toBeNull();
  });
});

describe('status mapping', () => {
  it('maps every observed status to a canonical lifecycle', () => {
    for (const status of [
      'IN APPROVAL',
      'ON HOLD',
      'PERMIT ISSUED',
      'PERMIT COMPLETE',
      'CERTIFICATE OF COMPLETION',
      'CERTIFICATE OF OCCUPANCY',
      'CLOSED',
      'VOIDED',
    ]) {
      expect(mapStatus(status), status).not.toBeNull();
    }
  });

  it('treats the five immutable states as terminal and the rest as live', () => {
    for (const status of [
      'PERMIT COMPLETE',
      'VOIDED',
      'CLOSED',
      'CERTIFICATE OF COMPLETION',
      'CERTIFICATE OF OCCUPANCY',
    ]) {
      expect(isTerminalStatus(status), status).toBe(true);
    }
    for (const status of ['PERMIT ISSUED', 'ON HOLD', 'IN APPROVAL']) {
      expect(isTerminalStatus(status), status).toBe(false);
    }
  });

  /**
   * Seven values were observed and the full enumeration is undocumented, so an unknown status
   * is quarantined and alerted. Critically it is not terminal: guessing terminal would freeze
   * the permit and it would never be refreshed again.
   */
  it('quarantines an unknown status instead of bucketing it', () => {
    const mangled = statusOpen.replace('>ON HOLD<', '>AWAITING SOMETHING NEW<');
    const { record, unmappedStatus } = buildStatusRecord({
      runId: 'test',
      appNo: '26-12426',
      statusHtml: mangled,
      inspectionsHtml: null,
      statusRawKey: 'raw/status.html',
      inspectionsRawKey: null,
      now: NOW,
    });
    expect(unmappedStatus).toBe('AWAITING SOMETHING NEW');
    expect(record.canonicalStatus).toBe('unknown');
    expect(record.lifecycle).toBe('unknown');
    expect(record.terminal).toBe(false);
    expect(mapStatus('AWAITING SOMETHING NEW')).toBeNull();
  });

  it('normalises whitespace and case before matching', () => {
    expect(mapStatus('  permit   complete ')?.canonical).toBe('complete');
  });
});

describe('date normalisation', () => {
  it('handles both the two- and four-digit year forms Click2Gov mixes', () => {
    expect(normalizeDate('10/25/2021')).toBe('2021-10-25');
    expect(normalizeDate('08/26/26')).toBe('2026-08-26');
    expect(normalizeDate('')).toBeNull();
    expect(normalizeDate('  ')).toBeNull();
  });
});

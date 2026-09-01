import { describe, expect, it } from 'vitest';
import {
  buildYearsByParcel,
  cardFromPermits,
  isConfirmedOpen,
  isOpenRoofingRow,
  parseOpenRoofingRecord,
} from './permit-lookup';

describe('open-roofing classification', () => {
  it('treats only status=open as open', () => {
    expect(isConfirmedOpen('open')).toBe(true);
    expect(isConfirmedOpen('unknown')).toBe(false);
    expect(isConfirmedOpen('closed')).toBe(false);
    expect(isConfirmedOpen('void')).toBe(false);
  });

  it('requires both confirmed-open and the publisher roofing flag', () => {
    expect(isOpenRoofingRow('open', true)).toBe(true);
    expect(isOpenRoofingRow('unknown', true)).toBe(false);
    expect(isOpenRoofingRow('open', false)).toBe(false);
  });

  it('drops unknown-status roofing rows from the retained set', () => {
    expect(
      parseOpenRoofingRecord({
        parcel_id: 'ABC',
        status: 'unknown',
        roofing_relevant: true,
        contractor_name: 'ALLMAN ROOFING INC',
      }),
    ).toBeNull();
  });
});

describe('cards and years', () => {
  it('picks the longest-open permit for the list card', () => {
    const card = cardFromPermits([
      {
        parcelId: 'P1',
        applicationNo: '1',
        permitType: 'RR',
        description: null,
        issuedOn: '2000-01-01',
        contractorName: 'SHORT',
        openYears: 2,
        observedAt: null,
        bbbLookup: 'not_searched',
        bbbRating: null,
        bbbScore: null,
      },
      {
        parcelId: 'P1',
        applicationNo: '2',
        permitType: 'BPRF',
        description: null,
        issuedOn: '1999-01-01',
        contractorName: 'OWNER BUILDER',
        openYears: 26.5,
        observedAt: null,
        bbbLookup: 'rated',
        bbbRating: 'A+',
        bbbScore: 100,
      },
    ]);
    expect(card?.contractorName).toBe('OWNER BUILDER');
    expect(card?.bbbRating).toBe('A+');
    expect(card?.maxOpenYears).toBe(26.5);
  });

  it('indexes only parcels that have a confirmed-open roofing count', () => {
    const years = buildYearsByParcel(
      new Map([
        [
          'HAS',
          {
            permitCount: 3,
            applicationCount: 2,
            openPermitCount: 1,
            openRoofingCount: 1,
            unknownStatusCount: 2,
            maxOpenYears: 10,
            maxOpenRoofingYears: 8.4,
          },
        ],
        [
          'NONE',
          {
            permitCount: 4,
            applicationCount: 3,
            openPermitCount: 0,
            openRoofingCount: 0,
            unknownStatusCount: 4,
            maxOpenYears: null,
            maxOpenRoofingYears: null,
          },
        ],
      ]),
    );
    expect(years.get('HAS')).toBe(8.4);
    expect(years.has('NONE')).toBe(false);
  });
});

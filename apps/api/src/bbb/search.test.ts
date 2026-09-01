import { describe, expect, it } from 'vitest';
import { dedupeBusinesses, searchUrl } from './search';
import type { BbbBusinessRecord } from './model';
import { businessesKey, contractorRatingsKey, ledgerKey, searchPageRawKey } from './storage';

function record(id: string, name: string): BbbBusinessRecord {
  return {
    bbbRecordId: id,
    businessId: id.split('_')[1] ?? id,
    businessName: name,
    alsoKnownAs: [],
    rating: 'A+',
    ratingScore: 100,
    accredited: true,
    streetAddress: null,
    city: 'Sanford',
    state: 'FL',
    postalCode: null,
    payloadCity: null,
    phones: [],
    primaryCategory: 'Roofing Contractors',
    categoryIds: ['10126-000'],
    roofing: true,
    serviceAreas: [],
    outOfBusiness: false,
    profileUrl: null,
    sourceUrl: 'https://www.bbb.org/search?find_text=x',
    fetchedAt: '2026-09-01T12:00:00.000Z',
    rawKey: null,
    searchKind: 'city_seed',
    searchTerm: 'Roofing Contractors',
    searchLocation: 'Sanford, FL',
  };
}

describe('searchUrl', () => {
  it('encodes the location and term', () => {
    expect(searchUrl({ term: 'Roofing Contractors', location: 'Lake Mary, FL', page: 2 })).toBe(
      'https://www.bbb.org/search?find_country=USA&find_loc=Lake+Mary%2C+FL&find_text=Roofing+Contractors&page=2',
    );
  });
});

describe('dedupeBusinesses', () => {
  it('collapses repeat sightings of the same business', () => {
    const deduped = dedupeBusinesses([
      record('0733_1_2', 'Collis Roofing, Inc.'),
      record('0733_1_2', 'Collis Roofing, Inc.'),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.alsoKnownAs).toEqual([]);
  });

  it('keeps both names when one id answers to two of them', () => {
    // BBB returns whichever name matched the search: legal name from a category sweep,
    // trade name from a name lookup.
    const deduped = dedupeBusinesses([
      record('0733_90718872_109970', '3MG Solutions LLC'),
      record('0733_90718872_109970', '3MG Roofing & Solar'),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.businessName).toBe('3MG Solutions LLC');
    expect(deduped[0]?.alsoKnownAs).toEqual(['3MG Roofing & Solar']);
  });

  it('does not mutate the input records', () => {
    const first = record('0733_1_2', 'A');
    dedupeBusinesses([first, record('0733_1_2', 'B')]);
    expect(first.alsoKnownAs).toEqual([]);
  });

  it('keeps genuinely different businesses apart', () => {
    expect(dedupeBusinesses([record('a_1_1', 'A Roofing'), record('b_2_2', 'B Roofing')])).toHaveLength(2);
  });
});

describe('storage keys', () => {
  it('nests raw HTML under raw/bbb/ as a sibling of raw/expanded/', () => {
    const key = searchPageRawKey({
      runId: 'run-1',
      location: 'Lake Mary, FL',
      term: 'Roofing Contractors',
      page: 3,
    });
    expect(key).toMatch(/^raw\/bbb\/search\/loc=lake-mary-fl\/term=roofing-contractors-[0-9a-f]{10}\/run=run-1\/page-0003\.html$/);
  });

  it('derives every output key from the run id, so a re-run overwrites itself', () => {
    expect(businessesKey('run-1')).toBe('staged/bbb/businesses/run=run-1/businesses.ndjson');
    expect(contractorRatingsKey('run-1')).toBe(
      'staged/bbb/contractor-ratings/run=run-1/matches.ndjson',
    );
  });

  it('keys the ledger on the search url and not on the run', () => {
    const url = 'https://www.bbb.org/search?find_text=a';
    expect(ledgerKey(url)).toMatch(/^manifests\/bbb\/ledger\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/);
    expect(ledgerKey(url)).toBe(ledgerKey(url));
    expect(ledgerKey(url)).not.toBe(ledgerKey(`${url}b`));
  });
});

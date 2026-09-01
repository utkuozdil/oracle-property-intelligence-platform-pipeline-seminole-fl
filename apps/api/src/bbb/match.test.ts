/**
 * Normalizer and matcher tests.
 *
 * Every permit contractor name below is a real value from the permit portal's contractor
 * column, and every BBB name is a real business name harvested on 2026-09-01. The negative
 * cases matter more than the positive ones: three of them are matches an earlier version of
 * this matcher claimed and got wrong.
 */
import { describe, expect, it } from 'vitest';
import { MATCH_CONFIDENCE_FLOOR } from './config';
import { matchContractor, matchContractors, searchTermFor } from './match';
import type { BbbBusinessRecord } from './model';
import {
  nameSurvivedTruncation,
  normalizeBusinessName,
  similarity,
  stripLicenceQualifiers,
} from './normalize';
import { indexBusinesses } from './match';

function business(name: string, overrides: Partial<BbbBusinessRecord> = {}): BbbBusinessRecord {
  return {
    bbbRecordId: `id-${name}`,
    businessId: `b-${name}`,
    businessName: name,
    alsoKnownAs: [],
    rating: 'A+',
    ratingScore: 100,
    accredited: true,
    streetAddress: '1 Main St',
    city: 'Sanford',
    state: 'FL',
    postalCode: '32773',
    payloadCity: 'Sanford',
    phones: ['(407) 000-0000'],
    primaryCategory: 'Roofing Contractors',
    categoryIds: ['10126-000'],
    roofing: true,
    serviceAreas: [],
    outOfBusiness: false,
    profileUrl: 'https://www.bbb.org/us/fl/sanford/profile/roofing-contractors/x',
    sourceUrl: 'https://www.bbb.org/search?find_text=x',
    fetchedAt: '2026-09-01T12:00:00.000Z',
    rawKey: null,
    searchKind: 'city_seed',
    searchTerm: 'Roofing Contractors',
    searchLocation: 'Sanford, FL',
    ...overrides,
  };
}

describe('stripLicenceQualifiers', () => {
  it('removes a balanced licence qualifier', () => {
    expect(stripLicenceQualifiers('3MG ROOFING (CCC-ANGIULLI)')).toBe('3MG ROOFING');
  });

  it('removes a qualifier left unclosed by the 30-character column', () => {
    expect(stripLicenceQualifiers('COLLIS ROOFING INC (LANIER-CCC')).toBe('COLLIS ROOFING INC');
  });

  it('closes a word back up when the qualifier was spliced into the middle of it', () => {
    // `...CONST(CCC)RU` is `CONSTRU` interrupted, not `CONST` and `RU`.
    expect(stripLicenceQualifiers('SOLAR ROOFING AND CONST(CCC)RU')).toBe(
      'SOLAR ROOFING AND CONSTRU',
    );
  });
});

describe('nameSurvivedTruncation', () => {
  it('treats a short name as complete', () => {
    expect(nameSurvivedTruncation('RAPTIS ROOFING LLC')).toBe(true);
  });

  it.each([
    ['NATIONS ROOF RESIDENTIAL LLC(B', 'cut inside an unclosed qualifier'],
    ['COLLIS ROOFING INC (LANIER-CCC', 'cut inside an unclosed qualifier'],
    ['JTO CONTRACTING INC (HOOD CCC)', 'qualifier closed before the cut'],
    ['FLEMING BROTHERS ROOF(RC MICHA', 'cut inside an unclosed qualifier'],
  ])('treats %s as a complete business name (%s)', (name) => {
    expect(nameSurvivedTruncation(name)).toBe(true);
  });

  it.each([
    ['SOLAR ROOFING AND CONST(CCC)RU'],
    ['LM ROOFING AND CONSTRUCTION CO'],
    ['ATLANTIC ROOFING & (CCC) CONST'],
    ['CENTRAL FLORIDA EQUITY (CCC) B'],
  ])('treats %s as a cut business name', (name) => {
    expect(nameSurvivedTruncation(name)).toBe(false);
  });
});

describe('normalizeBusinessName', () => {
  it('makes a permit rendering and a BBB rendering agree', () => {
    expect(normalizeBusinessName("MCFADDEN'S ROOFING INC").key).toBe(
      normalizeBusinessName("McFadden's Roofing, Inc.").key,
    );
  });

  it('strips only trailing entity suffixes', () => {
    expect(normalizeBusinessName('TIP TOP ROOFING CO INC (GOLDMA').key).toBe('TIP TOP ROOFING');
    // `CO` inside a name is not a suffix.
    expect(normalizeBusinessName('CO OPERATIVE ROOFING').key).toBe('CO OPERATIVE ROOFING');
  });

  it('never strips a name down to nothing', () => {
    expect(normalizeBusinessName('LLC').key).toBe('LLC');
  });

  it('does not expand ROOF into ROOFING', () => {
    // `Nations Roof Residential` is a real name and is not `Nations Roofing Residential`.
    expect(normalizeBusinessName('NATIONS ROOF RESIDENTIAL LLC(B').key).toBe(
      'NATIONS ROOF RESIDENTIAL',
    );
  });

  it('expands abbreviations that are not words', () => {
    expect(normalizeBusinessName('KC CONST & MAINT INC (CCC)').key).toBe(
      'KC CONSTRUCTION AND MAINTENANCE',
    );
  });

  it('drops a leading THE', () => {
    expect(normalizeBusinessName('THE ROOFING EXPERTS(CCC)').key).toBe('ROOFING EXPERTS');
  });
});

describe('searchTermFor', () => {
  it('drops the licence qualifier', () => {
    expect(searchTermFor('FRAZIER CONTRACTING (CCC) LLC')).toBe('FRAZIER CONTRACTING');
  });

  it('drops a truncated trailing fragment and any conjunction left dangling', () => {
    expect(searchTermFor('ATLANTIC ROOFING & (CCC) CONST')).toBe('ATLANTIC ROOFING');
  });

  it('keeps every token of a name that was never cut', () => {
    expect(searchTermFor('NATIONS ROOF RESIDENTIAL LLC(B')).toBe('NATIONS ROOF RESIDENTIAL');
  });
});

describe('similarity', () => {
  it('scores an identical normalized name as exact', () => {
    const permit = normalizeBusinessName('RAPTIS ROOFING LLC');
    const candidate = normalizeBusinessName('Raptis Roofing LLC', { truncatedInput: false });
    expect(similarity(permit, candidate).score).toBe(1);
  });

  it('treats a candidate that continues a cut name as near-exact', () => {
    const permit = normalizeBusinessName('ATLANTIC ROOFING & (CCC) CONST');
    const candidate = normalizeBusinessName('Atlantic Roofing & Construction Company, Inc.', {
      truncatedInput: false,
    });
    const outcome = similarity(permit, candidate);
    expect(outcome.prefixContinuation).toBe(true);
    expect(outcome.score).toBeGreaterThan(0.9);
  });

  it('rewards containment when the extra tokens are the candidate\u2019s', () => {
    const permit = normalizeBusinessName('3MG ROOFING (CCC-ANGIULLI)');
    const candidate = normalizeBusinessName('3MG Roofing & Solar', { truncatedInput: false });
    expect(similarity(permit, candidate).score).toBeGreaterThan(0.82);
  });

  it.each([
    ['BLITZ ROOFING & CONSTRUCTION', 'HC Roofing & Construction'],
    ['GREENTEK ROOFING & SOLAR', 'JTO Roofing and Solar'],
    ['BARBER & ASSOCIATES INC', 'Crespo & Associates'],
    ['SOLAR ROOFING AND CONST(CCC)RU', 'SunCoast Roofing And Solar'],
  ])('keeps %s below the floor against %s', (permitName, candidateName) => {
    // Overlap made only of industry vocabulary. Every one of these was a wrong match an
    // earlier version claimed with confidence 0.67-0.79.
    const permit = normalizeBusinessName(permitName);
    const candidate = normalizeBusinessName(candidateName, { truncatedInput: false });
    expect(similarity(permit, candidate).score).toBeLessThan(MATCH_CONFIDENCE_FLOOR);
  });

  it('still matches when the shared tokens actually name the business', () => {
    const permit = normalizeBusinessName('FLEMING BROTHERS ROOF(RC MICHA');
    const candidate = normalizeBusinessName('Fleming Brothers Roofing', { truncatedInput: false });
    expect(similarity(permit, candidate).score).toBeGreaterThan(MATCH_CONFIDENCE_FLOOR);
  });
});

describe('matchContractor', () => {
  it('matches on an alias when the primary name would not', () => {
    const record = business('3MG Solutions LLC', { alsoKnownAs: ['3MG Roofing & Solar'] });
    const match = matchContractor({ name: '3MG ROOFING (CCC-ANGIULLI)' }, indexBusinesses([record]));
    expect(match.matched).toBe(true);
    expect(match.bbbBusinessName).toBe('3MG Solutions LLC');
    // Why the match was claimed is recorded, not just that it was.
    expect(match.bbbMatchedName).toBe('3MG Roofing & Solar');
  });

  it('reports the best score it reached when nothing clears the floor', () => {
    const match = matchContractor(
      { name: 'GRASCO INC (CCC)' },
      indexBusinesses([business('Global Landscaping & Tree Service LLC')]),
    );
    expect(match.matched).toBe(false);
    expect(match.matchTier).toBeNull();
    expect(match.rating).toBeNull();
    expect(match.confidence).toBeLessThan(MATCH_CONFIDENCE_FLOOR);
    expect(match.confidence).toBeGreaterThan(0);
  });

  it('counts competing candidates so ambiguity is visible', () => {
    const match = matchContractor(
      { name: 'BEST CHOICE ROOFING' },
      indexBusinesses([
        business('Best Choice Roofing'),
        business('Best Choice Roofing, LLC'),
        business('Unrelated Plumbing'),
      ]),
    );
    expect(match.matched).toBe(true);
    expect(match.runnerUpCount).toBe(1);
  });

  it('carries the permit count through', () => {
    const match = matchContractor(
      { name: 'RAPTIS ROOFING LLC', permitCount: 2 },
      indexBusinesses([business('Raptis Roofing LLC')]),
    );
    expect(match.permitCount).toBe(2);
  });

  it('emits a row for every contractor, matched or not', () => {
    const matches = matchContractors(
      [{ name: 'RAPTIS ROOFING LLC' }, { name: 'ABARCA INC' }],
      [business('Raptis Roofing LLC')],
    );
    expect(matches).toHaveLength(2);
    expect(matches.filter((match) => match.matched)).toHaveLength(1);
  });
});

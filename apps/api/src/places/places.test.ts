import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  APPROVED_SOURCE_DATASETS,
  CONFIDENCE_BAND_EDGES,
  COUNTY_BBOX,
  COUNTY_FIPS,
  FORBIDDEN_SOURCE_DATASETS,
  OVERTURE_RELEASE,
  RECOMMENDED_CONFIDENCE_FLOOR,
  ROOFING_TAXONOMY_LEAF,
  ROOFING_TAXONOMY_PATH,
  SEMINOLE_MUNICIPALITIES,
  UNINCORPORATED,
  overturePlacesGlob,
} from './config';
import { fingerprint } from './boundary';
import { query } from './duckdb';
import { evaluateSourceGate } from './extract';
import { GEOHASH_MACROS } from './sql';
import { DEFENSIBLE_TIERS, joinRoofingBusinesses } from './roofing-join';
import { assertSummary, PlacesIngestRequest, type PlacesRunSummary } from './model';
import { collectArtifacts, contentTypeFor, type PeerReader } from './objects';
import { loadBbb, loadPermitContractors } from './peers';
import {
  currentPointerKey,
  publishedPlacesTableKey,
  roofingMatchesKey,
  summaryKey,
} from './storage';

/**
 * The published parcel snapshot, when a local publish run has produced one.
 *
 * The geohash test below is the only meaningful check on a hand-written geohash encoder, and
 * it needs real ground truth. Rather than paste a dozen expected values, it reproduces the
 * `geohash5` column of every parcel in the snapshot — 181,218 rows written by an entirely
 * separate implementation in the Python tier. It skips when that snapshot is absent, because
 * a missing peer artifact is not this tier's failure.
 */
const SNAPSHOT_GLOB = '.publish-work/snapshot/**/*.parquet';
const snapshotAvailable = existsSync('.publish-work/snapshot');

describe('release and boundary pinning', () => {
  it('pins a release that matches Overture id format', () => {
    expect(OVERTURE_RELEASE).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it('builds a public S3 glob for the places theme', () => {
    expect(overturePlacesGlob(OVERTURE_RELEASE)).toBe(
      `s3://overturemaps-us-west-2/release/${OVERTURE_RELEASE}/theme=places/type=place/*.parquet`,
    );
  });

  it('uses the Florida Seminole FIPS, not the Oklahoma one', () => {
    expect(COUNTY_FIPS).toBe('12117');
    expect(COUNTY_FIPS.slice(0, 2)).toBe('12');
  });

  it('keeps the pruning bbox inside central Florida', () => {
    expect(COUNTY_BBOX.xmin).toBeLessThan(COUNTY_BBOX.xmax);
    expect(COUNTY_BBOX.ymin).toBeLessThan(COUNTY_BBOX.ymax);
    expect(COUNTY_BBOX.xmin).toBeGreaterThan(-82);
    expect(COUNTY_BBOX.ymax).toBeLessThan(29);
  });

  it('fingerprints boundary bytes stably and sensitively', () => {
    expect(fingerprint('a')).toHaveLength(64);
    expect(fingerprint('a')).toBe(fingerprint('a'));
    expect(fingerprint('a')).not.toBe(fingerprint('b'));
  });
});

describe('jurisdiction vocabulary', () => {
  it('matches the eight values the parcel snapshot uses', () => {
    expect(SEMINOLE_MUNICIPALITIES).toHaveLength(7);
    expect(UNINCORPORATED).toBe('Unincorporated Seminole County');
  });

  it.skipIf(!snapshotAvailable)('uses no jurisdiction the parcel snapshot does not', () => {
    const rows = query<{ jurisdiction: string }>(
      `SELECT DISTINCT jurisdiction FROM read_parquet('${SNAPSHOT_GLOB}', hive_partitioning = true)
       WHERE jurisdiction IS NOT NULL;`,
    );
    const parcelJurisdictions = new Set(rows.map((row) => row.jurisdiction));
    for (const municipality of SEMINOLE_MUNICIPALITIES) {
      expect(parcelJurisdictions.has(municipality)).toBe(true);
    }
    expect(parcelJurisdictions.has(UNINCORPORATED)).toBe(true);
  });
});

describe('geohash5 encoder', () => {
  it('agrees with a known geohash for a Sanford coordinate', () => {
    const [row] = query<{ gh: string }>(
      `${GEOHASH_MACROS} SELECT geohash5(-81.2731, 28.8003) AS gh;`,
    );
    // 5 characters, base-32 alphabet, and the central-Florida prefix.
    expect(row?.gh).toMatch(/^[0-9bcdefghjkmnpqrstuvwxyz]{5}$/);
    expect(row?.gh?.slice(0, 3)).toBe('djn');
  });

  /**
   * The load-bearing test for this tier.
   *
   * A wrong geohash does not fail — it silently shards businesses away from the parcels they
   * sit beside, and every radius query that spans both datasets quietly reads the wrong
   * files. Reproducing an independent implementation's output over the whole county is the
   * only check that catches a subtly wrong bit order.
   */
  it.skipIf(!snapshotAvailable)('reproduces every geohash5 in the parcel snapshot', () => {
    const [row] = query<{ parcels: number; disagree: number }>(
      `${GEOHASH_MACROS}
       SELECT count(*) AS parcels,
              count(*) FILTER (WHERE geohash5(longitude, latitude) <> geohash5) AS disagree
       FROM read_parquet('${SNAPSHOT_GLOB}', hive_partitioning = true)
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL;`,
    );
    expect(Number(row?.parcels)).toBeGreaterThan(100_000);
    expect(Number(row?.disagree)).toBe(0);
  });
});

describe('licence gate', () => {
  const row = (dataset: string, places = 1) => ({
    dataset,
    dataset_key: dataset.toLowerCase(),
    license: 'CDLA-Permissive-2.0',
    places,
  });

  it('passes the ten providers observed in Seminole', () => {
    const result = evaluateSourceGate([
      row('Overture'),
      row('Overture-signals'),
      row('meta'),
      row('Microsoft'),
      row('BrightQuery'),
      row('Foursquare'),
      row('AllThePlaces'),
      row('DAC'),
      row('PinMeTo'),
      row('RenderSEO'),
    ]);
    expect(result.passed).toBe(true);
    expect(result.unknown).toEqual([]);
    expect(result.forbidden).toEqual([]);
  });

  it('preserves the provider spelling it was given', () => {
    const result = evaluateSourceGate([row('AllThePlaces')]);
    expect(result.datasets[0]?.dataset).toBe('AllThePlaces');
  });

  it('stops on osm in any casing', () => {
    for (const spelling of ['osm', 'OSM', 'Osm']) {
      const result = evaluateSourceGate([row('meta'), row(spelling)]);
      expect(result.passed).toBe(false);
      expect(result.forbidden).toEqual(['osm']);
    }
  });

  it('stops on a provider nobody approved', () => {
    const result = evaluateSourceGate([row('meta'), row('SomeNewVendor')]);
    expect(result.passed).toBe(false);
    expect(result.unknown).toEqual(['somenewvendor']);
  });

  it('never lists a forbidden provider as merely unknown', () => {
    expect(APPROVED_SOURCE_DATASETS.has('osm')).toBe(false);
    expect(FORBIDDEN_SOURCE_DATASETS.has('osm')).toBe(true);
  });
});

describe('confidence policy', () => {
  it('publishes a floor without applying it', () => {
    expect(RECOMMENDED_CONFIDENCE_FLOOR).toBe(0.6);
    expect(CONFIDENCE_BAND_EDGES).toContain(RECOMMENDED_CONFIDENCE_FLOOR);
  });

  it('keeps band edges sorted, so a band is unambiguous', () => {
    const edges = [...CONFIDENCE_BAND_EDGES];
    expect(edges).toEqual([...edges].sort((a, b) => a - b));
  });
});

describe('taxonomy keys', () => {
  it('keys roofing on the full hierarchy path, not the deprecated leaf', () => {
    expect(ROOFING_TAXONOMY_PATH.split('/')).toHaveLength(4);
    expect(ROOFING_TAXONOMY_PATH.endsWith(`/${ROOFING_TAXONOMY_LEAF}`)).toBe(true);
  });
});

describe('ingest request contract', () => {
  it('accepts an empty request, which is what a schedule sends', () => {
    expect(PlacesIngestRequest.parse({})).toEqual({});
  });

  it('rejects a release that is not an Overture id', () => {
    expect(() => PlacesIngestRequest.parse({ release: 'latest' })).toThrow();
    expect(() => PlacesIngestRequest.parse({ release: '2026-08-19' })).toThrow();
    expect(PlacesIngestRequest.parse({ release: '2026-08-19.0' }).release).toBe('2026-08-19.0');
  });

  it('rejects an unknown field rather than ignoring it', () => {
    expect(() => PlacesIngestRequest.parse({ confidenceFloor: 0.9 })).toThrow();
  });
});

describe('summary assertions', () => {
  const base: PlacesRunSummary = {
    runId: 'places-test',
    county: 'Seminole',
    countyFips: '12117',
    release: OVERTURE_RELEASE,
    startedAt: '2026-09-01T00:00:00.000Z',
    finishedAt: '2026-09-01T00:01:00.000Z',
    elapsedSeconds: 60,
    boundary: {
      source: 'census-tigerweb',
      layerUrl: 'https://tigerweb.geo.census.gov/x',
      vintage: '2025-01-01',
      geoid: '12117',
      name: 'Seminole County',
      fetchedAt: '2026-09-01T00:00:00.000Z',
      fingerprint: 'a'.repeat(64),
      vertices: 2647,
      bbox: COUNTY_BBOX,
    },
    bboxPrunedCount: 31_168,
    clippedCount: 26_446,
    bboxOnlyCount: 4_722,
    distinctGersIds: 26_446,
    nullGeometryCount: 0,
    jurisdictionCounts: {},
    confidenceBands: [],
    confidence: { min: 0.02, median: 0.92, mean: 0.81, max: 1 },
    recommendedConfidenceFloor: 0.6,
    rowsBelowRecommendedFloor: 4_550,
    roofingCount: 162,
    roofingDistinctNames: 150,
    operatingStatusCounts: {},
    localityDisagreementCount: 1_602,
    sourceGate: { datasets: [], unknown: [], forbidden: [], passed: true },
    contentFingerprint: 'f'.repeat(32),
    delta: null,
    releaseDrift: { pinned: OVERTURE_RELEASE, latest: OVERTURE_RELEASE, drifted: false },
    artifacts: [],
    warnings: [],
  };

  it('accepts a clean run', () => {
    expect(() => assertSummary(base)).not.toThrow();
  });

  it('refuses to publish duplicate GERS ids', () => {
    expect(() => assertSummary({ ...base, distinctGersIds: 26_400 })).toThrow(/duplicate GERS/);
  });

  it('refuses to publish null geometry', () => {
    expect(() => assertSummary({ ...base, nullGeometryCount: 1 })).toThrow(/null geometry/);
  });

  it('refuses to publish when the licence gate failed', () => {
    expect(() =>
      assertSummary({
        ...base,
        sourceGate: { datasets: [], unknown: [], forbidden: ['osm'], passed: false },
      }),
    ).toThrow(/source gate failed/);
  });
});

describe('roofing join', () => {
  const place = (gersId: string, name: string) => ({
    gers_id: gersId,
    name,
    jurisdiction: 'Longwood',
    confidence: 0.92,
    address_freeform: '1 Main St',
    websites: [],
    phones: [],
  });

  it('matches an identical name as exact', () => {
    const { matches, summary } = joinRoofingBusinesses({
      release: OVERTURE_RELEASE,
      roofingRows: [place('a', 'Raptis Roofing')],
      permitContractors: [{ name: 'RAPTIS ROOFING LLC', permitCount: 2 }],
      permitContractorSource: 'test',
      bbbBusinessSource: 'test',
    });
    expect(matches[0]?.permitMatched).toBe(true);
    expect(matches[0]?.permitMatchTier).toBe('exact');
    expect(matches[0]?.permitCount).toBe(2);
    expect(summary.placesMatchedDefensibly).toBe(1);
  });

  it('does not claim a match for an unrelated roofer', () => {
    const { matches, summary } = joinRoofingBusinesses({
      release: OVERTURE_RELEASE,
      roofingRows: [place('a', 'Advanced Roofing Inc.')],
      permitContractors: [{ name: 'KANGAROO ROOFING LLC' }],
      permitContractorSource: 'test',
      bbbBusinessSource: 'test',
    });
    expect(matches[0]?.permitMatched).toBe(false);
    expect(summary.permitMatchRate).toBe(0);
    expect(summary.permitContractorsUnmatched).toBe(1);
  });

  it('excludes the weak tier from the defensible rate', () => {
    const { summary } = joinRoofingBusinesses({
      release: OVERTURE_RELEASE,
      roofingRows: [place('a', 'Top Notch Roofing')],
      permitContractors: [{ name: 'TIP TOP ROOFING CO INC (GOLDMA' }],
      permitContractorSource: 'test',
      bbbBusinessSource: 'test',
    });
    // Whether this clears the floor at all is the matcher's business; what matters here is
    // that a weak match never reaches the defensible count.
    expect(summary.placesMatchedDefensibly).toBe(0);
    expect(summary.defensibleMatchRate).toBe(0);
    expect(DEFENSIBLE_TIERS).not.toContain('weak');
  });

  it('reports a measured zero rather than a guess when BBB output is absent', () => {
    const { matches, summary } = joinRoofingBusinesses({
      release: OVERTURE_RELEASE,
      roofingRows: [place('a', 'Raptis Roofing')],
      permitContractors: [{ name: 'RAPTIS ROOFING LLC' }],
      permitContractorSource: 'test',
      bbbBusinessSource: 'none available',
    });
    expect(summary.bbbBusinessesConsidered).toBe(0);
    expect(summary.bbbMatchRate).toBe(0);
    expect(matches[0]?.bbbMatched).toBe(false);
    expect(matches[0]?.bbbPath).toBeNull();
    expect(matches[0]?.bbbRating).toBeNull();
    expect(summary.denominators.bbbBusinessSource).toBe('none available');
  });

  /**
   * A rating reached through two fuzzy hops cannot be presented with the confidence of one.
   * The product is what the chain is worth, and it has to be strictly lower than either hop.
   */
  it('compounds confidence when BBB is reached through a permit contractor', () => {
    const { matches } = joinRoofingBusinesses({
      release: OVERTURE_RELEASE,
      roofingRows: [place('a', 'Raptis Roofing')],
      permitContractors: [{ name: 'RAPTIS ROOFING LLC' }],
      contractorRatings: [
        {
          permitContractorName: 'RAPTIS ROOFING LLC',
          permitContractorKey: 'RAPTIS ROOFING',
          permitNameTruncated: false,
          permitCount: 2,
          matched: true,
          matchTier: 'strong',
          confidence: 0.9,
          runnerUpCount: 0,
          bbbRecordId: 'bbb-1',
          bbbBusinessName: 'Raptis Roofing LLC',
          bbbMatchedName: 'Raptis Roofing LLC',
          rating: 'A+',
          ratingScore: 4.8,
          accredited: true,
          city: 'Longwood',
          state: 'FL',
          phones: [],
          profileUrl: 'https://www.bbb.org/x',
          sourceUrl: 'https://www.bbb.org/search?x',
          fetchedAt: '2026-09-01T00:00:00.000Z',
        },
      ],
      permitContractorSource: 'test',
      bbbBusinessSource: 'test',
    });

    const match = matches[0];
    expect(match?.bbbPath).toBe('via_permit_contractor');
    expect(match?.bbbRating).toBe('A+');
    expect(match?.bbbMatchConfidence).toBeCloseTo(0.9, 5);
    expect(match?.bbbMatchConfidence).toBeLessThan(match?.permitMatchConfidence ?? 0);
  });

  it('reports both match directions, because they answer different questions', () => {
    const { summary } = joinRoofingBusinesses({
      release: OVERTURE_RELEASE,
      roofingRows: [place('a', 'Raptis Roofing'), place('b', 'Raptis Roofing')],
      permitContractors: [{ name: 'RAPTIS ROOFING LLC' }, { name: 'KANGAROO ROOFING LLC' }],
      permitContractorSource: 'test',
      bbbBusinessSource: 'test',
    });
    // Two places matched, but only one of the two contractor names was reached.
    expect(summary.placesMatchedToPermits).toBe(2);
    expect(summary.permitMatchRate).toBe(1);
    expect(summary.permitContractorsMatched).toBe(1);
    expect(summary.permitContractorMatchRate).toBe(0.5);
  });

  it('handles an empty roofing set without dividing by zero', () => {
    const { summary } = joinRoofingBusinesses({
      release: OVERTURE_RELEASE,
      roofingRows: [],
      permitContractors: [{ name: 'RAPTIS ROOFING LLC' }],
      permitContractorSource: 'test',
      bbbBusinessSource: 'test',
    });
    expect(summary.permitMatchRate).toBe(0);
    expect(summary.bbbMatchRate).toBe(0);
    expect(summary.defensibleMatchRate).toBe(0);
  });
});

describe('artifact publication', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'places-objects-'));

  beforeAll(() => {
    for (const key of [
      publishedPlacesTableKey(OVERTURE_RELEASE),
      roofingMatchesKey(OVERTURE_RELEASE),
      currentPointerKey(),
      summaryKey('places-test'),
    ]) {
      const path = join(outputDir, ...key.split('/'));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, key);
    }
    // The DuckDB database sits beside the four owned prefixes and must not be collected.
    writeFileSync(join(outputDir, 'places-test.duckdb'), 'scratch');
  });

  it('collects the artifacts and leaves the scratch database behind', async () => {
    const keys = await collectArtifacts(outputDir);
    expect(keys).toContain(publishedPlacesTableKey(OVERTURE_RELEASE));
    expect(keys).toContain(roofingMatchesKey(OVERTURE_RELEASE));
    expect(keys.some((key) => key.endsWith('.duckdb'))).toBe(false);
  });

  it('writes the pointer last, after everything it names', async () => {
    const keys = await collectArtifacts(outputDir);
    expect(keys.at(-1)).toBe(currentPointerKey());
    // Alphabetically the pointer would land ahead of the staged matches it names.
    expect(currentPointerKey() < roofingMatchesKey(OVERTURE_RELEASE)).toBe(true);
  });

  it('labels Parquet and NDJSON so a gateway can serve them', () => {
    expect(contentTypeFor(publishedPlacesTableKey(OVERTURE_RELEASE))).toBe(
      'application/vnd.apache.parquet',
    );
    expect(contentTypeFor(roofingMatchesKey(OVERTURE_RELEASE))).toBe('application/x-ndjson');
    expect(contentTypeFor(currentPointerKey())).toBe('application/json');
    expect(contentTypeFor('staged/places/nothing')).toBe('application/octet-stream');
  });
});

describe('peer reading', () => {
  /** Stands in for either sink; the loaders only ever see this interface. */
  function readerOf(objects: Record<string, string>): PeerReader {
    return {
      description: 'test',
      listNdjson: async (prefix) =>
        Object.keys(objects)
          .filter((key) => key.startsWith(prefix) && key.endsWith('.ndjson'))
          .sort(),
      readText: async (key) => objects[key] ?? '',
    };
  }

  it('reads the permit census across shards and counts each contractor', async () => {
    const row = (contractorName: string) =>
      JSON.stringify({ contractorName, roofingRelevant: true });
    const { contractors, source } = await loadPermitContractors(
      readerOf({
        'staged/permits/census/month=2026-01/type=ALL/rows.ndjson': [
          row('COLLIS ROOFING INC'),
          row('COLLIS ROOFING INC'),
          JSON.stringify({ contractorName: 'A POOL CO', roofingRelevant: false }),
        ].join('\n'),
        'staged/permits/census/month=2026-02/type=ALL/rows.ndjson': row('RAPTIS ROOFING LLC'),
      }),
    );
    expect(contractors).toEqual([
      { name: 'COLLIS ROOFING INC', permitCount: 2 },
      { name: 'RAPTIS ROOFING LLC', permitCount: 1 },
    ]);
    // The denominator's origin travels with it, because 47 names and 1,562 are not the
    // same measurement and the rates computed from them are not comparable.
    expect(source).toContain('2 shards');
  });

  it('reads both BBB prefixes, because the two hops are different claims', async () => {
    const { businesses, ratings } = await loadBbb(
      readerOf({
        'staged/bbb/businesses/run=a/businesses.ndjson': JSON.stringify({
          businessName: 'Collis Roofing',
        }),
        'staged/bbb/contractor-ratings/run=a/matches.ndjson': JSON.stringify({
          permitContractorName: 'COLLIS ROOFING INC',
          matched: true,
        }),
      }),
    );
    expect(businesses).toHaveLength(1);
    expect(ratings).toHaveLength(1);
  });

  it('reports an empty peer as absent rather than as a zero it measured', async () => {
    const { businesses, source } = await loadBbb(readerOf({}));
    expect(businesses).toEqual([]);
    expect(source).toContain('not present');
  });
});

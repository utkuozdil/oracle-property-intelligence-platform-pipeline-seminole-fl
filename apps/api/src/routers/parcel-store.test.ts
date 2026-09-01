import { describe, expect, it } from 'vitest';
import {
  boundingBoxFor,
  getOwnerProfile,
  haversineMiles,
  normaliseOwnerKey,
  resolveCentre,
  searchNearby,
  topOwners,
  type ParcelStore,
} from './parcel-store';
import { collectIpfsReferences } from './run-summary';

/**
 * The store is normally built from Parquet, so these tests build the columnar form directly.
 * That is the point: the query engine is pure over typed arrays and can be exercised without
 * S3 or a Parquet reader anywhere in the picture.
 */
interface Row {
  parcelId: string;
  owner: string | null;
  address: string | null;
  jurisdiction: string;
  lat: number;
  lon: number;
  roofAge?: number;
  justValue?: number;
  mailing?: string;
}

const INT_NULL = -2147483648;

function buildStore(rows: Row[]): ParcelStore {
  const size = rows.length;
  const dictionary = (values: (string | null)[]) => {
    const distinct: (string | null)[] = [];
    const codes = new Uint16Array(size);
    values.forEach((value, index) => {
      let code = distinct.indexOf(value);
      if (code === -1) {
        code = distinct.length;
        distinct.push(value);
      }
      codes[index] = code;
    });
    return { codes, values: distinct };
  };

  const float = (pick: (row: Row) => number | undefined) =>
    Float64Array.from(rows.map((row) => pick(row) ?? Number.NaN));
  const int = (pick: (row: Row) => number | undefined) =>
    Int32Array.from(rows.map((row) => pick(row) ?? INT_NULL));

  return {
    pointer: {
      runId: 'test-run',
      county: 'Seminole County, FL',
      snapshotPrefix: 's3://bucket/publish/parcels/snapshot=test-run/',
      parcelCount: size,
      partitionCount: 1,
      bytes: 0,
      publishedAt: '2026-09-01T00:00:00.000Z',
    },
    count: size,
    jurisdictions: [],
    parcelsWithoutAddress: rows.filter((row) => row.address === null).length,
    withCoordinates: size,
    withOwnerName: rows.filter((row) => row.owner !== null).length,
    bounds: null,
    loadMs: 0,
    fetchMs: 0,
    parseMs: 0,
    readyAt: '2026-09-01T00:00:00.000Z',
    heapUsedMb: 0,
    parcelId: rows.map((row) => row.parcelId),
    ownerName: rows.map((row) => row.owner),
    primaryAddress: rows.map((row) => row.address),
    mailingCityStateZip: rows.map((row) => row.mailing ?? null),
    mailingStreet: rows.map(() => null),
    subdivision: rows.map(() => null),
    propertyType: dictionary(rows.map(() => 'SINGLE FAMILY')),
    dorCode: dictionary(rows.map(() => '01')),
    jurisdiction: dictionary(rows.map((row) => row.jurisdiction)),
    searchKey: rows.map((row) =>
      `${row.parcelId} ${row.owner ?? ''} ${row.address ?? ''}`.toLowerCase(),
    ),
    yearBuilt: int(() => 1990),
    maxEffectiveYearBlt: int(() => 1995),
    roofAge: int((row) => row.roofAge),
    yearsSinceSale: int(() => 5),
    saleCount: int(() => 1),
    lastSaleDateMs: float(() => Date.UTC(2020, 0, 1)),
    lastSaleAmount: float(() => 100000),
    totalJustValue: float((row) => row.justValue ?? 250000),
    assessedValue: float(() => 200000),
    taxableValue: float(() => 180000),
    annualTaxTotal: float(() => 3000),
    totalLivingArea: float(() => 1800),
    totalBedrooms: float(() => 3),
    totalBathrooms: float(() => 2),
    latitude: float((row) => row.lat),
    longitude: float((row) => row.lon),
    flags: new Uint8Array(size),
    byParcelId: new Map(rows.map((row, index) => [row.parcelId, index])),
    ownerIndex: null,
  };
}

/** Sanford city hall, and points at known offsets from it. */
const SANFORD = { lat: 28.8029, lon: -81.2695 };

describe('haversineMiles', () => {
  it('is zero for the same point', () => {
    expect(haversineMiles(SANFORD, SANFORD)).toBe(0);
  });

  it('matches a known separation', () => {
    // Sanford to Oviedo is a shade under 12 miles as the crow flies.
    const oviedo = { lat: 28.67, lon: -81.208 };
    expect(haversineMiles(SANFORD, oviedo)).toBeCloseTo(10.2, 0);
  });

  it('is symmetric', () => {
    const other = { lat: 28.7, lon: -81.3 };
    expect(haversineMiles(SANFORD, other)).toBeCloseTo(haversineMiles(other, SANFORD), 9);
  });
});

describe('boundingBoxFor', () => {
  it('contains every point inside the radius', () => {
    const box = boundingBoxFor(SANFORD, 5);
    // One degree of latitude is ~69 miles, so five miles is ~0.0724 degrees.
    expect(box.maxLat - SANFORD.lat).toBeCloseTo(0.0724, 3);
    // Longitude spans wider at this latitude, never narrower.
    expect(box.maxLon - SANFORD.lon).toBeGreaterThan(box.maxLat - SANFORD.lat);
  });
});

describe('searchNearby', () => {
  const store = buildStore([
    {
      parcelId: 'P-CENTRE',
      owner: 'SMITH, JOHN',
      address: '1 CENTRE ST',
      jurisdiction: 'Sanford',
      lat: SANFORD.lat,
      lon: SANFORD.lon,
      roofAge: 30,
    },
    {
      parcelId: 'P-HALF',
      owner: 'SMITH  JOHN',
      address: '2 NEAR ST',
      jurisdiction: 'Sanford',
      lat: SANFORD.lat + 0.007,
      lon: SANFORD.lon,
      roofAge: 10,
    },
    {
      parcelId: 'P-TWO',
      owner: 'JONES, ANN',
      address: '3 MID ST',
      jurisdiction: 'Sanford',
      lat: SANFORD.lat + 0.029,
      lon: SANFORD.lon,
      roofAge: 22,
    },
    {
      parcelId: 'P-FAR',
      owner: 'JONES, ANN',
      address: '4 FAR ST',
      jurisdiction: 'Oviedo',
      lat: SANFORD.lat + 0.5,
      lon: SANFORD.lon,
      roofAge: 40,
    },
  ]);

  it('returns only parcels inside the radius, nearest first', () => {
    const result = searchNearby(store, SANFORD, 3, {}, 'distance_asc', 1, 25);
    expect(result.rows.map((row) => row.parcelId)).toEqual(['P-CENTRE', 'P-HALF', 'P-TWO']);
    expect(result.total).toBe(3);
    expect(result.rows[0]?.distanceMiles).toBe(0);
    expect(result.rows[2]?.distanceMiles).toBeCloseTo(2, 0);
  });

  it('computes distance only for bounding-box survivors', () => {
    const result = searchNearby(store, SANFORD, 1, {}, 'distance_asc', 1, 25);
    expect(result.candidatesScanned).toBeLessThan(store.count);
    expect(result.total).toBe(2);
  });

  it('applies attribute filters inside the radius', () => {
    const result = searchNearby(store, SANFORD, 3, { roofAgeMin: 15 }, 'distance_asc', 1, 25);
    expect(result.rows.map((row) => row.parcelId)).toEqual(['P-CENTRE', 'P-TWO']);
  });

  it('honours a non-distance sort', () => {
    const result = searchNearby(store, SANFORD, 3, {}, 'roof_age_desc', 1, 25);
    expect(result.rows.map((row) => row.parcelId)).toEqual(['P-CENTRE', 'P-TWO', 'P-HALF']);
  });

  it('pages without losing rows', () => {
    const first = searchNearby(store, SANFORD, 3, {}, 'distance_asc', 1, 2);
    const second = searchNearby(store, SANFORD, 3, {}, 'distance_asc', 2, 2);
    expect(first.rows).toHaveLength(2);
    expect(second.rows).toHaveLength(1);
    expect(first.pageCount).toBe(2);
  });

  it('keeps only parcels with a confirmed-open roofing permit and sorts longest first', () => {
    const years = new Map<string, number>([
      ['P-CENTRE', 4.2],
      ['P-TWO', 12.5],
    ]);
    const result = searchNearby(
      store,
      SANFORD,
      3,
      {},
      'permit_open_desc',
      1,
      25,
      { openRoofingOnly: true, yearsByParcel: years },
    );
    expect(result.rows.map((row) => row.parcelId)).toEqual(['P-TWO', 'P-CENTRE']);
  });

  it('matches nothing when a filter names an unknown jurisdiction', () => {
    const result = searchNearby(
      store,
      SANFORD,
      50,
      { jurisdiction: 'Nowhere' },
      'distance_asc',
      1,
      25,
    );
    expect(result.total).toBe(0);
  });
});

describe('resolveCentre', () => {
  const store = buildStore([
    {
      parcelId: 'P-1',
      owner: 'SMITH, JOHN',
      address: '629 EDEN PARK RD',
      jurisdiction: 'Sanford',
      lat: 28.8,
      lon: -81.27,
    },
    {
      parcelId: 'P-2',
      owner: 'JONES, ANN',
      address: '12 OAK LN',
      jurisdiction: 'Oviedo',
      lat: 28.67,
      lon: -81.2,
    },
  ]);

  it('resolves an exact parcel id', () => {
    expect(resolveCentre(store, 'P-2')?.parcelId).toBe('P-2');
  });

  it('resolves an address fragment', () => {
    expect(resolveCentre(store, 'eden park')?.parcelId).toBe('P-1');
  });

  it('resolves a jurisdiction to the mean of its centroids', () => {
    const resolved = resolveCentre(store, 'Oviedo');
    expect(resolved?.center.lat).toBeCloseTo(28.67, 5);
    expect(resolved?.label).toContain('mean of');
  });

  it('returns null for text that matches nothing', () => {
    expect(resolveCentre(store, 'zzzz-no-such-place')).toBeNull();
  });
});

describe('owner entities', () => {
  const store = buildStore([
    {
      parcelId: 'P-1',
      owner: 'SMITH, JOHN A.',
      address: '1 A ST',
      jurisdiction: 'Sanford',
      lat: 28.8,
      lon: -81.27,
      justValue: 300000,
      mailing: 'SANFORD FL 32771',
    },
    {
      parcelId: 'P-2',
      owner: 'SMITH  JOHN A',
      address: '2 B ST',
      jurisdiction: 'Oviedo',
      lat: 28.7,
      lon: -81.2,
      justValue: 500000,
      mailing: 'SANFORD FL 32771',
    },
    {
      parcelId: 'P-3',
      owner: 'JONES, ANN',
      address: '3 C ST',
      jurisdiction: 'Sanford',
      lat: 28.81,
      lon: -81.28,
      justValue: 100000,
    },
  ]);

  it('merges formatting variants of one name', () => {
    expect(normaliseOwnerKey('SMITH, JOHN A.')).toBe(normaliseOwnerKey('SMITH  JOHN A'));
    expect(normaliseOwnerKey('SMITH, JOHN A.')).not.toBe(normaliseOwnerKey('SMITH, JOHN B'));
  });

  it('aggregates a portfolio across jurisdictions', () => {
    const profile = getOwnerProfile(store, 'smith, john a.', 1, 25);
    expect(profile?.parcelCount).toBe(2);
    expect(profile?.totalJustValue).toBe(800000);
    expect(profile?.jurisdictions.map((entry) => entry.value).sort()).toEqual([
      'Oviedo',
      'Sanford',
    ]);
    expect(profile?.spellings).toHaveLength(2);
    // Highest value first, so the portfolio reads as a portfolio.
    expect(profile?.parcels[0]?.parcelId).toBe('P-2');
  });

  it('keeps every distinct spelling visible so a merge can be audited', () => {
    const profile = getOwnerProfile(store, 'SMITH JOHN A', 1, 25);
    expect(profile?.spellings).toEqual(['SMITH  JOHN A', 'SMITH, JOHN A.']);
  });

  it('returns null for an unknown owner', () => {
    expect(getOwnerProfile(store, 'NOBODY AT ALL', 1, 25)).toBeNull();
  });

  it('ranks portfolios by parcel count', () => {
    const owners = topOwners(store, 10, 2);
    expect(owners).toHaveLength(1);
    expect(owners[0]?.parcelCount).toBe(2);
  });
});

describe('collectIpfsReferences', () => {
  it('finds CIDs behind cid-named keys', () => {
    const found = collectIpfsReferences({
      datasets: {
        queryTable: { cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' },
      },
    });
    expect(found.cids).toHaveLength(1);
    expect(found.cids[0]?.gatewayUrl).toContain('/ipfs/bafybei');
  });

  it('reads an IPNS name from its field name, not its shape', () => {
    const found = collectIpfsReferences({ ipns: { name: 'k51qzi5uqu5dktest' } });
    expect(found.ipnsName).toBe('k51qzi5uqu5dktest');
  });

  it('finds nothing in an object with no references', () => {
    const found = collectIpfsReferences({ runId: 'run-1', parcelCount: 181218 });
    expect(found.cids).toEqual([]);
    expect(found.ipnsName).toBeNull();
  });
});

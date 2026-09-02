import { describe, expect, it } from 'vitest';
import { ROOFING_TAXONOMY_PATH } from '../places/config';
import {
  buildPlaceStore,
  getPlace,
  searchPlaces,
  type PlaceRecord,
  type PlacesPointer,
} from './place-store';

const POINTER: PlacesPointer = {
  release: '2026-08-19.0',
  runId: 'places-test',
  publishedAt: '2026-09-01T00:00:00.000Z',
  businessLocations: 3,
  roofingPlaces: 1,
  table: 'publish/places/business-locations/release=2026-08-19.0/places.parquet',
};

function row(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    gers_id: 'gers-1',
    name: 'Acme Pizza',
    taxonomy_primary: 'pizza_restaurant',
    taxonomy_hierarchy: 'eat_and_drink/restaurant/pizza_restaurant',
    basic_category: 'eat_and_drink',
    confidence: 0.91,
    confidence_band: '0.90-0.95',
    latitude: 28.8,
    longitude: -81.27,
    jurisdiction: 'Sanford',
    address_freeform: '100 MAIN ST',
    address_locality: 'Sanford',
    address_postcode: '32771',
    address_region: 'FL',
    locality_matches_jurisdiction: true,
    operating_status: 'open',
    websites: ['https://example.com'],
    phones: ['407-555-0100'],
    emails: [],
    socials: [],
    brand_name: null,
    source_datasets: ['Microsoft'],
    overture_release: '2026-08-19.0',
    source_url: 's3://overturemaps-us-west-2/release/2026-08-19.0/theme=places/type=place/',
    first_seen_release: '2026-08-19.0',
    last_seen_release: '2026-08-19.0',
    ...partial,
  };
}

function store(rows: Record<string, unknown>[]) {
  return buildPlaceStore(POINTER, rows, new Map(), { loadMs: 1, fetchMs: 1, parseMs: 1 });
}

describe('searchPlaces', () => {
  const built = store([
    row({ gers_id: 'gers-pizza', name: 'Acme Pizza' }),
    row({
      gers_id: 'gers-roof',
      name: 'Top Notch Roofing',
      taxonomy_primary: 'roofing',
      taxonomy_hierarchy: ROOFING_TAXONOMY_PATH,
      basic_category: 'service',
      jurisdiction: 'Longwood',
      address_freeform: '12 OAK AVE',
      confidence: 0.7,
    }),
    row({
      gers_id: 'gers-unnamed',
      name: null,
      brand_name: null,
      basic_category: 'service',
      jurisdiction: 'Oviedo',
      address_freeform: null,
      confidence: null,
    }),
  ]);

  it('matches name, address, and category text without inventing rows', () => {
    const byName = searchPlaces(built, { q: 'acme' }, 'name_asc', 1, 25);
    expect(byName.total).toBe(1);
    expect(byName.rows[0]?.gersId).toBe('gers-pizza');

    const byAddress = searchPlaces(built, { q: 'oak ave' }, 'name_asc', 1, 25);
    expect(byAddress.rows.map((place) => place.gersId)).toEqual(['gers-roof']);
  });

  it('filters roofing by the hierarchy path, not a name guess', () => {
    const result = searchPlaces(built, { roofingOnly: true }, 'name_asc', 1, 25);
    expect(result.total).toBe(1);
    expect(result.rows[0]?.isRoofing).toBe(true);
    expect(result.rows[0]?.gersId).toBe('gers-roof');
  });

  it('filters jurisdiction and category independently', () => {
    const result = searchPlaces(
      built,
      { jurisdiction: 'Sanford', category: 'eat_and_drink' },
      'name_asc',
      1,
      25,
    );
    expect(result.rows.map((place) => place.gersId)).toEqual(['gers-pizza']);
  });

  it('titles an unnamed place instead of leaving the cell blank', () => {
    const place = getPlace(built, 'gers-unnamed');
    expect(place?.displayTitle).toBe('Place gers-unnamed');
    expect(built.unnamedCount).toBe(1);
  });

  it('sorts by confidence with nulls last', () => {
    const result = searchPlaces(built, {}, 'confidence_desc', 1, 25);
    expect(result.rows.map((place) => place.gersId)).toEqual([
      'gers-pizza',
      'gers-roof',
      'gers-unnamed',
    ]);
  });

  it('pages without changing the total', () => {
    const page = searchPlaces(built, {}, 'name_asc', 2, 1);
    expect(page.total).toBe(3);
    expect(page.pageCount).toBe(3);
    expect(page.rows).toHaveLength(1);
  });
});

describe('buildPlaceStore', () => {
  it('attaches a roofing join when one exists for the GERS id', () => {
    const matches = new Map([
      [
        'gers-roof',
        {
          permitMatched: true,
          permitContractorName: 'TOP NOTCH ROOFING INC',
          permitMatchTier: 'exact',
          permitMatchConfidence: 0.99,
          permitCount: 4,
          bbbMatched: true,
          bbbPath: 'direct',
          bbbBusinessName: 'Top Notch Roofing',
          bbbRating: 'A+',
          bbbMatchConfidence: 0.88,
          bbbProfileUrl: 'https://www.bbb.org/example',
        },
      ],
    ]);
    const built = buildPlaceStore(
      POINTER,
      [row({ gers_id: 'gers-roof', taxonomy_hierarchy: ROOFING_TAXONOMY_PATH })],
      matches,
      { loadMs: 1, fetchMs: 1, parseMs: 1 },
    );
    const place = getPlace(built, 'gers-roof') as PlaceRecord;
    expect(place.roofing?.bbbRating).toBe('A+');
    expect(place.roofing?.permitContractorName).toBe('TOP NOTCH ROOFING INC');
  });

  it('drops a row that has no GERS id rather than inventing one', () => {
    const built = store([row({ gers_id: '' })]);
    expect(built.places).toHaveLength(0);
  });
});

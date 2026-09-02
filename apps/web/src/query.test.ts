import { describe, expect, it } from 'vitest';
import {
  EMPTY_PLACES,
  describePlaceFilters,
  parseLocation,
  toPlacesInput,
  toSearchString,
} from './query';

describe('places query string', () => {
  it('round-trips a filtered businesses view and an open place', () => {
    const parsed = parseLocation(
      '?view=places&placesQ=pizza&placesJurisdiction=Sanford&placesCategory=eat_and_drink&placesRoofing=true&placesPage=2&place=gers-1',
    );

    expect(parsed.view).toBe('places');
    expect(parsed.placeId).toBe('gers-1');
    expect(parsed.places).toMatchObject({
      q: 'pizza',
      jurisdiction: 'Sanford',
      category: 'eat_and_drink',
      roofingOnly: 'true',
      page: 2,
    });

    const encoded = toSearchString(parsed);
    const again = parseLocation(encoded.startsWith('/?') ? encoded.slice(1) : encoded);
    expect(again.view).toBe('places');
    expect(again.placeId).toBe('gers-1');
    expect(again.places.q).toBe('pizza');
    expect(again.places.roofingOnly).toBe('true');
  });

  it('omits empty place filters from the URL', () => {
    const encoded = toSearchString({
      view: 'places',
      query: parseLocation('').query,
      radius: parseLocation('').radius,
      places: EMPTY_PLACES,
      parcelId: null,
      owner: null,
      placeId: null,
    });
    expect(encoded).toBe('/?view=places');
  });
});

describe('describePlaceFilters', () => {
  it('names each applied filter so the chips stay assertable', () => {
    const chips = describePlaceFilters({
      ...EMPTY_PLACES,
      q: 'roof',
      roofingOnly: 'true',
    });
    expect(chips.map((chip) => chip.key)).toEqual(['q', 'roofingOnly']);
  });
});

describe('toPlacesInput', () => {
  it('treats blank strings as unset filters', () => {
    expect(toPlacesInput(EMPTY_PLACES)).toEqual({
      q: undefined,
      jurisdiction: undefined,
      category: undefined,
      status: undefined,
      roofingOnly: undefined,
      sort: 'name_asc',
      page: 1,
      pageSize: 25,
    });
  });
});

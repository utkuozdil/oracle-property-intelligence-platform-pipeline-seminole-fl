import { toOptionalNumber } from './format';

/**
 * The full search state, held as strings because it is bound directly to form controls
 * and round-trips through the URL. Conversion to numbers happens once, at the API edge.
 *
 * Keeping this in the URL is what makes a result shareable and lets the browser
 * back button step out of a parcel detail view.
 */
export interface SearchQuery {
  q: string;
  jurisdiction: string;
  roofAgeMin: string;
  justValueMin: string;
  justValueMax: string;
  yearBuiltMin: string;
  yearBuiltMax: string;
  yearsSinceSaleMin: string;
  ownerOutOfArea: '' | 'true' | 'false';
  sort: SortKey;
  page: number;
  pageSize: number;
}

export const SORT_OPTIONS = [
  { value: 'relevance', label: 'Parcel order' },
  { value: 'roof_age_desc', label: 'Roof age — oldest first' },
  { value: 'total_just_value_desc', label: 'Just value — highest first' },
  { value: 'total_just_value_asc', label: 'Just value — lowest first' },
  { value: 'years_since_sale_desc', label: 'Years since sale — longest first' },
  { value: 'year_built_asc', label: 'Year built — oldest first' },
  { value: 'year_built_desc', label: 'Year built — newest first' },
  { value: 'last_sale_date_desc', label: 'Last sale — most recent first' },
] as const;

export type SortKey = (typeof SORT_OPTIONS)[number]['value'];

const SORT_VALUES = SORT_OPTIONS.map((option) => option.value) as readonly string[];

export const PAGE_SIZES = [10, 25, 50, 100] as const;

export const EMPTY_QUERY: SearchQuery = {
  q: '',
  jurisdiction: '',
  roofAgeMin: '',
  justValueMin: '',
  justValueMax: '',
  yearBuiltMin: '',
  yearBuiltMax: '',
  yearsSinceSaleMin: '',
  ownerOutOfArea: '',
  sort: 'relevance',
  page: 1,
  pageSize: 25,
};

/**
 * Radius search state. Separate from {@link SearchQuery} because it has its own centre and
 * its own default sort, and its parameters are prefixed in the URL so a link to a radius
 * result can never be misread as a filtered list.
 */
export interface RadiusQuery {
  /** Free text centre: an address, parcel id, jurisdiction, or owner. */
  near: string;
  lat: string;
  lon: string;
  radiusMiles: string;
  roofAgeMin: string;
  jurisdiction: string;
  ownerOutOfArea: '' | 'true' | 'false';
  sort: NearbySortKey;
  page: number;
  pageSize: number;
}

export const NEARBY_SORT_OPTIONS = [
  { value: 'distance_asc', label: 'Distance — nearest first' },
  ...SORT_OPTIONS,
] as const;

export type NearbySortKey = (typeof NEARBY_SORT_OPTIONS)[number]['value'];

const NEARBY_SORT_VALUES = NEARBY_SORT_OPTIONS.map((option) => option.value) as readonly string[];

export const RADIUS_MILE_PRESETS = [0.5, 1, 3, 5, 10] as const;

export const EMPTY_RADIUS: RadiusQuery = {
  near: '',
  lat: '',
  lon: '',
  radiusMiles: '5',
  roofAgeMin: '',
  jurisdiction: '',
  ownerOutOfArea: '',
  sort: 'distance_asc',
  page: 1,
  pageSize: 25,
};

/** The four top-level views. `parcel` and `owner` open on top of whichever view is active. */
export const VIEWS = ['search', 'radius', 'runs', 'owners'] as const;
export type ViewName = (typeof VIEWS)[number];

export interface AppState {
  view: ViewName;
  query: SearchQuery;
  radius: RadiusQuery;
  /** Non-null when the parcel detail view is open. */
  parcelId: string | null;
  /** Non-null when an owner entity view is open. */
  owner: string | null;
}

function readSort(value: string | null): SortKey {
  return value !== null && SORT_VALUES.includes(value) ? (value as SortKey) : 'relevance';
}

function readInt(value: string | null, fallback: number): number {
  const parsed = value === null ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readView(value: string | null): ViewName {
  return value !== null && (VIEWS as readonly string[]).includes(value)
    ? (value as ViewName)
    : 'search';
}

function readNearbySort(value: string | null): NearbySortKey {
  return value !== null && NEARBY_SORT_VALUES.includes(value)
    ? (value as NearbySortKey)
    : 'distance_asc';
}

export function parseLocation(search: string): AppState {
  const params = new URLSearchParams(search);
  const text = (key: string): string => params.get(key) ?? '';
  const flag = params.get('ownerOutOfArea');
  const radiusFlag = params.get('radiusOwnerOutOfArea');

  return {
    view: readView(params.get('view')),
    parcelId: params.get('parcel'),
    owner: params.get('owner'),
    radius: {
      near: text('near'),
      lat: text('lat'),
      lon: text('lon'),
      radiusMiles: params.get('radius') ?? EMPTY_RADIUS.radiusMiles,
      roofAgeMin: text('radiusRoofAgeMin'),
      jurisdiction: text('radiusJurisdiction'),
      ownerOutOfArea: radiusFlag === 'true' || radiusFlag === 'false' ? radiusFlag : '',
      sort: readNearbySort(params.get('radiusSort')),
      page: readInt(params.get('radiusPage'), 1),
      pageSize: readInt(params.get('radiusPageSize'), 25),
    },
    query: {
      q: text('q'),
      jurisdiction: text('jurisdiction'),
      roofAgeMin: text('roofAgeMin'),
      justValueMin: text('justValueMin'),
      justValueMax: text('justValueMax'),
      yearBuiltMin: text('yearBuiltMin'),
      yearBuiltMax: text('yearBuiltMax'),
      yearsSinceSaleMin: text('yearsSinceSaleMin'),
      ownerOutOfArea: flag === 'true' || flag === 'false' ? flag : '',
      sort: readSort(params.get('sort')),
      page: readInt(params.get('page'), 1),
      pageSize: readInt(params.get('pageSize'), 25),
    },
  };
}

export function toSearchString(state: AppState): string {
  const params = new URLSearchParams();
  const { query, radius } = state;

  if (state.view !== 'search') params.set('view', state.view);

  if (state.view === 'radius') {
    for (const [key, value] of [
      ['near', radius.near],
      ['lat', radius.lat],
      ['lon', radius.lon],
      ['radiusRoofAgeMin', radius.roofAgeMin],
      ['radiusJurisdiction', radius.jurisdiction],
      ['radiusOwnerOutOfArea', radius.ownerOutOfArea],
    ] as const) {
      if (value !== '') params.set(key, value);
    }
    if (radius.radiusMiles !== EMPTY_RADIUS.radiusMiles) params.set('radius', radius.radiusMiles);
    if (radius.sort !== 'distance_asc') params.set('radiusSort', radius.sort);
    if (radius.page !== 1) params.set('radiusPage', String(radius.page));
    if (radius.pageSize !== 25) params.set('radiusPageSize', String(radius.pageSize));
  }

  if (state.owner !== null) params.set('owner', state.owner);

  for (const key of [
    'q',
    'jurisdiction',
    'roofAgeMin',
    'justValueMin',
    'justValueMax',
    'yearBuiltMin',
    'yearBuiltMax',
    'yearsSinceSaleMin',
    'ownerOutOfArea',
  ] as const) {
    const value = query[key];
    if (value !== '') params.set(key, value);
  }
  if (query.sort !== 'relevance') params.set('sort', query.sort);
  if (query.page !== 1) params.set('page', String(query.page));
  if (query.pageSize !== 25) params.set('pageSize', String(query.pageSize));
  if (state.parcelId !== null) params.set('parcel', state.parcelId);

  const encoded = params.toString();
  return encoded === '' ? '/' : `/?${encoded}`;
}

export interface ActiveFilter {
  key: string;
  label: string;
}

/** Drives the visible "filters applied" chips, so applied state is always assertable. */
export function describeFilters(query: SearchQuery): ActiveFilter[] {
  const chips: ActiveFilter[] = [];
  if (query.q !== '') chips.push({ key: 'q', label: `Text: "${query.q}"` });
  if (query.jurisdiction !== '')
    chips.push({ key: 'jurisdiction', label: `Jurisdiction: ${query.jurisdiction}` });
  if (query.roofAgeMin !== '')
    chips.push({ key: 'roofAgeMin', label: `Roof age ≥ ${query.roofAgeMin} yrs` });
  if (query.justValueMin !== '')
    chips.push({ key: 'justValueMin', label: `Just value ≥ $${query.justValueMin}` });
  if (query.justValueMax !== '')
    chips.push({ key: 'justValueMax', label: `Just value ≤ $${query.justValueMax}` });
  if (query.yearBuiltMin !== '')
    chips.push({ key: 'yearBuiltMin', label: `Year built ≥ ${query.yearBuiltMin}` });
  if (query.yearBuiltMax !== '')
    chips.push({ key: 'yearBuiltMax', label: `Year built ≤ ${query.yearBuiltMax}` });
  if (query.yearsSinceSaleMin !== '')
    chips.push({
      key: 'yearsSinceSaleMin',
      label: `Years since sale ≥ ${query.yearsSinceSaleMin}`,
    });
  if (query.ownerOutOfArea !== '')
    chips.push({
      key: 'ownerOutOfArea',
      label: query.ownerOutOfArea === 'true' ? 'Owner out of area' : 'Owner in area',
    });
  return chips;
}

export interface SearchInput {
  q?: string;
  jurisdiction?: string;
  roofAgeMin?: number;
  justValueMin?: number;
  justValueMax?: number;
  yearBuiltMin?: number;
  yearBuiltMax?: number;
  yearsSinceSaleMin?: number;
  ownerOutOfArea?: boolean;
  sort: SortKey;
  page: number;
  pageSize: number;
}

export interface NearbyInput {
  lat?: number;
  lon?: number;
  near?: string;
  radiusMiles: number;
  roofAgeMin?: number;
  jurisdiction?: string;
  ownerOutOfArea?: boolean;
  sort: NearbySortKey;
  page: number;
  pageSize: number;
}

/**
 * Explicit coordinates win over free text, so a pin drop is never overridden by whatever
 * text happens to be left in the box. Returns `null` when neither is set, which is the
 * "nothing to search yet" state rather than an error.
 */
export function toNearbyInput(radius: RadiusQuery): NearbyInput | null {
  const lat = toOptionalNumber(radius.lat);
  const lon = toOptionalNumber(radius.lon);
  const near = radius.near.trim();
  const hasPoint = lat !== undefined && lon !== undefined;
  if (!hasPoint && near === '') return null;

  return {
    ...(hasPoint ? { lat, lon } : { near }),
    radiusMiles: toOptionalNumber(radius.radiusMiles) ?? 5,
    roofAgeMin: toOptionalNumber(radius.roofAgeMin),
    jurisdiction: radius.jurisdiction === '' ? undefined : radius.jurisdiction,
    ownerOutOfArea: radius.ownerOutOfArea === '' ? undefined : radius.ownerOutOfArea === 'true',
    sort: radius.sort,
    page: radius.page,
    pageSize: radius.pageSize,
  };
}

export function toSearchInput(query: SearchQuery): SearchInput {
  return {
    q: query.q.trim() === '' ? undefined : query.q.trim(),
    jurisdiction: query.jurisdiction === '' ? undefined : query.jurisdiction,
    roofAgeMin: toOptionalNumber(query.roofAgeMin),
    justValueMin: toOptionalNumber(query.justValueMin),
    justValueMax: toOptionalNumber(query.justValueMax),
    yearBuiltMin: toOptionalNumber(query.yearBuiltMin),
    yearBuiltMax: toOptionalNumber(query.yearBuiltMax),
    yearsSinceSaleMin: toOptionalNumber(query.yearsSinceSaleMin),
    ownerOutOfArea: query.ownerOutOfArea === '' ? undefined : query.ownerOutOfArea === 'true',
    sort: query.sort,
    page: query.page,
    pageSize: query.pageSize,
  };
}

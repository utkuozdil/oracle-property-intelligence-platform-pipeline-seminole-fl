import { sqlString } from './duckdb';

/**
 * Filter compilation for the property tools.
 *
 * The filters are named for the questions a roofing CRM actually asks — roof age, when
 * it last sold, what it is worth, which jurisdiction — and each one maps to a column
 * that is *already* in the published table. Nothing here needs a new export or a
 * reshaped schema, which is the constraint the assignment puts on this layer.
 *
 * Every value is bound through `sqlString` or a finite-number check, so a tool argument
 * cannot become SQL.
 */

export interface PropertyFilters {
  minRoofAge?: number;
  maxRoofAge?: number;
  minYearBuilt?: number;
  maxYearBuilt?: number;
  jurisdiction?: string;
  propertyType?: string;
  addressContains?: string;
  ownerNameContains?: string;
  minJustValue?: number;
  maxJustValue?: number;
  soldBefore?: string;
  soldAfter?: string;
  minYearsSinceSale?: number;
  ownerOutOfArea?: boolean;
  hasBuilding?: boolean;
  hasPool?: boolean;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class FilterError extends Error {
  override readonly name = 'FilterError';
}

function numeric(value: number, field: string): string {
  if (!Number.isFinite(value)) throw new FilterError(`${field} must be a finite number`);
  return String(value);
}

function date(value: string, field: string): string {
  if (!DATE_PATTERN.test(value)) throw new FilterError(`${field} must be an ISO date (YYYY-MM-DD)`);
  return `DATE ${sqlString(value)}`;
}

/**
 * Text matching is case- and substring-insensitive on purpose.
 *
 * An agent asks for "sanford", the column holds "SANFORD"; an agent asks for "Winter
 * Springs", the column holds "WINTER SPRINGS". Requiring an exact match would turn a
 * reasonable question into a confident empty result, which is the specific failure mode
 * this whole layer is supposed to avoid.
 */
function contains(column: string, value: string): string {
  return `${column} ILIKE ${sqlString(`%${value}%`)}`;
}

export function buildPredicates(filters: PropertyFilters): string[] {
  const predicates: string[] = [];

  if (filters.minRoofAge !== undefined) {
    predicates.push(`roof_age >= ${numeric(filters.minRoofAge, 'minRoofAge')}`);
  }
  if (filters.maxRoofAge !== undefined) {
    predicates.push(`roof_age <= ${numeric(filters.maxRoofAge, 'maxRoofAge')}`);
  }
  if (filters.minYearBuilt !== undefined) {
    predicates.push(`year_built >= ${numeric(filters.minYearBuilt, 'minYearBuilt')}`);
  }
  if (filters.maxYearBuilt !== undefined) {
    predicates.push(`year_built <= ${numeric(filters.maxYearBuilt, 'maxYearBuilt')}`);
  }
  if (filters.jurisdiction !== undefined) {
    predicates.push(contains('jurisdiction', filters.jurisdiction));
  }
  if (filters.propertyType !== undefined) {
    predicates.push(contains('property_type', filters.propertyType));
  }
  if (filters.addressContains !== undefined) {
    predicates.push(contains('primary_address', filters.addressContains));
  }
  if (filters.ownerNameContains !== undefined) {
    predicates.push(contains('owner_name', filters.ownerNameContains));
  }
  if (filters.minJustValue !== undefined) {
    predicates.push(`total_just_value >= ${numeric(filters.minJustValue, 'minJustValue')}`);
  }
  if (filters.maxJustValue !== undefined) {
    predicates.push(`total_just_value <= ${numeric(filters.maxJustValue, 'maxJustValue')}`);
  }
  if (filters.soldBefore !== undefined) {
    predicates.push(`last_sale_date < ${date(filters.soldBefore, 'soldBefore')}`);
  }
  if (filters.soldAfter !== undefined) {
    predicates.push(`last_sale_date > ${date(filters.soldAfter, 'soldAfter')}`);
  }
  if (filters.minYearsSinceSale !== undefined) {
    predicates.push(
      `years_since_sale >= ${numeric(filters.minYearsSinceSale, 'minYearsSinceSale')}`,
    );
  }
  if (filters.ownerOutOfArea !== undefined) {
    predicates.push(`owner_out_of_area = ${filters.ownerOutOfArea ? 'TRUE' : 'FALSE'}`);
  }
  if (filters.hasBuilding !== undefined) {
    predicates.push(`has_building = ${filters.hasBuilding ? 'TRUE' : 'FALSE'}`);
  }
  if (filters.hasPool !== undefined) {
    predicates.push(`has_pool = ${filters.hasPool ? 'TRUE' : 'FALSE'}`);
  }

  return predicates;
}

export function whereClause(predicates: string[]): string {
  return predicates.length === 0 ? '' : `WHERE ${predicates.join('\n  AND ')}`;
}

/**
 * Great-circle distance in miles, as a SQL expression.
 *
 * Haversine on a spherical earth: a few metres of error over a five-mile radius, which
 * is far inside the accuracy of a parcel centroid. The published table carries a
 * coordinate per row precisely so this can be a plain arithmetic filter with no spatial
 * extension, no index and no server.
 */
export function haversineMiles(lat: number, lon: number): string {
  const latitude = numeric(lat, 'latitude');
  const longitude = numeric(lon, 'longitude');
  return `3958.8 * 2 * asin(sqrt(
      pow(sin(radians(latitude - ${latitude}) / 2), 2) +
      cos(radians(${latitude})) * cos(radians(latitude)) *
      pow(sin(radians(longitude - ${longitude}) / 2), 2)
    ))`;
}

/**
 * Bounding-box prefilter around the same pin.
 *
 * Haversine is not sargable, so on its own it forces a scan of every row group. A
 * latitude/longitude box is a plain range predicate, which DuckDB pushes into Parquet
 * row-group statistics and uses to skip most of the file over range requests — the
 * difference between reading 22 MB from a gateway and reading a few hundred KB.
 */
export function boundingBox(lat: number, lon: number, radiusMiles: number): string[] {
  const latitude = numeric(lat, 'latitude');
  const longitude = numeric(lon, 'longitude');
  const radius = numeric(radiusMiles, 'radiusMiles');
  const latDelta = `(${radius} / 69.0)`;
  // Longitude degrees shrink with latitude; the cosine guard keeps the box valid near the
  // poles, where it would otherwise divide by zero. Seminole County is at 28°N, but a
  // county-agnostic expression costs nothing.
  const lonDelta = `(${radius} / (69.0 * greatest(cos(radians(${latitude})), 0.01)))`;
  return [
    `latitude BETWEEN ${latitude} - ${latDelta} AND ${latitude} + ${latDelta}`,
    `longitude BETWEEN ${longitude} - ${lonDelta} AND ${longitude} + ${lonDelta}`,
  ];
}

export const ORDER_BY = {
  roof_age_desc: 'roof_age DESC NULLS LAST, total_just_value DESC',
  roof_age_asc: 'roof_age ASC NULLS LAST',
  just_value_desc: 'total_just_value DESC NULLS LAST',
  just_value_asc: 'total_just_value ASC NULLS LAST',
  last_sale_date_desc: 'last_sale_date DESC NULLS LAST',
  years_since_sale_desc: 'years_since_sale DESC NULLS LAST',
  parcel_id: 'parcel_id ASC',
} as const;

export type OrderKey = keyof typeof ORDER_BY;

/**
 * The summary projection.
 *
 * A deliberate subset rather than `SELECT *`: 55 columns times 200 rows is a large,
 * mostly irrelevant payload to push through a model's context window. `get_property`
 * returns every column for the one parcel an agent has narrowed down to.
 */
export const SUMMARY_COLUMNS = [
  'parcel_id',
  'primary_address',
  'jurisdiction',
  'property_type',
  'owner_name',
  'owner_out_of_area',
  'year_built',
  'roof_age',
  'last_sale_date',
  'last_sale_amount',
  'years_since_sale',
  'total_just_value',
  'total_living_area',
  'has_building',
  'latitude',
  'longitude',
] as const;

export const SUMMARY_PROJECTION = SUMMARY_COLUMNS.join(', ');

/**
 * County and municipal boundaries, from Census TIGERweb.
 *
 * A bounding box is not a county. The crude Seminole box holds 37,621 Overture places and
 * the boundary holds 26,446 — a bbox-scoped ingest would have silently published about
 * 11,000 Orange and Volusia County businesses as Seminole ones. So the box exists only to
 * prune Parquet reads and the polygon decides membership.
 *
 * Fetched from TIGERweb's query API rather than by downloading the national TIGER/Line
 * shapefile: one HTTPS GET, 108 KB, 2,647 vertices at full TIGER/Line resolution. The
 * generalised cartographic-boundary files would have been smaller still and are the wrong
 * tool — they move the border by hundreds of metres, which is exactly where the ambiguous
 * records are.
 */
import { createHash } from 'node:crypto';
import {
  BOUNDARY_TIMEOUT_MS,
  COUNTY_FIPS,
  TIGERWEB_COUNTY_LAYER,
  TIGERWEB_PLACE_LAYER,
  TIGERWEB_VINTAGE,
} from './config';
import { BoundaryProvenance } from './model';

export class BoundaryError extends Error {
  override readonly name = 'BoundaryError';
}

interface GeoJsonFeature {
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
}

interface GeoJsonCollection {
  features?: GeoJsonFeature[];
}

export interface FetchedBoundary {
  /** The bytes as served, so a fingerprint is over the wire format and not a re-encoding. */
  geojson: string;
  provenance: BoundaryProvenance;
}

async function getText(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(BOUNDARY_TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new BoundaryError(`${url} returned HTTP ${response.status}`);
  }
  return response.text();
}

function countVertices(coordinates: unknown): number {
  if (!Array.isArray(coordinates)) return 0;
  const first = coordinates[0] as unknown;
  if (typeof first === 'number') return 1;
  let total = 0;
  for (const child of coordinates) total += countVertices(child);
  return total;
}

function boundsOf(coordinates: unknown): {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
} {
  let xmin = Infinity;
  let ymin = Infinity;
  let xmax = -Infinity;
  let ymax = -Infinity;
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      const [x, y] = node as [number, number];
      if (x < xmin) xmin = x;
      if (x > xmax) xmax = x;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
      return;
    }
    for (const child of node) walk(child);
  };
  walk(coordinates);
  if (!Number.isFinite(xmin)) throw new BoundaryError('boundary has no coordinates');
  return { xmin, ymin, xmax, ymax };
}

export function fingerprint(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * The county polygon, selected by five-digit FIPS.
 *
 * Selected by `GEOID` rather than by name: two states have a Seminole County, and a name
 * filter that quietly returned the Oklahoma one would produce an empty extract rather than
 * an error.
 */
export async function fetchCountyBoundary(fips: string = COUNTY_FIPS): Promise<FetchedBoundary> {
  const url =
    `${TIGERWEB_COUNTY_LAYER}/query?where=GEOID%3D%27${fips}%27` +
    '&outFields=GEOID,NAME,STATE,COUNTY,AREALAND,AREAWATER' +
    '&returnGeometry=true&outSR=4326&f=geojson';

  const fetchedAt = new Date().toISOString();
  const geojson = await getText(url);
  const parsed = JSON.parse(geojson) as GeoJsonCollection;
  const feature = parsed.features?.[0];
  if (!feature) throw new BoundaryError(`TIGERweb returned no county for GEOID ${fips}`);

  const geoid = String(feature.properties.GEOID ?? '');
  if (geoid !== fips) {
    throw new BoundaryError(`asked for GEOID ${fips} and got ${geoid}`);
  }

  return {
    geojson,
    provenance: BoundaryProvenance.parse({
      source: 'census-tigerweb',
      layerUrl: TIGERWEB_COUNTY_LAYER,
      vintage: TIGERWEB_VINTAGE,
      geoid,
      name: String(feature.properties.NAME ?? ''),
      fetchedAt,
      fingerprint: fingerprint(geojson),
      vertices: countVertices(feature.geometry.coordinates),
      bbox: boundsOf(feature.geometry.coordinates),
    }),
  };
}

export interface FetchedMunicipalities {
  geojson: string;
  fetchedAt: string;
  fingerprint: string;
  /** Every incorporated place whose polygon touches the county extent, named. */
  names: string[];
}

/**
 * Incorporated places intersecting the county extent.
 *
 * Queried by envelope, and deliberately not filtered to the seven Seminole municipalities:
 * the neighbours are what prove the assignment is geometric. Orlando, Apopka, Maitland,
 * Winter Park, Eatonville, DeBary and Deltona all come back, none of them claims a business
 * that survived the county clip, and *that* is the evidence — a filtered query could not
 * have produced it.
 */
export async function fetchMunicipalBoundaries(bbox: {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}): Promise<FetchedMunicipalities> {
  const params = new URLSearchParams({
    geometry: `${bbox.xmin},${bbox.ymin},${bbox.xmax},${bbox.ymax}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    where: `STATE='${COUNTY_FIPS.slice(0, 2)}'`,
    outFields: 'GEOID,NAME,BASENAME,STATE',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  });

  const fetchedAt = new Date().toISOString();
  const geojson = await getText(`${TIGERWEB_PLACE_LAYER}/query?${params.toString()}`);
  const parsed = JSON.parse(geojson) as GeoJsonCollection;
  const features = parsed.features ?? [];
  if (features.length === 0) {
    throw new BoundaryError('TIGERweb returned no incorporated places for the county extent');
  }

  return {
    geojson,
    fetchedAt,
    fingerprint: fingerprint(geojson),
    names: features.map((feature) => String(feature.properties.NAME ?? '')).sort(),
  };
}

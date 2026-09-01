/**
 * Release resolution, and why the pin is not optional.
 *
 * Overture's category taxonomy changes quarterly and the S3 bucket retains only the two
 * newest releases. A run that resolved "latest" at execution time would therefore change
 * both its row count and its category vocabulary without any code change, and last month's
 * reported roofing count would be unreproducible — the data it was counted from would be
 * gone from the bucket.
 *
 * So the release is pinned in `config.ts`, this module *reports* drift against the live
 * STAC catalog, and only an explicit `failOnReleaseDrift` turns that report into an error.
 * Moving the pin is a commit, which is what makes it reviewable.
 */
import { BOUNDARY_TIMEOUT_MS, OVERTURE_RELEASE, OVERTURE_STAC_CATALOG } from './config';

export interface ReleaseDrift {
  pinned: string;
  /** Null when the catalog could not be read. Unreachable is not the same as unchanged. */
  latest: string | null;
  drifted: boolean;
  warning: string | null;
}

interface StacCatalog {
  latest?: unknown;
}

/**
 * Reads the newest release id from the STAC catalog.
 *
 * A failure here is not fatal: the pinned release is what the run reads either way, and a
 * catalog outage should not stop an ingest of data that is already public and immutable.
 */
export async function resolveLatestRelease(): Promise<string | null> {
  try {
    const response = await fetch(OVERTURE_STAC_CATALOG, {
      signal: AbortSignal.timeout(BOUNDARY_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const catalog = (await response.json()) as StacCatalog;
    return typeof catalog.latest === 'string' ? catalog.latest : null;
  } catch {
    return null;
  }
}

export async function checkReleaseDrift(pinned: string = OVERTURE_RELEASE): Promise<ReleaseDrift> {
  const latest = await resolveLatestRelease();
  if (latest === null) {
    return {
      pinned,
      latest: null,
      drifted: false,
      warning: `could not read ${OVERTURE_STAC_CATALOG}; proceeding on the pinned release`,
    };
  }
  if (latest === pinned) return { pinned, latest, drifted: false, warning: null };
  return {
    pinned,
    latest,
    drifted: true,
    warning:
      `Overture published ${latest}; this run used the pinned ${pinned}. ` +
      'Move the pin in a commit after reviewing the taxonomy diff — do not follow it silently.',
  };
}

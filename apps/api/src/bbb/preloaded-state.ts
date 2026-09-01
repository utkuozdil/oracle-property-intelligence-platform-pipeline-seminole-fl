/**
 * Extracting the search results out of a BBB search response.
 *
 * The results are not in the rendered markup in any parseable form — they are the JSON the
 * React app hydrates from, assigned to `window.__PRELOADED_STATE__` in the document head.
 * That assignment is the parse target.
 */
import { PRELOADED_STATE_GLOBAL, RESULTS_PER_PAGE } from './config';

/**
 * A 200 that carries no result payload.
 *
 * This is the tier's only "we were refused or the page changed shape" signal, and it is
 * deliberately structural rather than a body-marker match: a successful BBB response
 * contains both the word "captcha" and a `challenge-platform` script tag, so no marker
 * grep can distinguish success from a challenge. Presence of a parseable payload can.
 */
export class MissingResultPayloadError extends Error {
  override readonly name = 'MissingResultPayloadError';
}

/**
 * One business as BBB returns it. Only the fields this tier reads are declared; the live
 * record carries ~30 more.
 */
export interface RawBbbResult {
  id?: unknown;
  businessId?: unknown;
  businessName?: unknown;
  address?: unknown;
  city?: unknown;
  state?: unknown;
  postalcode?: unknown;
  phone?: unknown;
  rating?: unknown;
  ratingScore?: unknown;
  bbbMember?: unknown;
  reportUrl?: unknown;
  tobText?: unknown;
  categories?: unknown;
  serviceAreasSummary?: unknown;
  outOfBusinessStatus?: unknown;
  location?: unknown;
}

export interface RawSearchPayload {
  page: number | null;
  pageSize: number | null;
  totalPages: number | null;
  totalResults: number | null;
  results: RawBbbResult[];
}

/**
 * Slices the JSON object literal that follows the global assignment.
 *
 * Regex is not an option: the payload is ~100 KB of nested JSON on one line, and the
 * terminating `}` cannot be found without tracking nesting and string state. A `JSON.parse`
 * on the sliced text is the validation — a mis-slice cannot parse.
 */
export function sliceStateLiteral(html: string): string | null {
  const marker = html.indexOf(PRELOADED_STATE_GLOBAL);
  if (marker < 0) return null;
  const assignment = html.indexOf('=', marker + PRELOADED_STATE_GLOBAL.length);
  if (assignment < 0) return null;
  const start = html.indexOf('{', assignment);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }
  return null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Parses a search response into its raw payload, or throws if it carries none. */
export function parseSearchPayload(html: string): RawSearchPayload {
  const literal = sliceStateLiteral(html);
  if (!literal) {
    throw new MissingResultPayloadError(
      `response carries no ${PRELOADED_STATE_GLOBAL} assignment — refused, or the page changed shape`,
    );
  }

  let state: unknown;
  try {
    state = JSON.parse(literal);
  } catch (cause) {
    throw new MissingResultPayloadError(
      `${PRELOADED_STATE_GLOBAL} did not parse as JSON: ${String(cause)}`,
    );
  }

  const searchResult = (state as { searchResult?: unknown }).searchResult;
  if (!searchResult || typeof searchResult !== 'object') {
    throw new MissingResultPayloadError('payload has no searchResult object');
  }

  const container = searchResult as Record<string, unknown>;
  const results = Array.isArray(container.results) ? (container.results as RawBbbResult[]) : null;
  if (!results) throw new MissingResultPayloadError('searchResult.results is not an array');

  return {
    page: asNumber(container.page),
    pageSize: asNumber(container.pageSize) ?? RESULTS_PER_PAGE,
    totalPages: asNumber(container.totalPages),
    totalResults: asNumber(container.totalResults),
    results,
  };
}

/**
 * Strips the `<em>` tags BBB wraps around the matched search term.
 *
 * A name-driven lookup for `JTO Roofing` comes back as
 * `<em>JTO</em> <em>Roofing</em> and Solar`. Left in place these tags end up in the stored
 * name and in every downstream join, and the same business harvested via two different
 * search terms would produce two different names.
 */
export function stripHighlightTags(value: string): string {
  return value
    .replace(/<\/?em>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The city a business is actually in, taken from its profile path.
 *
 * `reportUrl` looks like `/us/fl/sanford/profile/roofing-contractors/<slug>-<ids>`, and
 * segment 3 is the business's own city.
 *
 * This is preferred over the payload's `city`/`state` because those are not reliably the
 * business's: the same payload carries the *requester's* geolocation (observed as
 * `Ashburn, VA` from this egress), and confusing the two silently relocates every record.
 * The record-level `city` did agree with the path in the captures taken here, but "agreed
 * in the sample" is not a contract, and only one of the two fields cannot be anything else.
 */
export function cityFromReportUrl(reportUrl: string): { city: string | null; state: string | null } {
  const segments = reportUrl.split('/').filter((segment) => segment.length > 0);
  // ['us', 'fl', 'sanford', 'profile', ...]
  if (segments.length < 3 || segments[0]?.toLowerCase() !== 'us') {
    return { city: null, state: null };
  }
  const state = segments[1]?.toUpperCase() ?? null;
  const slug = segments[2] ?? '';
  if (!slug || slug === 'profile') return { city: null, state };
  const city = slug
    .split('-')
    .map((word) => (word ? word[0]?.toUpperCase() + word.slice(1) : word))
    .join(' ');
  return { city, state };
}

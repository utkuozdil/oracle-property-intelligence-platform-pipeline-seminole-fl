/**
 * The two-request DBPR download: prime a Cloudflare cookie, then fetch the file with it.
 *
 * **The first request is expected to return 403.** That is not a failure and must not be
 * retried as one — Cloudflare emits `Set-Cookie: __cf_bm` *alongside* the 403 challenge
 * page, and replaying that cookie on the CSV path returns 200. This was verified again on
 * 2026-09-01: prime returned 403 with a `__cf_bm`, and the CSV then returned 206 for a range
 * probe and 200 for the full 48,780,751-byte body.
 *
 * What was established by elimination, and therefore what this file does *not* do:
 *
 *  - The realistic User-Agent is not what makes it work. Once primed, `curl/8.7.1` also gets
 *    200. A browser agent is still sent, as manners rather than evasion.
 *  - The full browser header set is not required. `sec-ch-ua`, `sec-fetch-*` and friends made
 *    no difference; header fingerprinting is not the gate.
 *  - `HEAD` never succeeds, cookie or not. A `Range: bytes=0-0` GET is the cheap probe.
 *  - No browser, no JavaScript execution, and no challenge solving anywhere in this path.
 */
import {
  BROWSER_USER_AGENT,
  DBPR_LICENCE_CSV_URL,
  DBPR_PRIME_URL,
  DOWNLOAD_TIMEOUT_MS,
  MAX_FETCH_ATTEMPTS,
  MIN_PLAUSIBLE_CSV_BYTES,
  PRIME_DELAY_MS,
  PRIME_TIMEOUT_MS,
  RETRY_BASE_DELAY_MS,
} from './config';

/**
 * Cloudflare has escalated past the point where the cookie flow works.
 *
 * Distinct from a transient error on purpose: research showed the 403s stop carrying
 * `Set-Cookie` entirely once escalation kicks in, and that a ~150 second pause restores the
 * exact same flow. So the remedy is to back off and let the next scheduled run try, not to
 * keep asking.
 */
export class DbprThrottledError extends Error {
  override readonly name = 'DbprThrottledError';
  constructor(message: string) {
    super(`${message} — Cloudflare is throttling; backing off rather than grinding`);
  }
}

/** A transport-level failure worth another attempt. */
export class TransientRequestError extends Error {
  override readonly name = 'TransientRequestError';
}

/** The body came back but is not the extract. Never retried; the URL or layout changed. */
export class ImplausibleExtractError extends Error {
  override readonly name = 'ImplausibleExtractError';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headers(cookie?: string): Record<string, string> {
  const base: Record<string, string> = {
    'User-Agent': BROWSER_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (cookie !== undefined) {
    base.Cookie = cookie;
    base.Referer = DBPR_PRIME_URL;
  }
  return base;
}

/**
 * Extracts the cookies worth replaying from a `Set-Cookie` list.
 *
 * `__cf_bm` is the one that matters, but every cookie the host set is replayed: sending back
 * what a browser would is both more robust to Cloudflare adding a second cookie and less
 * clever than hand-picking one name.
 */
export function cookieHeaderFrom(setCookies: readonly string[]): string | null {
  const pairs: string[] = [];
  for (const line of setCookies) {
    const pair = line.split(';', 1)[0]?.trim();
    if (pair && pair.includes('=')) pairs.push(pair);
  }
  return pairs.length > 0 ? pairs.join('; ') : null;
}

/**
 * Visits the landing page to obtain `__cf_bm`.
 *
 * A 403 here is the success path. What is *not* survivable is a 403 with no cookie attached,
 * which is exactly what escalation looks like.
 */
export async function primeCookie(): Promise<string> {
  let response: Response;
  try {
    response = await fetch(DBPR_PRIME_URL, {
      headers: headers(),
      redirect: 'follow',
      signal: AbortSignal.timeout(PRIME_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new TransientRequestError(`priming ${DBPR_PRIME_URL} failed: ${String(cause)}`, {
      cause,
    });
  }
  // The challenge body is never parsed; only its cookie is wanted. Drained so the socket
  // can be reused rather than left dangling.
  await response.arrayBuffer().catch(() => undefined);

  const cookie = cookieHeaderFrom(response.headers.getSetCookie());
  if (cookie === null) {
    throw new DbprThrottledError(
      `prime returned ${response.status} with no Set-Cookie`,
    );
  }
  return cookie;
}

export interface ExtractDownload {
  bytes: Uint8Array;
  /** `Last-Modified` from the response — how fresh the *data* is, not the request. */
  lastModified: string | null;
  fetchedAt: string;
  durationMs: number;
  sourceUrl: string;
}

async function downloadOnce(cookie: string): Promise<ExtractDownload> {
  const startedAt = Date.now();
  const fetchedAt = new Date().toISOString();
  let response: Response;
  try {
    response = await fetch(DBPR_LICENCE_CSV_URL, {
      headers: headers(cookie),
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new TransientRequestError(
      `GET ${DBPR_LICENCE_CSV_URL} failed: ${String(cause)}`,
      { cause },
    );
  }

  if (response.status === 403 || response.status === 429) {
    throw new DbprThrottledError(
      `GET ${DBPR_LICENCE_CSV_URL} returned ${response.status} with a primed cookie`,
    );
  }
  if (response.status >= 500) {
    throw new TransientRequestError(`GET ${DBPR_LICENCE_CSV_URL} returned ${response.status}`);
  }
  if (!response.ok) {
    throw new ImplausibleExtractError(
      `GET ${DBPR_LICENCE_CSV_URL} returned ${response.status}; the extract URL may have moved`,
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  /**
   * A short body wearing a 200 is a challenge page or a truncated transfer. Parsing it would
   * yield a handful of records and then silently shrink the published dataset, so it fails
   * here instead.
   */
  if (bytes.byteLength < MIN_PLAUSIBLE_CSV_BYTES) {
    throw new ImplausibleExtractError(
      `${DBPR_LICENCE_CSV_URL} returned ${bytes.byteLength} bytes, below the ` +
        `${MIN_PLAUSIBLE_CSV_BYTES}-byte floor (48,780,751 observed on 2026-09-01)`,
    );
  }

  return {
    bytes,
    lastModified: response.headers.get('last-modified'),
    fetchedAt,
    durationMs: Date.now() - startedAt,
    sourceUrl: DBPR_LICENCE_CSV_URL,
  };
}

/**
 * The full flow, with bounded retries.
 *
 * The cookie is re-primed on every attempt rather than reused: a `__cf_bm` is short-lived,
 * and if an attempt failed the cookie is the most likely reason.
 */
export async function downloadExtract(
  options: { attempts?: number; primeDelayMs?: number } = {},
): Promise<ExtractDownload> {
  const attempts = options.attempts ?? MAX_FETCH_ATTEMPTS;
  const primeDelayMs = options.primeDelayMs ?? PRIME_DELAY_MS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const cookie = await primeCookie();
      // Makes the pair look like a page visit followed by a download rather than a scripted
      // burst, and costs nothing at two requests a week.
      await sleep(primeDelayMs);
      return await downloadOnce(cookie);
    } catch (error) {
      if (error instanceof ImplausibleExtractError) throw error;
      lastError = error;
      if (attempt === attempts) break;
      /**
       * Escalation is cleared by waiting, and ~150 seconds was enough in research. The
       * backoff starts at 30 s and doubles, so attempt three waits 60 s — well inside the
       * Lambda budget while still being a real pause.
       */
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * A cheap size and freshness probe, used by the local runner and available to a caller that
 * wants to know whether a download is worth 260 seconds.
 *
 * A `Range: bytes=0-0` GET rather than a `HEAD`, because `HEAD` never succeeds on this host.
 */
export async function probeExtract(): Promise<{
  status: number;
  totalBytes: number | null;
  lastModified: string | null;
}> {
  const cookie = await primeCookie();
  await sleep(PRIME_DELAY_MS);
  const response = await fetch(DBPR_LICENCE_CSV_URL, {
    headers: { ...headers(cookie), Range: 'bytes=0-0' },
    signal: AbortSignal.timeout(PRIME_TIMEOUT_MS),
  });
  await response.arrayBuffer().catch(() => undefined);
  const range = response.headers.get('content-range');
  const total = range ? Number(/\/(\d+)\s*$/.exec(range)?.[1] ?? Number.NaN) : Number.NaN;
  return {
    status: response.status,
    totalBytes: Number.isFinite(total) ? total : null,
    lastModified: response.headers.get('last-modified'),
  };
}

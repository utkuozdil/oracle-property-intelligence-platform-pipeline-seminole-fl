/**
 * The polite HTTP client both sources share.
 *
 * The politeness ceiling is a *rate* constraint, so it is enforced here, in the worker
 * process, and the CDK stack pins each worker's reserved concurrency to match. A
 * Distributed Map's `MaxConcurrency` is parallelism and cannot express this on its own:
 * two workers each making "two concurrent requests" is four requests at the portal.
 */
import {
  JITTER_RATIO,
  MAX_REQUEST_ATTEMPTS,
  REQUEST_TIMEOUT_MS,
  WAF_BLOCK_MARKERS,
  WAF_BLOCK_STATUSES,
} from './config';

/**
 * A block signature from the F5 BIG-IP ASM in front of Source B, or an equivalent refusal
 * from Source A.
 *
 * This is never retried. An F5 block can be sticky by source IP, so retrying into one
 * trades a slow sweep for an outage measured in hours.
 */
export class WafBlockedError extends Error {
  override readonly name = 'WafBlockedError';
  constructor(
    readonly url: string,
    readonly status: number,
    readonly marker: string | null,
  ) {
    super(
      `${url} returned a block signature (status ${status}${marker ? `, marker "${marker}"` : ''}) — ` +
        'stopping this worker rather than retrying into a sticky IP ban',
    );
  }
}

/** A transport-level failure that is worth another attempt. */
export class TransientRequestError extends Error {
  override readonly name = 'TransientRequestError';
}

/**
 * Source A is down daily 23:30–07:00 Eastern. A connection failure inside that window is
 * expected, and is surfaced as its own error so the caller can pause rather than page.
 */
export class SourceOfflineError extends Error {
  override readonly name = 'SourceOfflineError';
}

export interface FetchOutcome {
  status: number;
  /** Decoded body. Click2Gov serves ISO-8859-1 and mangles accented names as UTF-8. */
  body: string;
  headers: Headers;
  durationMs: number;
}

export type Encoding = 'utf-8' | 'latin1';

export function jitteredDelayMs(baseMs: number, random: () => number = Math.random): number {
  const spread = baseMs * JITTER_RATIO;
  return Math.max(0, Math.round(baseMs - spread + random() * spread * 2));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function blockMarkerIn(body: string): string | null {
  return WAF_BLOCK_MARKERS.find((marker) => body.includes(marker)) ?? null;
}

/**
 * One request, decoded and screened for block signatures.
 *
 * Every response is screened, not just the failures — an ASM block arrives as a 200 with
 * a rejection page as often as it arrives as a 403.
 */
export async function requestOnce(
  url: string,
  init: RequestInit,
  encoding: Encoding = 'utf-8',
): Promise<FetchOutcome> {
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (cause) {
    throw new TransientRequestError(`${init.method ?? 'GET'} ${url} failed: ${String(cause)}`, {
      cause,
    });
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const body = buffer.toString(encoding === 'latin1' ? 'latin1' : 'utf8');
  const durationMs = Date.now() - startedAt;

  const marker = blockMarkerIn(body);
  if (WAF_BLOCK_STATUSES.has(response.status) || marker) {
    throw new WafBlockedError(url, response.status, marker);
  }
  if (response.status >= 500) {
    throw new TransientRequestError(`${init.method ?? 'GET'} ${url} returned ${response.status}`);
  }
  if (!response.ok) {
    // 4xx that is not a block signature is a request-construction bug. Retrying an
    // identical malformed request just spends the portal's budget on the same mistake.
    throw new Error(`${init.method ?? 'GET'} ${url} returned ${response.status}`);
  }

  return { status: response.status, body, headers: response.headers, durationMs };
}

/**
 * A request with bounded retries and jittered backoff.
 *
 * `WafBlockedError` short-circuits: it is the one failure where trying again is worse than
 * giving up.
 */
export async function requestWithRetry(
  url: string,
  init: RequestInit,
  options: { encoding?: Encoding; baseDelayMs: number; attempts?: number } = { baseDelayMs: 500 },
): Promise<FetchOutcome> {
  const attempts = options.attempts ?? MAX_REQUEST_ATTEMPTS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestOnce(url, init, options.encoding);
    } catch (error) {
      if (error instanceof WafBlockedError) throw error;
      lastError = error;
      if (attempt === attempts) break;
      await sleep(jitteredDelayMs(options.baseDelayMs * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Runs `worker` over `items` with at most `limit` in flight, pausing `delayMs` (jittered)
 * before each task after the first.
 *
 * The pacing is per-slot rather than global, which keeps the request rate at roughly
 * `limit / delay` instead of letting all `limit` workers fire in lockstep.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  delayMs: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let failure: unknown;

  const slot = async (): Promise<void> => {
    while (failure === undefined) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      if (index >= limit) await sleep(jitteredDelayMs(delayMs));
      try {
        results[index] = await worker(items[index] as T, index);
      } catch (error) {
        // First failure wins and every other slot drains, so a WAF block stops the whole
        // batch instead of letting the remaining slots keep hammering.
        failure ??= error;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, slot));
  if (failure !== undefined) throw failure;
  return results;
}

/** A minimal cookie jar. Both portals key server-side state to a session cookie. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(headers: Headers): void {
    for (const raw of headers.getSetCookie()) {
      const pair = raw.split(';')[0] ?? '';
      const separator = pair.indexOf('=');
      if (separator > 0) {
        this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
      }
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  names(): string[] {
    return [...this.cookies.keys()];
  }
}

export function summariseLatency(samples: readonly number[]): {
  min: number;
  median: number;
  max: number;
} {
  if (samples.length === 0) return { min: 0, median: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    min: sorted[0] as number,
    median: sorted[Math.floor(sorted.length / 2)] as number,
    max: sorted[sorted.length - 1] as number,
  };
}

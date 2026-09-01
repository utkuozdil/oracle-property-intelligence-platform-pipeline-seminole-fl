/**
 * The polite HTTP client for the BBB tier.
 *
 * Deliberately a sibling of `src/permits/http.ts` rather than an import of it. The two
 * tiers screen responses on opposite principles — the permit portals announce a block in
 * the body, BBB does not and its body contains permanent false positives (see
 * `BLOCK_STATUSES` in `./config`) — so sharing one screening function would mean one
 * tier's marker list silently deciding the other's fate.
 */
import {
  BLOCK_STATUSES,
  BROWSER_USER_AGENT,
  JITTER_RATIO,
  MAX_REQUEST_ATTEMPTS,
  REQUEST_TIMEOUT_MS,
} from './config';

/** A refusal from BBB or the CDN in front of it. Never retried, to avoid earning a ban. */
export class BbbBlockedError extends Error {
  override readonly name = 'BbbBlockedError';
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(
      `${url} returned ${status} — stopping rather than retrying into a rate limit or ban`,
    );
  }
}

/** A transport-level failure that is worth another attempt. */
export class TransientRequestError extends Error {
  override readonly name = 'TransientRequestError';
}

export interface FetchOutcome {
  status: number;
  body: string;
  durationMs: number;
}

export function jitteredDelayMs(baseMs: number, random: () => number = Math.random): number {
  const spread = baseMs * JITTER_RATIO;
  return Math.max(0, Math.round(baseMs - spread + random() * spread * 2));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function searchHeaders(): Record<string, string> {
  return {
    'User-Agent': BROWSER_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
}

export async function requestOnce(url: string): Promise<FetchOutcome> {
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: searchHeaders(),
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new TransientRequestError(`GET ${url} failed: ${String(cause)}`, { cause });
  }

  const body = await response.text();
  const durationMs = Date.now() - startedAt;

  if (BLOCK_STATUSES.has(response.status)) throw new BbbBlockedError(url, response.status);
  if (response.status >= 500) {
    throw new TransientRequestError(`GET ${url} returned ${response.status}`);
  }
  if (!response.ok) {
    // A 4xx that is not a refusal is a malformed request. Retrying spends BBB's budget on
    // the same mistake.
    throw new Error(`GET ${url} returned ${response.status}`);
  }

  return { status: response.status, body, durationMs };
}

/** A request with bounded retries and exponential, jittered backoff. */
export async function requestWithRetry(
  url: string,
  options: { baseDelayMs?: number; attempts?: number } = {},
): Promise<FetchOutcome> {
  const attempts = options.attempts ?? MAX_REQUEST_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestOnce(url);
    } catch (error) {
      if (error instanceof BbbBlockedError) throw error;
      lastError = error;
      if (attempt === attempts) break;
      await sleep(jitteredDelayMs(baseDelayMs * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Runs `worker` over `items` with at most `limit` in flight, pausing `delayMs` (jittered)
 * before each task after the first `limit`.
 *
 * At `limit: 1` this is a strictly sequential ~1 req/s loop, which is what this tier uses.
 * The generality is kept so the pacing is expressed in one place if the ceiling ever moves.
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
        // First failure wins and the other slots drain, so a block stops the whole batch
        // instead of letting the remaining slots keep requesting.
        failure ??= error;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, slot));
  if (failure !== undefined) throw failure;
  return results;
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

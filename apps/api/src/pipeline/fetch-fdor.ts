import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import middy from '@middy/core';
import {
  FDOR_COUNTY_CODE,
  FDOR_FETCH_CONCURRENCY,
  FDOR_FIELDS,
  FDOR_LAYER_URL,
  FDOR_POINTER_KEY,
  FDOR_RECORD_COUNT_MAX,
  FDOR_RECORD_COUNT_MIN,
  FDOR_SOURCE_NAME,
  FDOR_USER_AGENT,
  fdorQueryUrl,
  fdorSnapshotPrefix,
  fdorSnapshotToken,
  fdorWindowWhere,
  METRIC_ITEMS,
  objectIdWindows,
  type ObjectIdWindow,
  fdorWindowKey,
} from '@oracle-seminole/shared';
import {
  completeSourceSnapshot,
  getSourceSnapshot,
  putSourceSnapshotPending,
} from '../lib/source-ledger';
import { logger, metrics, recordWork, tracer } from '../observability';

/**
 * Acquires the FDOR cadastral-centroid snapshot — the second parcel source — into
 * `raw/fdor/<runId>/`, or decides the snapshot already in force will do.
 *
 * This mirrors `FetchRoll`'s ledger discipline but inverts its urgency. CAMA is rebuilt
 * nightly and its acquisition is the run; FDOR is republished **once a year, each
 * August**, so on 364 nights out of 365 the correct outcome is "nothing changed, keep
 * using the snapshot on disk". That makes two things non-negotiable:
 *
 * 1. **This step may never gate the CAMA run.** An unchanged snapshot is the normal
 *    case and returns the existing prefix. An unreachable service returns the existing
 *    prefix too — the state machine catches the failure and carries on, because a
 *    reconciliation report is a cross-check on the night's parcels, not a precondition
 *    for producing them.
 * 2. **The pointer, not the run id, names the snapshot.** A run that did not fetch has
 *    no snapshot of its own, so `raw/fdor/current.json` is what tells the transform
 *    where to read. It is written last, after every window is durable.
 *
 * The paging strategy is the other load-bearing decision, and it is not the obvious one.
 * See {@link objectIdWindows}: `resultOffset` degrades to ~51 s/page by offset 80k on
 * this service and extrapolates past an hour, while `OBJECTID` windows pull the whole
 * county in ~65 s.
 */

const s3 = tracer.captureAWSv3Client(new S3Client({}));

const DATA_BUCKET = process.env.DATA_BUCKET ?? '';

/** One request budget. The service answers a 1,500-id window in well under a second. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Attempts per window before the acquisition is abandoned. Zero were needed when measured. */
const MAX_WINDOW_ATTEMPTS = 4;

export interface FetchFdorInput {
  runId: string;
  /** `{"forceFdor": true}` re-acquires a snapshot the ledger already holds. */
  executionInput?: { forceFdor?: boolean };
}

export interface FetchFdorOutput {
  runId: string;
  /** True when no bytes were downloaded, which is the expected outcome on most nights. */
  skipped: boolean;
  skipReason: 'unchanged-snapshot' | null;
  /**
   * S3 prefix this run's snapshot landed under, or the prefix the pointer already names
   * when nothing was fetched. Reported for the run record only — the transform resolves
   * the snapshot through the pointer rather than through this field, so a failed fetch
   * degrades to "reconcile against the snapshot in force" rather than to nothing.
   */
  snapshotPrefix: string;
  snapshotToken: string;
  recordCount: number;
  requestCount: number;
  downloadedBytes: number;
  durationMs: number;
}

class FdorSourceError extends Error {
  override readonly name = 'FdorSourceError';
}

/** Shape of `raw/fdor/current.json`. */
interface FdorPointer {
  runId: string;
  snapshotToken: string;
  prefix: string;
  recordCount: number;
  windowCount: number;
  acquiredAt: string;
}

interface EsriResponse {
  features?: unknown[];
  exceededTransferLimit?: boolean;
  error?: { code?: number; message?: string };
}


async function getJson<T>(url: string): Promise<{ parsed: T; bytes: number }> {
  const response = await fetch(url, {
    headers: { 'User-Agent': FDOR_USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new FdorSourceError(`GET ${url} returned ${response.status} ${response.statusText}`);
  }

  // Read as text rather than `.json()` so the transferred size is measurable, which is
  // what the 124 MiB budget in the findings doc is stated against.
  const text = await response.text();
  let parsed: T;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    throw new FdorSourceError(`GET ${url} returned ${text.length} bytes that are not JSON`);
  }

  // ArcGIS answers a malformed query with HTTP 200 and an `error` object. Treating that
  // as success would land an empty window and understate the county by 1,500 parcels.
  const asError = (parsed as { error?: { code?: number; message?: string } }).error;
  if (asError) {
    throw new FdorSourceError(
      `GET ${url} returned an ArcGIS error ${asError.code ?? '?'}: ${asError.message ?? 'unknown'}`,
    );
  }

  return { parsed, bytes: Buffer.byteLength(text) };
}

/** The layer's own `editingInfo.lastEditDate`, which is what a republish moves. */
async function readLastEditDate(): Promise<number> {
  const { parsed } = await getJson<{ editingInfo?: { lastEditDate?: number } }>(
    `${FDOR_LAYER_URL}?f=json`,
  );
  const lastEditDate = parsed.editingInfo?.lastEditDate;
  if (typeof lastEditDate !== 'number') {
    throw new FdorSourceError('layer metadata carries no editingInfo.lastEditDate');
  }
  return lastEditDate;
}

async function readCountyRecordCount(): Promise<number> {
  const { parsed } = await getJson<{ count?: number }>(
    fdorQueryUrl({
      where: `CO_NO=${FDOR_COUNTY_CODE}`,
      returnCountOnly: 'true',
      f: 'json',
    }),
  );
  const count = parsed.count;
  if (typeof count !== 'number' || count <= 0) {
    throw new FdorSourceError(`county record count came back as ${String(count)}`);
  }
  if (count < FDOR_RECORD_COUNT_MIN || count > FDOR_RECORD_COUNT_MAX) {
    throw new FdorSourceError(
      `CO_NO=${FDOR_COUNTY_CODE} returned ${count.toLocaleString()} records, outside the ` +
        `expected ${FDOR_RECORD_COUNT_MIN.toLocaleString()}-${FDOR_RECORD_COUNT_MAX.toLocaleString()} ` +
        'band — the layer was republished with a different shape, or CO_NO was remapped',
    );
  }
  return count;
}

/**
 * Re-derive the county's `OBJECTID` bounds rather than hardcoding them.
 *
 * The layer is republished annually and ids are reassigned when it is, so last year's
 * range would silently truncate the county — a smaller output that still looks complete.
 */
async function readObjectIdBounds(): Promise<{ lo: number; hi: number }> {
  const { parsed } = await getJson<{ features?: { attributes?: { lo?: number; hi?: number } }[] }>(
    fdorQueryUrl({
      where: `CO_NO=${FDOR_COUNTY_CODE}`,
      outStatistics: JSON.stringify([
        { statisticType: 'min', onStatisticField: 'OBJECTID', outStatisticFieldName: 'lo' },
        { statisticType: 'max', onStatisticField: 'OBJECTID', outStatisticFieldName: 'hi' },
      ]),
      f: 'json',
    }),
  );

  const { lo, hi } = parsed.features?.[0]?.attributes ?? {};
  if (typeof lo !== 'number' || typeof hi !== 'number') {
    throw new FdorSourceError('OBJECTID min/max statistics came back without both bounds');
  }
  return { lo, hi };
}

function windowUrl(window: ObjectIdWindow, resultOffset?: number): string {
  return fdorQueryUrl({
    where: fdorWindowWhere(window),
    outFields: FDOR_FIELDS.join(','),
    returnGeometry: 'true',
    outSR: '4326',
    f: 'json',
    ...(resultOffset === undefined ? {} : { resultOffset: String(resultOffset) }),
  });
}

interface WindowResult {
  index: number;
  key: string;
  features: number;
  bytes: number;
  requests: number;
}

/**
 * Fetch one window, store it verbatim, and report what it held.
 *
 * The raw Esri JSON is stored exactly as served — no reshaping, no field renaming — so
 * the S3 object is a provenance record of what the service said, and every
 * interpretation of it happens once, in the Glue transform.
 *
 * A window that reports `exceededTransferLimit` sub-pages on `resultOffset`. That never
 * fired on the measured run — a 1,500-wide window cannot exceed the 2,000 ceiling at
 * current id density — but a republish that packs ids more tightly would make it fire,
 * and silently dropping the overflow is the one failure here that would not announce
 * itself.
 */
async function fetchWindow(
  runId: string,
  window: ObjectIdWindow,
  index: number,
): Promise<WindowResult> {
  const pages: string[] = [];
  let features = 0;
  let bytes = 0;
  let requests = 0;
  let offset: number | undefined;

  /** One page with bounded retry. Every attempt is counted, so `requests` stays honest. */
  async function request(): Promise<{ parsed: EsriResponse; bytes: number }> {
    for (let attempt = 1; ; attempt += 1) {
      requests += 1;
      try {
        return await getJson<EsriResponse>(windowUrl(window, offset));
      } catch (error) {
        if (attempt >= MAX_WINDOW_ATTEMPTS) throw error;
        logger.warn('FDOR window failed; retrying', {
          runId,
          window: `${window.lo}..${window.hi}`,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      }
    }
  }

  for (;;) {
    const page = await request();
    const count = page.parsed.features?.length ?? 0;
    features += count;
    bytes += page.bytes;
    pages.push(JSON.stringify(page.parsed));

    if (!page.parsed.exceededTransferLimit) break;

    offset = (offset ?? 0) + count;
    logger.warn('FDOR window exceeded the transfer limit; sub-paging on resultOffset', {
      runId,
      window: `${window.lo}..${window.hi}`,
      resultOffset: offset,
    });
    if (count === 0) {
      throw new FdorSourceError(
        `window ${window.lo}..${window.hi} reported exceededTransferLimit with no features`,
      );
    }
  }

  const key = fdorWindowKey(runId, index);
  await s3.send(
    new PutObjectCommand({
      Bucket: DATA_BUCKET,
      Key: key,
      // One JSON document per line when a window sub-paged, so Spark reads the prefix as
      // a set of Esri responses either way and no page is lost to a nested wrapper.
      Body: pages.join('\n'),
      ContentType: 'application/json',
      Metadata: {
        'run-id': runId,
        'objectid-lo': String(window.lo),
        'objectid-hi': String(window.hi),
        'feature-count': String(features),
      },
    }),
  );

  return { index, key, features, bytes, requests };
}

/** Run `tasks` with at most `limit` in flight, preserving nothing but the results. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;

  async function drain(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item, index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, drain));
  return results;
}

async function readPointer(): Promise<FdorPointer | null> {
  try {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: DATA_BUCKET, Key: FDOR_POINTER_KEY }),
    );
    const body = await response.Body?.transformToString();
    return body ? (JSON.parse(body) as FdorPointer) : null;
  } catch {
    // Absence is the first-run state, not an error.
    return null;
  }
}

async function baseHandler(event: FetchFdorInput): Promise<FetchFdorOutput> {
  return recordWork(METRIC_ITEMS.run, async () => {
    const startedAt = Date.now();
    const lastEditDate = await readLastEditDate();
    const recordCount = await readCountyRecordCount();
    const snapshotToken = fdorSnapshotToken(lastEditDate, recordCount);

    if (!event.executionInput?.forceFdor) {
      const previous = await getSourceSnapshot(FDOR_SOURCE_NAME, snapshotToken);
      const pointer = previous?.status === 'COMPLETED' ? await readPointer() : null;

      // Both have to agree. A completed ledger row with no matching pointer means the
      // snapshot it refers to is not findable, and re-acquiring costs 65 seconds once
      // a year — cheap next to reconciling against a prefix that may not exist.
      if (pointer?.snapshotToken === snapshotToken) {
        logger.info('FDOR layer unchanged since the last acquisition; reusing its snapshot', {
          runId: event.runId,
          snapshotToken,
          snapshotPrefix: pointer.prefix,
          acquiredBy: pointer.runId,
        });
        return {
          runId: event.runId,
          skipped: true,
          skipReason: 'unchanged-snapshot',
          snapshotPrefix: pointer.prefix,
          snapshotToken,
          recordCount: pointer.recordCount,
          requestCount: 2,
          downloadedBytes: 0,
          durationMs: Date.now() - startedAt,
        };
      }
    }

    const { lo, hi } = await readObjectIdBounds();
    const windows = objectIdWindows(lo, hi);
    if (windows.length === 0) {
      throw new FdorSourceError(`OBJECTID bounds ${lo}..${hi} produced no windows`);
    }

    logger.info('Acquiring the FDOR snapshot', {
      runId: event.runId,
      snapshotToken,
      recordCount,
      objectIdRange: `${lo}..${hi}`,
      windows: windows.length,
    });

    const results = await mapWithConcurrency(windows, FDOR_FETCH_CONCURRENCY, (window, index) =>
      fetchWindow(event.runId, window, index),
    );

    const features = results.reduce((total, result) => total + result.features, 0);
    const downloadedBytes = results.reduce((total, result) => total + result.bytes, 0);
    // 3 for the metadata, count, and statistics calls that preceded the windows.
    const requestCount = results.reduce((total, result) => total + result.requests, 3);

    // The count query and the windows are two independent traversals of the same
    // predicate, so a disagreement means the windows did not cover the county — an
    // OBJECTID range that moved mid-fetch, or a window that returned short without
    // saying so. Either way the snapshot is incomplete and must not become the pointer.
    if (features !== recordCount) {
      throw new FdorSourceError(
        `windowed fetch returned ${features.toLocaleString()} features but the county holds ` +
          `${recordCount.toLocaleString()} — the snapshot is incomplete`,
      );
    }

    const prefix = fdorSnapshotPrefix(event.runId);
    const pointer: FdorPointer = {
      runId: event.runId,
      snapshotToken,
      prefix,
      recordCount,
      windowCount: windows.length,
      acquiredAt: new Date().toISOString(),
    };

    await putSourceSnapshotPending(FDOR_SOURCE_NAME, snapshotToken, {
      runId: event.runId,
      fingerprint: snapshotToken,
      contentLength: downloadedBytes,
      lastModified: new Date(lastEditDate).toISOString(),
      force: event.executionInput?.forceFdor,
    });

    // Only after every window is durable, and in one PutObject: a reader sees either the
    // previous snapshot or this one, never a prefix that is still filling.
    await s3.send(
      new PutObjectCommand({
        Bucket: DATA_BUCKET,
        Key: FDOR_POINTER_KEY,
        Body: JSON.stringify(pointer),
        ContentType: 'application/json',
      }),
    );

    /**
     * Closed here rather than by `RecordRun`, which is where the CAMA snapshot is closed.
     *
     * The two have different definitions of done. A CAMA snapshot is not ingested until
     * the transform has published its parcels, so a mid-transform crash must leave it
     * reopenable. An FDOR snapshot's entire contribution is the bytes on S3 — the
     * reconciliation that reads them is advisory and explicitly may not gate the run —
     * so once the pointer is written there is nothing a later failure could undo.
     */
    await completeSourceSnapshot(FDOR_SOURCE_NAME, snapshotToken, {
      runId: event.runId,
      parcelCount: recordCount,
    });

    const durationMs = Date.now() - startedAt;
    logger.info('Stored the FDOR snapshot', {
      runId: event.runId,
      snapshotPrefix: prefix,
      recordCount,
      windows: windows.length,
      requestCount,
      downloadedBytes,
      durationMs,
    });

    return {
      runId: event.runId,
      skipped: false,
      skipReason: null,
      snapshotPrefix: prefix,
      snapshotToken,
      recordCount,
      requestCount,
      downloadedBytes,
      durationMs,
    };
  });
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));

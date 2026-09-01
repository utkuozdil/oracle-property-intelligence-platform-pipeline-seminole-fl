import { createHash } from 'node:crypto';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ListExecutionsCommand, SFNClient } from '@aws-sdk/client-sfn';
import middy from '@middy/core';
import {
  METRIC_ITEMS,
  rawArchiveKey,
  SOURCE_NAME,
  SOURCE_URL,
  SOURCE_USER_AGENT,
} from '@oracle-seminole/shared';
import { logger, metrics, recordWork, tracer } from '../observability';
import { getSourceSnapshot, putSourceSnapshotPending } from '../lib/source-ledger';

/**
 * Acquires the nightly CAMA archive into `raw/<runId>/`, or decides not to.
 *
 * Three things stop work from being repeated, in increasing cost order:
 *
 * 1. **The ETag ledger.** If a completed run already ingested this ETag, there is
 *    nothing to do. The source's ETag is IIS-style — a rebuild timestamp, not a content
 *    digest — so a *changed* ETag only means "maybe changed" and the row-hash diff in the
 *    Glue job gives the true delta. But an *unchanged* ETag is conclusive: the file was
 *    not rebuilt, so skipping is safe.
 * 2. **A running twin.** A second execution started while this one is mid-flight would
 *    re-download the same 95 MB and race the atomic manifest swap. The running execution
 *    is its own lock; `ListExecutions` is how this one finds it.
 * 3. **The download itself**, which only happens once both checks pass.
 *
 * The `Content-Length` and `ETag` come from the cost gate's `HEAD`, so this step makes
 * exactly one further request against the county's web server.
 */

const s3 = tracer.captureAWSv3Client(new S3Client({}));
const sfn = tracer.captureAWSv3Client(new SFNClient({}));

const DATA_BUCKET = process.env.DATA_BUCKET ?? '';
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN ?? '';

export interface FetchRollInput {
  runId: string;
  source: {
    url: string;
    etag: string | null;
    lastModified: string | null;
    contentLength: number;
  };
  /**
   * The execution's raw input. `{"force": true}` re-ingests an ETag the ledger already
   * holds, which is the only way to re-run a night whose source has not been rebuilt —
   * needed after a transform change, when the same bytes must produce new output.
   */
  executionInput?: { force?: boolean };
}

export interface FetchRollOutput {
  runId: string;
  skipped: boolean;
  skipReason: 'unchanged-etag' | 'concurrent-execution' | null;
  archiveKey: string | null;
  sourceEtag: string;
  sourceLastModified: string;
  /** SHA-256 of the downloaded bytes. Unlike the ETag, a real function of the content. */
  sourceFingerprint: string;
  downloadedBytes: number;
  /** Stringified: Glue job arguments are strings, and the transform parses it. */
  snapshotYear: string;
}

class SourceDownloadError extends Error {
  override readonly name = 'SourceDownloadError';
}

/**
 * True when another execution of this state machine is already running.
 *
 * Only executions that started strictly earlier count, so the pair cannot both stand
 * down and leave the night unprocessed — the older one always proceeds.
 */
async function hasRunningTwin(runId: string): Promise<boolean> {
  if (!STATE_MACHINE_ARN) return false;

  const { executions = [] } = await sfn.send(
    new ListExecutionsCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      statusFilter: 'RUNNING',
      maxResults: 50,
    }),
  );

  const self = executions.find((execution) => execution.name === runId);
  const selfStartedAt = self?.startDate?.getTime() ?? Number.POSITIVE_INFINITY;

  return executions.some(
    (execution) =>
      execution.name !== runId && (execution.startDate?.getTime() ?? 0) < selfStartedAt,
  );
}

async function download(): Promise<{ body: Buffer; etag: string | null }> {
  const response = await fetch(SOURCE_URL, {
    headers: { 'User-Agent': SOURCE_USER_AGENT, Accept: '*/*' },
    // The archive is ~95 MB from a county web server; it is not fast, but a request
    // still in flight after five minutes is hung rather than slow.
    signal: AbortSignal.timeout(300_000),
  });

  if (!response.ok) {
    throw new SourceDownloadError(
      `GET ${SOURCE_URL} returned ${response.status} ${response.statusText}`,
    );
  }
  if (!response.body) {
    throw new SourceDownloadError(`GET ${SOURCE_URL} returned no body`);
  }

  return {
    body: Buffer.from(await response.arrayBuffer()),
    etag: response.headers.get('etag'),
  };
}

async function baseHandler(event: FetchRollInput): Promise<FetchRollOutput> {
  return recordWork(METRIC_ITEMS.run, async () => {
    const declaredEtag = event.source.etag ?? '';
    const snapshotYear = String(new Date().getUTCFullYear());

    const skipped = (
      skipReason: 'unchanged-etag' | 'concurrent-execution',
    ): FetchRollOutput => ({
      runId: event.runId,
      skipped: true,
      skipReason,
      archiveKey: null,
      sourceEtag: declaredEtag,
      sourceLastModified: event.source.lastModified ?? '',
      sourceFingerprint: '',
      downloadedBytes: 0,
      snapshotYear,
    });

    if (!event.executionInput?.force && declaredEtag) {
      const previous = await getSourceSnapshot(SOURCE_NAME, declaredEtag);
      if (previous?.status === 'COMPLETED') {
        logger.info('Source unchanged since the last completed run; skipping', {
          runId: event.runId,
          etag: declaredEtag,
          previousRunId: previous.runId,
        });
        return skipped('unchanged-etag');
      }
    }

    if (await hasRunningTwin(event.runId)) {
      logger.warn('Another execution is already ingesting; standing down', {
        runId: event.runId,
      });
      return skipped('concurrent-execution');
    }

    const { body } = await download();

    // Validate the delivered object against what the HEAD promised. A truncated
    // download is a complete-looking ZIP whose last member is corrupt, and it would
    // otherwise surface three joins later as an unexplained row-count assertion.
    if (body.byteLength !== event.source.contentLength) {
      throw new SourceDownloadError(
        `downloaded ${body.byteLength} bytes but HEAD promised ${event.source.contentLength}`,
      );
    }

    const sourceFingerprint = createHash('sha256').update(body).digest('hex');
    const archiveKey = rawArchiveKey(event.runId);

    await s3.send(
      new PutObjectCommand({
        Bucket: DATA_BUCKET,
        Key: archiveKey,
        Body: body,
        ContentType: 'application/zip',
        // Carried on the object so the archive can be traced back to its source headers
        // without reading the run manifest.
        Metadata: {
          'source-etag': declaredEtag,
          'source-fingerprint': sourceFingerprint,
          'run-id': event.runId,
        },
      }),
    );

    // Claim the ETag before the transform starts. A crash between here and completion
    // leaves a PENDING row, which does not suppress the next run — only COMPLETED does.
    const claim = await putSourceSnapshotPending(SOURCE_NAME, declaredEtag, {
      runId: event.runId,
      fingerprint: sourceFingerprint,
      contentLength: body.byteLength,
      lastModified: event.source.lastModified ?? '',
      force: event.executionInput?.force,
    });

    if (claim === 'ALREADY_COMPLETED') {
      // Another execution closed this snapshot between the ledger read above and this
      // write. The archive just downloaded is redundant, so stop rather than transform it.
      logger.warn('Snapshot was completed by another execution mid-flight; standing down', {
        runId: event.runId,
        sourceEtag: declaredEtag,
      });
      return {
        runId: event.runId,
        skipped: true,
        skipReason: 'concurrent-execution',
        archiveKey: null,
        sourceEtag: declaredEtag,
        sourceLastModified: event.source.lastModified ?? '',
        sourceFingerprint: '',
        downloadedBytes: body.byteLength,
        snapshotYear,
      };
    }

    logger.info('Stored source archive', {
      runId: event.runId,
      archiveKey,
      bytes: body.byteLength,
      sourceFingerprint,
    });

    return {
      runId: event.runId,
      skipped: false,
      skipReason: null,
      archiveKey,
      sourceEtag: declaredEtag,
      sourceLastModified: event.source.lastModified ?? '',
      sourceFingerprint,
      downloadedBytes: body.byteLength,
      snapshotYear,
    };
  });
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));

import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import middy from '@middy/core';
import {
  changeSetKey,
  COUNTY,
  METRIC_ITEMS,
  runKey,
  SOURCE_NAME,
  STAGED_PARCELS_PREFIX,
} from '@oracle-seminole/shared';
import { z } from 'zod';
import { completeSourceSnapshot } from '../lib/source-ledger';
import { logger, metrics, recordWork, tracer } from '../observability';

/**
 * Closes out a run: validate what the transform claims it produced, confirm the output
 * is really in S3, record the run, and close the snapshot in the idempotency ledger.
 *
 * The transform is a separate runtime writing to a shared bucket, so its `change_set.json`
 * is treated as an untrusted response rather than as a return value. It is schema-checked
 * with Zod and then cross-checked against an actual listing of the staged prefix, because
 * a Glue job can succeed, write a manifest, and still have produced nothing — and a run
 * that reports success on an empty prefix is the one failure mode nobody notices.
 */

const s3 = tracer.captureAWSv3Client(new S3Client({}));
const ddb = DynamoDBDocumentClient.from(tracer.captureAWSv3Client(new DynamoDBClient({})), {
  marshallOptions: { removeUndefinedValues: true },
});

const DATA_BUCKET = process.env.DATA_BUCKET ?? '';
const TABLE_NAME = process.env.TABLE_NAME ?? '';

/** Mirrors `build_change_set_document` in `oracle_pipeline/change_set.py`. */
const ChangeSet = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  county: z.string().min(1),
  source: z.object({
    url: z.string().url(),
    etag: z.string().nullable(),
    lastModified: z.string().nullable(),
    fingerprint: z.string().min(1),
  }),
  snapshotYear: z.number().int(),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  counts: z.object({
    new: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    'missing-on-source': z.number().int().nonnegative(),
  }),
  totals: z.object({
    prior: z.number().int().nonnegative(),
    current: z.number().int().positive(),
    actionable: z.number().int().nonnegative(),
  }),
  output: z.object({
    stagedPrefix: z.string().min(1),
    format: z.literal('parquet'),
    partitionedBy: z.array(z.string()),
    partitionCount: z.number().int().positive(),
  }),
});

type ChangeSet = z.infer<typeof ChangeSet>;

export interface RecordRunInput {
  runId: string;
  skipped?: boolean;
  skipReason?: string | null;
  sourceEtag?: string;
  /**
   * The execution's raw input, from which the publish decision is read.
   *
   * Publishing is the default, and opting out requires `{"publish": false}`. The opposite
   * default is what left `publish/` empty behind two successful executions: a run that
   * stages but does not publish looks, from the outside, exactly like one that finished
   * the job. Opting out is now explicit, announced on the operations topic, and visible
   * in the execution output.
   */
  executionInput?: { publish?: boolean };
}

export interface RecordRunOutput {
  runId: string;
  county: string;
  status: 'COMPLETED' | 'SKIPPED';
  parcelCount: number;
  partitionCount: number;
  counts: ChangeSet['counts'] | null;
  publishApproved: boolean;
  publishDecision: string;
  recordedAt: string;
}

class TransformOutputError extends Error {
  override readonly name = 'TransformOutputError';
}

async function readChangeSet(runId: string): Promise<ChangeSet> {
  const key = changeSetKey(runId);
  const response = await s3.send(new GetObjectCommand({ Bucket: DATA_BUCKET, Key: key }));
  const body = await response.Body?.transformToString();

  if (!body) {
    throw new TransformOutputError(`change set at ${key} is empty`);
  }

  const parsed = ChangeSet.safeParse(JSON.parse(body));
  if (!parsed.success) {
    throw new TransformOutputError(
      `change set at ${key} does not match the contract: ${parsed.error.message}`,
    );
  }
  if (parsed.data.runId !== runId) {
    throw new TransformOutputError(
      `change set at ${key} belongs to run ${parsed.data.runId}, not ${runId}`,
    );
  }
  return parsed.data;
}

/**
 * Confirm the staged prefix actually holds Parquet under `geohash5=` partitions.
 *
 * Listing one page is enough: the question is "did the writer produce partitioned
 * Parquet at all", not "are all N partitions present".
 */
async function assertStagedOutputExists(): Promise<number> {
  const { Contents = [] } = await s3.send(
    new ListObjectsV2Command({
      Bucket: DATA_BUCKET,
      Prefix: STAGED_PARCELS_PREFIX,
      MaxKeys: 200,
    }),
  );

  const parquet = Contents.filter(
    (object) => object.Key?.includes('geohash5=') && object.Key.endsWith('.parquet'),
  );

  if (parquet.length === 0) {
    throw new TransformOutputError(
      `no geohash5-partitioned Parquet found under s3://${DATA_BUCKET}/${STAGED_PARCELS_PREFIX} ` +
        '— the transform reported success but produced no output',
    );
  }
  return parquet.length;
}

async function baseHandler(event: RecordRunInput): Promise<RecordRunOutput> {
  return recordWork(METRIC_ITEMS.run, async () => {
    const recordedAt = new Date().toISOString();

    // A skipped run is a successful outcome, not a failure: the source had not changed.
    if (event.skipped) {
      logger.info('Run skipped; nothing to record', {
        runId: event.runId,
        skipReason: event.skipReason,
      });
      return {
        runId: event.runId,
        county: COUNTY,
        status: 'SKIPPED' as const,
        parcelCount: 0,
        partitionCount: 0,
        counts: null,
        publishApproved: false,
        // There is no new snapshot to publish, so this is not a withheld publish and
        // does not need announcing — the previous snapshot is still the current one.
        publishDecision: `no new snapshot (${event.skipReason ?? 'skipped'})`,
        recordedAt,
      };
    }

    const changeSet = await readChangeSet(event.runId);
    const objectsSeen = await assertStagedOutputExists();

    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...runKey(event.runId),
          county: COUNTY,
          phase: 'phase-1',
          status: 'COMPLETED',
          parcelCount: changeSet.totals.current,
          partitionCount: changeSet.output.partitionCount,
          counts: changeSet.counts,
          sourceEtag: changeSet.source.etag,
          sourceFingerprint: changeSet.source.fingerprint,
          snapshotYear: changeSet.snapshotYear,
          stagedPrefix: changeSet.output.stagedPrefix,
          startedAt: changeSet.startedAt,
          finishedAt: changeSet.finishedAt,
          recordedAt,
        },
      }),
    );

    // Closing the snapshot is the last thing that happens, so the ETag only suppresses a
    // future download once the output behind it is proven to exist.
    if (event.sourceEtag) {
      await completeSourceSnapshot(SOURCE_NAME, event.sourceEtag, {
        runId: event.runId,
        parcelCount: changeSet.totals.current,
      });
    }

    // Run-level rollups of a delta that is only known once, at the end. The per-parcel
    // counter is emitted by the Glue executors during the transform, not here.
    metrics.addMetric('ParcelsNew', MetricUnit.Count, changeSet.counts.new);
    metrics.addMetric('ParcelsChanged', MetricUnit.Count, changeSet.counts.changed);
    metrics.addMetric('ParcelsUnchanged', MetricUnit.Count, changeSet.counts.unchanged);
    metrics.addMetric(
      'ParcelsMissingOnSource',
      MetricUnit.Count,
      changeSet.counts['missing-on-source'],
    );

    const publishApproved = event.executionInput?.publish !== false;

    logger.info('Recorded ingestion run', {
      runId: event.runId,
      parcelCount: changeSet.totals.current,
      partitionCount: changeSet.output.partitionCount,
      objectsSeen,
      counts: changeSet.counts,
      publishApproved,
    });

    return {
      runId: event.runId,
      county: COUNTY,
      status: 'COMPLETED' as const,
      parcelCount: changeSet.totals.current,
      partitionCount: changeSet.output.partitionCount,
      counts: changeSet.counts,
      publishApproved,
      publishDecision: publishApproved
        ? 'publishing: completed run, no opt-out'
        : 'withheld: execution input set publish=false',
      recordedAt,
    };
  });
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));

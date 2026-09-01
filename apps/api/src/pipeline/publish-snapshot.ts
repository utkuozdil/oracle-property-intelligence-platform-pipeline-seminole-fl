import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import {
  CopyObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type _Object,
} from '@aws-sdk/client-s3';
import middy from '@middy/core';
import {
  changeSetKey,
  COUNTY,
  publishedChangeSetKey,
  publishedSnapshotPrefix,
  PUBLISH_POINTER_KEY,
  STAGED_PARCELS_PREFIX,
} from '@oracle-seminole/shared';
import { logger, metrics, tracer } from '../observability';

/**
 * Promotes a staged snapshot into `publish/`, then proves it landed.
 *
 * Copy rather than rewrite: the Parquet in `staged/parcels/` is already the artifact, so
 * this is a server-side `CopyObject` per part. The bytes never enter the Lambda, which is
 * why 39 MB across 56 objects finishes in seconds and why this does not need to be a
 * Distributed Map or a second Glue job. If the snapshot grew past a few thousand objects
 * that calculus would change and this should become a Distributed Map over the listing.
 *
 * Ordering is the whole correctness argument. Every Parquet object is copied first, then
 * the change set, and only then the `current.json` pointer — so a crash part-way leaves
 * an unreferenced partial snapshot rather than a pointer aimed at one. Nothing mutates a
 * previously published snapshot, because each is keyed by its own run id.
 *
 * The handler ends by listing what it wrote and asserting the objects are all present and
 * non-empty. A publish step that reports success from the absence of thrown exceptions is
 * exactly how an empty `publish/` sat behind two green executions.
 */

const s3 = tracer.captureAWSv3Client(new S3Client({}));

const DATA_BUCKET = process.env.DATA_BUCKET ?? '';

export interface PublishSnapshotInput {
  runId: string;
  parcelCount: number;
  partitionCount: number;
}

export interface PublishSnapshotOutput {
  runId: string;
  published: true;
  snapshotPrefix: string;
  pointerKey: string;
  objectsPublished: number;
  bytesPublished: number;
  partitionsPublished: number;
}

class PublishVerificationError extends Error {
  override readonly name = 'PublishVerificationError';
}

/** Every object under a prefix, following continuation tokens. */
async function listAll(prefix: string): Promise<_Object[]> {
  const objects: _Object[] = [];
  let token: string | undefined;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: DATA_BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    objects.push(...(page.Contents ?? []));
    token = page.NextContinuationToken;
  } while (token);

  return objects;
}

function partitionOf(key: string): string | null {
  return /geohash5=([^/]+)\//.exec(key)?.[1] ?? null;
}

async function baseHandler(event: PublishSnapshotInput): Promise<PublishSnapshotOutput> {
  const snapshotPrefix = publishedSnapshotPrefix(event.runId);

  const staged = (await listAll(STAGED_PARCELS_PREFIX)).filter((object) =>
    object.Key?.endsWith('.parquet'),
  );

  if (staged.length === 0) {
    throw new PublishVerificationError(
      `nothing to publish: no Parquet under s3://${DATA_BUCKET}/${STAGED_PARCELS_PREFIX}`,
    );
  }

  for (const object of staged) {
    const key = object.Key as string;
    const destination = `${snapshotPrefix}${key.slice(STAGED_PARCELS_PREFIX.length)}`;

    await s3.send(
      new CopyObjectCommand({
        Bucket: DATA_BUCKET,
        Key: destination,
        CopySource: `${DATA_BUCKET}/${encodeURIComponent(key)}`,
        MetadataDirective: 'REPLACE',
        Metadata: { 'run-id': event.runId, county: COUNTY },
      }),
    );

    // One emission per object as it is copied, rather than a single total once the loop
    // is done, so progress is visible while a large snapshot is still moving.
    metrics.addMetric('SnapshotObjectPublished', MetricUnit.Count, 1);
    metrics.addMetric('SnapshotBytesPublished', MetricUnit.Bytes, object.Size ?? 0);
    metrics.publishStoredMetrics();
  }

  await s3.send(
    new CopyObjectCommand({
      Bucket: DATA_BUCKET,
      Key: publishedChangeSetKey(event.runId),
      CopySource: `${DATA_BUCKET}/${encodeURIComponent(changeSetKey(event.runId))}`,
    }),
  );

  // --- verify before claiming success ---------------------------------------------
  const published = (await listAll(snapshotPrefix)).filter((object) =>
    object.Key?.endsWith('.parquet'),
  );

  if (published.length !== staged.length) {
    throw new PublishVerificationError(
      `published ${published.length} objects but staged held ${staged.length}`,
    );
  }

  const empty = published.filter((object) => (object.Size ?? 0) === 0);
  if (empty.length > 0) {
    throw new PublishVerificationError(
      `${empty.length} published objects are zero bytes, first: ${empty[0]?.Key}`,
    );
  }

  const partitions = new Set(
    published.map((object) => partitionOf(object.Key as string)).filter(Boolean),
  );
  if (partitions.size !== event.partitionCount) {
    throw new PublishVerificationError(
      `published ${partitions.size} geohash5 partitions but the change set declared ${event.partitionCount}`,
    );
  }

  const bytesPublished = published.reduce((total, object) => total + (object.Size ?? 0), 0);

  // Pointer last, and only now that the above has proven the snapshot is whole.
  await s3.send(
    new PutObjectCommand({
      Bucket: DATA_BUCKET,
      Key: PUBLISH_POINTER_KEY,
      ContentType: 'application/json',
      Body: JSON.stringify(
        {
          runId: event.runId,
          county: COUNTY,
          snapshotPrefix: `s3://${DATA_BUCKET}/${snapshotPrefix}`,
          changeSetKey: publishedChangeSetKey(event.runId),
          format: 'parquet',
          partitionedBy: ['geohash5'],
          parcelCount: event.parcelCount,
          partitionCount: partitions.size,
          objectCount: published.length,
          bytes: bytesPublished,
          publishedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    }),
  );

  logger.info('Published snapshot', {
    runId: event.runId,
    snapshotPrefix,
    objectsPublished: published.length,
    bytesPublished,
    partitionsPublished: partitions.size,
  });

  return {
    runId: event.runId,
    published: true,
    snapshotPrefix: `s3://${DATA_BUCKET}/${snapshotPrefix}`,
    pointerKey: PUBLISH_POINTER_KEY,
    objectsPublished: published.length,
    bytesPublished,
    partitionsPublished: partitions.size,
  };
}

export const handler = middy(baseHandler)
  .use(injectLambdaContext(logger))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics));

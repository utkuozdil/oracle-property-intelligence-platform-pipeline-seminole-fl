/**
 * The published parcel ids, for joining permits to parcels.
 *
 * A permit row is only useful if it attaches to a published parcel, so the join has to be a
 * real set intersection. Counting permit rows that merely *look* like they carry a parcel id
 * measures the formatting of this source, not its usefulness, and would report a healthy
 * number while the join silently failed.
 *
 * Only `parcel_id` is read out of the snapshot. The whole snapshot is 40 MB across 56
 * Parquet objects, but one column of 181,218 strings is a few megabytes, and this runs once
 * per harvest rather than per request. `hyparquet` is already a dependency of this package
 * and is a pure-JS reader, so nothing platform-specific enters the bundle.
 */
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { parquetReadObjects } from 'hyparquet';
import { z } from 'zod';
import { logger } from '../observability';

const BUCKET = process.env.DATA_BUCKET ?? '';

/** Snapshot ids are run-scoped, so the pointer is the only durable way in. */
const PUBLISH_POINTER_KEY = 'publish/current.json';

/** The 56 objects average ~700 KB; ten in flight saturates the link. */
const FETCH_CONCURRENCY = 10;

const s3 = new S3Client({});

export const PublishPointer = z
  .object({
    runId: z.string().min(1),
    snapshotPrefix: z.string().min(1),
    parcelCount: z.number().int().positive(),
  })
  .loose();

export type PublishPointer = z.infer<typeof PublishPointer>;

export interface PublishedParcels {
  snapshotRunId: string;
  /** What the pointer claims, kept separate from what was actually read. */
  statedParcelCount: number;
  parcelIds: Set<string>;
}

async function getBytes(key: string): Promise<Uint8Array> {
  const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const body = await response.Body?.transformToByteArray();
  if (!body) throw new Error(`empty object at ${key}`);
  return body;
}

async function snapshotKeys(pointer: PublishPointer): Promise<string[]> {
  const prefix = pointer.snapshotPrefix.replace(`s3://${BUCKET}/`, '');
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: continuationToken }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key?.endsWith('.parquet')) keys.push(object.Key);
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
  return keys;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Every published parcel id.
 *
 * Throws rather than returning an empty set when the snapshot cannot be read: an empty set
 * would make every permit look unmatched, which is indistinguishable from a genuinely broken
 * join and would be recorded as a real finding.
 */
export async function publishedParcels(): Promise<PublishedParcels> {
  const pointerBody = await getBytes(PUBLISH_POINTER_KEY);
  const pointer = PublishPointer.parse(JSON.parse(new TextDecoder().decode(pointerBody)));

  const keys = await snapshotKeys(pointer);
  if (keys.length === 0) {
    throw new Error(`snapshot ${pointer.runId} has no Parquet objects at ${pointer.snapshotPrefix}`);
  }

  const startedAt = Date.now();
  const buffers = await mapWithConcurrency(keys, FETCH_CONCURRENCY, getBytes);

  const parcelIds = new Set<string>();
  for (const buffer of buffers) {
    const file = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    const rows = (await parquetReadObjects({ file, columns: ['parcel_id'] })) as Record<
      string,
      unknown
    >[];
    for (const row of rows) {
      const id = row.parcel_id;
      if (typeof id === 'string' && id.length > 0) parcelIds.add(id);
    }
  }

  logger.info('Read the published parcel snapshot', {
    snapshotRunId: pointer.runId,
    objects: keys.length,
    statedParcelCount: pointer.parcelCount,
    distinctParcelIds: parcelIds.size,
    elapsedMs: Date.now() - startedAt,
  });

  return {
    snapshotRunId: pointer.runId,
    statedParcelCount: pointer.parcelCount,
    parcelIds,
  };
}

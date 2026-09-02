import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

/**
 * Small read-only S3 helpers shared by the serving-tier routers.
 *
 * The parcel snapshot reader keeps its own tuned fetch path; this module exists for the
 * metadata reads — manifests, change sets, coverage reports — which are small JSON
 * objects fetched a handful at a time.
 */

export const DATA_BUCKET = process.env.DATA_BUCKET_NAME ?? '';

const s3 = new S3Client({});

/** Reads and parses a JSON object. Returns `null` when the key does not exist. */
export async function getJson<T = unknown>(key: string): Promise<T | null> {
  const record = await getJsonRecord<T>(key);
  return record?.value ?? null;
}

/** Like {@link getJson}, plus the object's LastModified for completion timestamps. */
export async function getJsonRecord<T = unknown>(
  key: string,
): Promise<{ value: T; lastModified: string | null } | null> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: DATA_BUCKET, Key: key }));
    const text = await response.Body?.transformToString();
    if (text === undefined || text.trim() === '') return null;
    return {
      value: JSON.parse(text) as T,
      lastModified: response.LastModified?.toISOString() ?? null,
    };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Immediate child prefixes of `prefix`, e.g. `manifests/` yields `manifests/current/`. */
export async function listPrefixes(prefix: string): Promise<string[]> {
  const page = await s3.send(
    new ListObjectsV2Command({ Bucket: DATA_BUCKET, Prefix: prefix, Delimiter: '/' }),
  );
  return (page.CommonPrefixes ?? [])
    .map((entry) => entry.Prefix)
    .filter((value): value is string => value !== undefined);
}

export interface S3Object {
  key: string;
  size: number;
  lastModified: string | null;
}

/**
 * Object keys under `prefix`, capped at `limit` so a router can never be made to walk an
 * unbounded prefix. The cap is deliberately low: every caller here is summarising.
 */
export async function listObjects(prefix: string, limit = 1000): Promise<S3Object[]> {
  const objects: S3Object[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: DATA_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const entry of page.Contents ?? []) {
      if (entry.Key === undefined) continue;
      objects.push({
        key: entry.Key,
        size: entry.Size ?? 0,
        lastModified: entry.LastModified?.toISOString() ?? null,
      });
      if (objects.length >= limit) return objects;
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
  return objects;
}

function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: string }).name;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}

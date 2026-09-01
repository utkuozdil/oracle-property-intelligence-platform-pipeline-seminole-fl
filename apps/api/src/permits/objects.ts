/** S3 reads and writes for the permit tier. */
import {
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';

const s3 = new S3Client({});

export function dataBucket(): string {
  const bucket = process.env.DATA_BUCKET;
  if (!bucket) throw new Error('DATA_BUCKET is not set');
  return bucket;
}

export async function putText(key: string, body: string, contentType: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: dataBucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function putJson(key: string, value: unknown): Promise<void> {
  await putText(key, JSON.stringify(value, null, 2), 'application/json');
}

/** Newline-delimited JSON, so a shard's rows can be appended to and streamed by Glue. */
export async function putNdjson(key: string, records: readonly unknown[]): Promise<void> {
  await putText(
    key,
    records.map((record) => JSON.stringify(record)).join('\n'),
    'application/x-ndjson',
  );
}

export async function getText(key: string): Promise<string> {
  const response = await s3.send(new GetObjectCommand({ Bucket: dataBucket(), Key: key }));
  if (!response.Body) throw new Error(`s3://${dataBucket()}/${key} returned no body`);
  return response.Body.transformToString();
}

export async function getJson<T>(key: string): Promise<T> {
  return JSON.parse(await getText(key)) as T;
}

/** An object's body plus the ETag needed to write it back conditionally. */
export interface VersionedText {
  /** Null when the key does not exist yet. */
  body: string | null;
  etag: string | null;
}

export async function getTextIfPresent(key: string): Promise<VersionedText> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: dataBucket(), Key: key }));
    if (!response.Body) throw new Error(`s3://${dataBucket()}/${key} returned no body`);
    return { body: await response.Body.transformToString(), etag: response.ETag ?? null };
  } catch (error) {
    if (error instanceof NoSuchKey) return { body: null, etag: null };
    throw error;
  }
}

/** A conditional write that lost its race, so the caller should re-read and re-merge. */
export class PreconditionFailedError extends Error {
  constructor(key: string) {
    super(`conditional write of ${key} lost its race`);
    this.name = 'PreconditionFailedError';
  }
}

/**
 * Write only if the object still looks the way the caller last read it.
 *
 * `etag` null means "only if it does not exist yet". This is what makes accumulating a union
 * in place safe: without it, two runs merging the same month would each write their own
 * read-modify-write result and the later write would silently drop the earlier one's rows.
 */
export async function putTextConditional(
  key: string,
  body: string,
  contentType: string,
  etag: string | null,
): Promise<void> {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: dataBucket(),
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(etag === null ? { IfNoneMatch: '*' } : { IfMatch: etag }),
      }),
    );
  } catch (error) {
    // 412 is the precondition itself failing. 409 is two conditional writes arriving close
    // enough together that S3 rejects one outright; both mean "re-read and try again".
    const status = error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
    if (status === 412 || status === 409) throw new PreconditionFailedError(key);
    throw error;
  }
}

export async function listKeys(prefix: string): Promise<string[]> {
  return (await listObjects(prefix)).map((object) => object.key);
}

/** A listed object and the only piece of its metadata this tier orders on. */
export interface ListedObject {
  key: string;
  /**
   * When S3 last wrote the object, as an ISO-8601 instant.
   *
   * Null only if S3 omits it, which it does not for a listed object; carried as nullable so a
   * caller has to decide what an unorderable object means rather than silently sorting it first.
   */
  lastModified: string | null;
}

/**
 * Every object under a prefix, with its write time.
 *
 * Separate from {@link listKeys} because the status tier needs to order observations of the
 * same permit against each other, and the write time is the only ordering key that exists for
 * every staged record — see `reduceToCurrent` in `./reconcile-status`.
 */
export async function listObjects(prefix: string): Promise<ListedObject[]> {
  const objects: ListedObject[] = [];
  let token: string | undefined;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({ Bucket: dataBucket(), Prefix: prefix, ContinuationToken: token }),
    );
    for (const object of response.Contents ?? []) {
      if (object.Key) {
        objects.push({
          key: object.Key,
          lastModified: object.LastModified?.toISOString() ?? null,
        });
      }
    }
    token = response.NextContinuationToken;
  } while (token);
  return objects;
}

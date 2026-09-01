/**
 * Reads and writes for the licence tier, against S3 or a local directory.
 *
 * The local sink is not a convenience here so much as the only affordable way to iterate: one
 * run downloads 48.8 MB over 260 seconds, and the match rules needed many passes over the
 * same file. The *key* is the interface — both sinks are addressed by the same keys from
 * `./storage`, and the local sink treats them as relative paths — so choosing a sink is a
 * deployment detail and never changes what a run produces.
 */
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface ObjectSink {
  readonly description: string;
  putText(key: string, body: string, contentType: string): Promise<void>;
  putBytes(key: string, body: Uint8Array, contentType: string): Promise<void>;
  getText(key: string): Promise<string | null>;
}

class S3Sink implements ObjectSink {
  private readonly client = new S3Client({});
  readonly description: string;

  constructor(private readonly bucket: string) {
    this.description = `s3://${bucket}`;
  }

  async putText(key: string, body: string, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async putBytes(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async getText(key: string): Promise<string | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return (await response.Body?.transformToString()) ?? null;
    } catch (error) {
      // A ledger miss is the common case, not an error.
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const object of response.Contents ?? []) if (object.Key) keys.push(object.Key);
      token = response.NextContinuationToken;
    } while (token);
    return keys;
  }
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === 'NoSuchKey' || name === 'NotFound';
}

class LocalSink implements ObjectSink {
  readonly description: string;

  constructor(private readonly root: string) {
    this.description = resolve(root);
  }

  private path(key: string): string {
    return join(this.root, key);
  }

  async putText(key: string, body: string): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body, 'utf8');
  }

  async putBytes(key: string, body: Uint8Array): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  async getText(key: string): Promise<string | null> {
    try {
      return await readFile(this.path(key), 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
  }
}

/**
 * Picks a sink from the environment.
 *
 * `LICENCES_LOCAL_DIR` wins when set, so a local run can never write to the shared bucket by
 * accident just because credentials happened to be in the environment.
 */
export function resolveSink(): ObjectSink {
  const localDir = process.env.LICENCES_LOCAL_DIR;
  if (localDir) return new LocalSink(localDir);
  const bucket = process.env.DATA_BUCKET;
  if (!bucket) throw new Error('set DATA_BUCKET (S3) or LICENCES_LOCAL_DIR (local run)');
  return new S3Sink(bucket);
}

export async function putJson(sink: ObjectSink, key: string, value: unknown): Promise<void> {
  await sink.putText(key, JSON.stringify(value, null, 2), 'application/json');
}

export async function putNdjson(
  sink: ObjectSink,
  key: string,
  records: readonly unknown[],
): Promise<void> {
  await sink.putText(
    key,
    records.map((record) => JSON.stringify(record)).join('\n'),
    'application/x-ndjson',
  );
}

export async function getJson<T>(sink: ObjectSink, key: string): Promise<T | null> {
  const text = await sink.getText(key);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // A corrupt ledger entry should cost a re-download, not the whole run.
    return null;
  }
}

/** Prefix listing, available only on the S3 sink — the local sink has no reader that needs it. */
export async function listKeys(sink: ObjectSink, prefix: string): Promise<string[]> {
  if (sink instanceof S3Sink) return sink.listKeys(prefix);
  return [];
}

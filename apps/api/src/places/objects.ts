/**
 * The two directions this tier talks to object storage in, kept apart on purpose.
 *
 * `ArtifactSink` is where a run's own output goes. `PeerReader` is how it reads another
 * tier's output. They are separate interfaces because they have different failure meanings:
 * a sink that cannot write is a failed run, while a peer that has produced nothing yet is a
 * measured zero — the BBB rate was 0% for exactly that reason and it was not a bug.
 *
 * DuckDB writes Parquet through the filesystem, so a run always materialises its artifacts
 * in a working directory first and the sink mirrors that tree afterwards. The relative path
 * of a file under the working directory *is* its object key, which is what keeps the local
 * and S3 layouts identical rather than merely similar.
 */
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { DATA_PREFIXES } from '@oracle-seminole/shared';
import { currentPointerKey } from './storage';

/** Where a completed run's artifacts are copied to. */
export interface ArtifactSink {
  readonly description: string;
  /** Uploads a file already on disk. `key` is its path relative to the working directory. */
  putFile(key: string, path: string, contentType: string): Promise<void>;
}

/** How this tier reads a peer tier's staged output. */
export interface PeerReader {
  readonly description: string;
  /** Every `.ndjson` under a key prefix, sorted. Empty is a valid answer. */
  listNdjson(prefix: string): Promise<string[]>;
  readText(key: string): Promise<string>;
}

/**
 * Content types, so an artifact fetched over HTTP from a gateway arrives usable.
 *
 * Parquet in particular: a consumer range-requesting the published table gets
 * `application/octet-stream` by default, and some gateways will then refuse to serve
 * partial content for it.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.parquet': 'application/vnd.apache.parquet',
  '.ndjson': 'application/x-ndjson',
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
};

export function contentTypeFor(key: string): string {
  const dot = key.lastIndexOf('.');
  return (dot < 0 ? undefined : CONTENT_TYPES[key.slice(dot)]) ?? 'application/octet-stream';
}

class S3Objects implements ArtifactSink, PeerReader {
  private readonly client = new S3Client({});
  readonly description: string;

  constructor(private readonly bucket: string) {
    this.description = `s3://${bucket}`;
  }

  async putFile(key: string, path: string, contentType: string): Promise<void> {
    const { size } = await stat(path);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // Streamed with an explicit length: a Parquet artifact is megabytes and the SDK
        // needs `ContentLength` to send a stream body without buffering it whole.
        Body: createReadStream(path),
        ContentLength: size,
        ContentType: contentType,
      }),
    );
  }

  async listNdjson(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const object of response.Contents ?? []) {
        if (object.Key?.endsWith('.ndjson')) keys.push(object.Key);
      }
      token = response.NextContinuationToken;
    } while (token);
    return keys.sort();
  }

  async readText(key: string): Promise<string> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return (await response.Body?.transformToString()) ?? '';
  }
}

/**
 * Everything under the working directory that belongs in the bucket.
 *
 * Scoped to the four owned prefixes rather than "every file", because the working directory
 * also holds the DuckDB database — 23 MB of scratch that is derivable from the artifacts
 * beside it and has no business in the data lake.
 */
export async function collectArtifacts(outputDir: string): Promise<string[]> {
  const owned = Object.values(DATA_PREFIXES).map((prefix) => prefix.replace(/\/$/, ''));
  const keys: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) keys.push(relative(outputDir, path).split(sep).join('/'));
    }
  }

  for (const prefix of owned) {
    try {
      await walk(join(outputDir, prefix));
    } catch (error) {
      // A run with `countsOnly` writes no `publish/` tree at all, which is not a failure.
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    }
  }

  /**
   * The pointer goes last, after everything it names is already durable. Alphabetical order
   * would put it ahead of `staged/places/roofing-matches/`, so a reader following it during
   * an upload could be sent to an object that does not exist yet.
   */
  const pointer = currentPointerKey();
  return keys.sort((a, b) => (a === pointer ? 1 : b === pointer ? -1 : a < b ? -1 : a > b ? 1 : 0));
}

/** Mirrors a completed run's working directory into the sink. Returns the keys written. */
export async function publishArtifacts(
  sink: ArtifactSink,
  outputDir: string,
): Promise<{ key: string; bytes: number }[]> {
  const keys = await collectArtifacts(outputDir);
  const written: { key: string; bytes: number }[] = [];
  for (const key of keys) {
    const path = join(outputDir, ...key.split('/'));
    await sink.putFile(key, path, contentTypeFor(key));
    written.push({ key, bytes: (await stat(path)).size });
  }
  return written;
}

export function s3Objects(bucket: string): ArtifactSink & PeerReader {
  return new S3Objects(bucket);
}

import type { S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DATA_PREFIXES } from '@oracle-seminole/shared';
import type { DatasetName } from './config';

/**
 * The IPFS publication record: where the CIDs and the IPNS name are written so the UI,
 * the MCP server and the next run can find them.
 *
 * Two objects, mirroring the convention the snapshot pointer already follows in this
 * bucket. A run-scoped record that is never rewritten, and a stable pointer that is
 * overwritten in one `PutObject` once the run-scoped record is durable — so a reader
 * sees the previous generation or this one, never a half-written mixture.
 *
 * The existing run manifest is deliberately not amended. Its documented contract is that
 * `manifests/current/manifest.json` is only ever produced by copying a completed
 * run-scoped manifest over it, never written in place, and reaching back into a closed
 * manifest to add a field would break that for every reader that relies on it.
 */

export const IPFS_POINTER_KEY = `${DATA_PREFIXES.publish}ipfs.json`;

export function ipfsRecordKey(runId: string): string {
  return `${DATA_PREFIXES.publish}ipfs/${runId}.json`;
}

export interface PublishedDataset {
  cid: string;
  /** Path within the root, e.g. `query-table/seminole.parquet`. */
  entryPath: string;
  /** Directly fetchable URL for `entryPath`, via the IPNS name. */
  url: string;
  /**
   * The same file addressed by its dataset CID.
   *
   * Immutable by construction, so it cannot be served stale and it pins this exact
   * generation. Prefer it for anything that must not silently follow a re-point — a
   * cited answer, a cached query, a reproducible demo.
   */
  immutableUrl: string;
  bytes: number;
  files: number;
  /** `full`, or a description of exactly what was left out and why. */
  coverage: string;
  /** Staging key of the CAR that produced this CID, in the Filebase bucket. */
  carKey: string;
  carBytes: number;
  /** False when this run reused the previous generation's CID unchanged. */
  uploaded: boolean;
  notes: Record<string, string | number>;
}

export interface IpfsPublicationRecord {
  version: 1;
  runId: string;
  county: string;
  provider: 'filebase';
  publishedAt: string;
  ipns: {
    label: string;
    /** The resolvable `k51…` key. Stable across re-points; safe to hard-code in a UI. */
    name: string;
    sequence: number;
    url: string;
  };
  rootCid: string;
  rootUrl: string;
  datasets: Record<DatasetName, PublishedDataset>;
  totals: {
    bytes: number;
    files: number;
    quotaBytes: number;
    quotaUsedFraction: number;
  };
  verification: {
    gateway: string;
    checkedAt: string;
    checks: { url: string; status: number; resolvedRoot: string | null; elapsedMs: number }[];
    parquetRange: { status: number; magic: string };
  };
  /** True when the content was unchanged and no quota was spent re-uploading it. */
  unchanged: boolean;
}

export async function readIpfsPointer(
  s3: S3Client,
  bucket: string,
): Promise<IpfsPublicationRecord | null> {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: IPFS_POINTER_KEY }));
    const body = await response.Body?.transformToString();
    return body ? (JSON.parse(body) as IpfsPublicationRecord) : null;
  } catch (error) {
    if ((error as { name?: string }).name === 'NoSuchKey') return null;
    throw error;
  }
}

/** Run-scoped record first, stable pointer second. Never the other way round. */
export async function writeIpfsPointer(
  s3: S3Client,
  bucket: string,
  record: IpfsPublicationRecord,
): Promise<{ recordKey: string; pointerKey: string }> {
  const body = JSON.stringify(record, null, 2);
  const recordKey = ipfsRecordKey(record.runId);

  for (const key of [recordKey, IPFS_POINTER_KEY]) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: 'application/json',
        Body: body,
      }),
    );
  }

  return { recordKey, pointerKey: IPFS_POINTER_KEY };
}

import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createReadStream, statSync } from 'node:fs';
import {
  FILEBASE_BUCKET,
  FILEBASE_NAMES_API,
  FILEBASE_S3_ENDPOINT,
  FILEBASE_SIGNING_REGION,
  filebaseCredentials,
  ipnsAuthorization,
} from './config';

/**
 * Filebase client: CAR import over the S3 API, IPNS names over the REST API.
 *
 * Nothing in this file logs a credential or an `Authorization` header. The IPNS bearer
 * token is a base64 of the S3 key pair, so a debug line that prints the request headers
 * prints the storage keys.
 */

class FilebaseError extends Error {
  override readonly name = 'FilebaseError';
}

function client(): S3Client {
  const credentials = filebaseCredentials();
  return new S3Client({
    endpoint: FILEBASE_S3_ENDPOINT,
    region: FILEBASE_SIGNING_REGION,
    forcePathStyle: true,
    credentials,
  });
}

/**
 * Upload a CAR and have Filebase pin the DAG inside it.
 *
 * `x-amz-meta-import: car` is the whole trigger — without it the archive is stored as an
 * opaque blob with its own CID and none of its contents are addressable. Filebase
 * decodes it, pins every block, and reports the root back as `x-amz-meta-cid`.
 *
 * `Pinning-Status: pinned` came back synchronously on every upload measured, including a
 * 118 MB multipart one, so there is no pin-completion poll here by design rather than by
 * omission.
 */
export async function importCar(key: string, carPath: string): Promise<string> {
  const s3 = client();
  const bytes = statSync(carPath).size;

  await s3.send(
    new PutObjectCommand({
      Bucket: FILEBASE_BUCKET,
      Key: key,
      Body: createReadStream(carPath),
      ContentLength: bytes,
      ContentType: 'application/vnd.ipld.car',
      Metadata: { import: 'car' },
    }),
  );

  // The CID also comes back on the PutObject response, but the AWS SDK v3 does not
  // surface unmodelled response headers, so it is read back with a HeadObject. One
  // request, and it doubles as proof the object landed.
  const head = await s3.send(new HeadObjectCommand({ Bucket: FILEBASE_BUCKET, Key: key }));
  const cid = head.Metadata?.cid ?? '';

  if (!cid) {
    throw new FilebaseError(
      `${key} uploaded but Filebase reported no CID — the import=car metadata was not honoured`,
    );
  }
  return cid;
}

export interface IpnsRecord {
  label: string;
  /** The resolvable `k51…` string. This is what goes in a gateway URL. */
  network_key: string;
  cid: string;
  sequence: number;
  enabled: boolean;
}

async function names(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${FILEBASE_NAMES_API}${path}`, {
    method,
    headers: {
      Authorization: ipnsAuthorization(filebaseCredentials()),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Read one name by **label**. `GET /v1/names/<network_key>` is a 404 — the API keys on label. */
export async function getIpnsName(label: string): Promise<IpnsRecord | null> {
  const response = await names('GET', `/${label}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new FilebaseError(`GET /v1/names/${label} returned ${response.status}`);
  }
  return (await response.json()) as IpnsRecord;
}

/**
 * Point the single IPNS name at `cid`, creating it if this is the first publish.
 *
 * `PUT` first and `POST` only on 404, because create is not idempotent: `POST` with an
 * existing label returns `500 ERR_NAME_INVALID` ("Label has already been taken"), which
 * is indistinguishable at a glance from a genuine server fault. `POST` beyond the plan's
 * one-name limit returns `409 ERR_TOO_MANY_NAMES`, which is reported as itself rather
 * than retried — it is a billing state, not a transient error.
 */
export async function pointIpnsName(label: string, cid: string): Promise<IpnsRecord> {
  const updated = await names('PUT', `/${label}`, { cid });
  if (updated.ok) {
    return (await updated.json()) as IpnsRecord;
  }
  if (updated.status !== 404) {
    throw new FilebaseError(
      `PUT /v1/names/${label} returned ${updated.status}: ${await updated.text()}`,
    );
  }

  const created = await names('POST', '', { label, cid, enabled: true });
  if (!created.ok) {
    const detail = await created.text();
    if (created.status === 409) {
      throw new FilebaseError(
        `cannot create IPNS name "${label}": the plan's one-name limit is already used. ` +
          `Reuse the existing name or upgrade the plan. (${detail})`,
      );
    }
    throw new FilebaseError(`POST /v1/names returned ${created.status}: ${detail}`);
  }
  return (await created.json()) as IpnsRecord;
}

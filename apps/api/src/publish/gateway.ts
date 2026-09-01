import { VERIFY_GATEWAY } from './config';

/**
 * Post-publish verification against a public gateway.
 *
 * The failure this exists to catch is a publish that reports success because nothing
 * threw: the CARs upload, the IPNS `PUT` returns 200, and the content is unreachable.
 * An unverified CID is worth nothing, so a run is not complete until a third party has
 * served the bytes back.
 *
 * Every check here goes to `ipfs.io`, never `ipfs.filebase.io`. The Filebase gateway
 * caches per path with `max-age=300` and was measured serving three generations of one
 * IPNS name simultaneously, up to 378 s behind a re-point; a check against it reads the
 * previous run and can pass or fail for reasons unrelated to this one.
 */

class VerificationError extends Error {
  override readonly name = 'VerificationError';
}

export interface PathCheck {
  url: string;
  status: number;
  /** The root the gateway actually resolved through — the direct IPNS-staleness detector. */
  resolvedRoot: string | null;
  elapsedMs: number;
}

export function ipnsUrl(networkKey: string, path = ''): string {
  return `${VERIFY_GATEWAY}/ipns/${networkKey}${path === '' ? '' : `/${path}`}`;
}

export function ipfsUrl(cid: string, path = ''): string {
  return `${VERIFY_GATEWAY}/ipfs/${cid}${path === '' ? '' : `/${path}`}`;
}

/**
 * Fetch a path and report the root it resolved through.
 *
 * `x-ipfs-roots` names the root a request actually traversed. Comparing it to the root
 * just published is the cheapest possible assertion that the IPNS re-point took effect,
 * and it distinguishes "content missing" from "name still pointing at the last run" —
 * two failures that otherwise look identical.
 */
export async function checkPath(url: string): Promise<PathCheck> {
  const startedAt = Date.now();
  const response = await fetch(url, { redirect: 'follow' });
  await response.arrayBuffer();

  return {
    url,
    status: response.status,
    resolvedRoot: response.headers.get('x-ipfs-roots'),
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Range-probe the published Parquet and assert the magic bytes.
 *
 * This is the single check that proves the DuckDB-over-IPFS path works end to end: if
 * the gateway serves a `206` whose first four bytes are `PAR1`, then range reads resolve
 * through the CAR-imported directory and DuckDB can read row groups without pulling the
 * whole file.
 */
export async function checkParquetMagic(url: string): Promise<{ status: number; magic: string }> {
  const response = await fetch(url, { redirect: 'follow', headers: { Range: 'bytes=0-3' } });
  const magic = Buffer.from(await response.arrayBuffer()).toString('ascii');
  return { status: response.status, magic };
}

/**
 * Retry a check until the gateway reflects the expected root.
 *
 * A re-point was visible on `ipfs.io` within 5 s on every sample, but a first-ever fetch
 * of a cold block was observed taking ~60 s, so the wait is generous rather than tight.
 */
export async function waitForRoot(
  url: string,
  expectedRoot: string,
  attempts = 12,
  delayMs = 10_000,
): Promise<PathCheck> {
  let last: PathCheck | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await checkPath(url);
    if (last.status === 200 && last.resolvedRoot?.startsWith(expectedRoot)) {
      return last;
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new VerificationError(
    `${url} never resolved through ${expectedRoot} — last status ${last?.status}, ` +
      `x-ipfs-roots ${last?.resolvedRoot ?? 'absent'}`,
  );
}

/**
 * Pull the whole Parquet once so the first real query does not pay for it.
 *
 * A cold block's first gateway fetch was measured at ~60 s, per block rather than per
 * file. Left cold, the presenter's first DuckDB query stalls for minutes while row
 * groups arrive one at a time; warmed, it answers in under a second.
 */
export async function warm(url: string): Promise<{ bytes: number; elapsedMs: number }> {
  const startedAt = Date.now();
  const response = await fetch(url, { redirect: 'follow' });
  const body = await response.arrayBuffer();
  return { bytes: body.byteLength, elapsedMs: Date.now() - startedAt };
}

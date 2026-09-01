import { CarWriter } from '@ipld/car';
import * as dagPB from '@ipld/dag-pb';
import { execFileSync } from 'node:child_process';
import { createWriteStream, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UnixFS } from 'ipfs-unixfs';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

/**
 * Content-addressed archive packing.
 *
 * A plain S3 upload gives every object its own CID and a prefix full of objects is not a
 * directory, so there is nothing for an IPNS name to point at. Importing a CAR is what
 * produces a single directory CID whose children are path-addressable through any
 * gateway, and it was measured strictly cheaper than the alternative on requests, bytes
 * and consumer round trips.
 */

class CarError extends Error {
  override readonly name = 'CarError';
}

const require = createRequire(import.meta.url);

/**
 * Pack a directory into a CAR and return its root CID.
 *
 * Shelling out to `ipfs-car`'s own CLI rather than driving its stream API: the CLI is
 * the surface whose output was verified byte-for-byte against Filebase's reported CID
 * across eight uploads, and reimplementing its directory walk would put our CIDs and the
 * verified ones on separate code paths for no gain.
 *
 * `--no-wrap` suppresses the extra wrapper directory. Its documented trap — a
 * single-child directory collapses to the child, so the root becomes a file CID and
 * every path under it 404s — is prevented upstream: every dataset directory is built
 * with a `manifest.json` beside its data.
 */
export function packDirectory(directory: string, carPath: string): string {
  const bin = require.resolve('ipfs-car/bin.js');
  let stdout: string;

  try {
    stdout = execFileSync(
      process.execPath,
      [bin, 'pack', directory, '--output', carPath, '--no-wrap'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } catch (error) {
    const detail = error as { stderr?: string; message?: string };
    throw new CarError(
      `packing ${directory} failed: ${(detail.stderr ?? detail.message ?? '').trim()}`,
    );
  }

  const root = stdout.trim().split('\n').pop()?.trim() ?? '';
  if (!root.startsWith('bafy') && !root.startsWith('Qm') && !root.startsWith('bafk')) {
    throw new CarError(`ipfs-car did not report a root CID for ${directory}, got: ${root}`);
  }

  // A raw-leaf root means `--no-wrap` descended past a single child and the "directory"
  // is really a file. Every consumer path would 404, and it would 404 silently.
  if (root.startsWith('bafk')) {
    throw new CarError(
      `${directory} packed to a raw file CID (${root}), not a directory — ` +
        'the directory needs at least two entries for --no-wrap to preserve it',
    );
  }

  return root;
}

export interface RootChild {
  name: string;
  cid: string;
  /** Cumulative size hint used only for gateway directory listings. */
  tsize: number;
}

/**
 * Build a CAR containing nothing but a root directory node linking already-pinned CIDs.
 *
 * Filebase accepts a CAR that references blocks it does not carry and the gateway
 * traverses through to them — verified with a 201-byte archive. That is what keeps this
 * publish incremental: the county root is a few hundred bytes joining three dataset
 * subtrees, so a run in which only the query table changed re-uploads only the query
 * table, not the whole county.
 */
export async function packRootDirectory(children: RootChild[], carPath: string): Promise<string> {
  // dag-pb requires name-sorted links. Out of order, the block encodes the same tree
  // under a different hash, and the local/remote CID assertion starts failing for a
  // reason that looks nothing like link ordering.
  const links = [...children]
    .sort((left, right) => (left.name < right.name ? -1 : 1))
    .map((child) => ({ Name: child.name, Tsize: child.tsize, Hash: CID.parse(child.cid) }));

  const bytes = dagPB.encode(
    dagPB.prepare({ Data: new UnixFS({ type: 'directory' }).marshal(), Links: links }),
  );
  const root = CID.create(1, dagPB.code, await sha256.digest(bytes));

  const { writer, out } = CarWriter.create([root]);
  const written = pipeline(Readable.from(out), createWriteStream(carPath));
  await writer.put({ cid: root, bytes });
  await writer.close();
  await written;

  return root.toString();
}

export function carBytes(carPath: string): number {
  return statSync(carPath).size;
}

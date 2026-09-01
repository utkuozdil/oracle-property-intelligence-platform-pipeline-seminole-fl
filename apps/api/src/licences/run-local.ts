/**
 * Local runner for the licence harvest.
 *
 * This is how the counts and the match rate in `docs/seminole-licence-findings.md` were
 * measured, and it exists mainly because of `--extract`: one download is 48.8 MB over about
 * 260 seconds, and the matching rules needed many passes over the same bytes. Pointing at a
 * file already on disk makes a pass take seconds and sends no request to DBPR at all.
 *
 *   LICENCES_LOCAL_DIR=.lic-work/out \
 *     pnpm --filter @oracle-seminole/api exec tsx src/licences/run-local.ts \
 *       --extract .lic-work/CONSTRUCTIONLICENSE_1.csv \
 *       --contractors .lic-work/permit-contractors.json
 *
 * Flags:
 *   --extract <file>      Parse a local copy instead of downloading. Omit to download.
 *   --contractors <file>  JSON array of `{ name, permitCount }` or of plain strings.
 *                         Omit to read the permit census from S3 instead.
 *   --freshness-days <n>  0 forces a fresh download, ignoring the ledger.
 *   --keep-raw            Persist the raw extract under `raw/licences/`.
 *   --probe               Only probe size and `Last-Modified`, then exit.
 *   --run-id <id>
 */
import { readFile } from 'node:fs/promises';
import { harvest } from './harvest';
import { probeExtract } from './http';
import { DBPR_LICENCE_CSV_URL } from './config';
import type { PermitContractor } from './match';

function say(line: string): void {
  // `no-console` is on repo-wide; a CLI still has to speak.
  process.stdout.write(`${line}\n`);
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function numberFlag(argv: readonly string[], name: string): number | undefined {
  const raw = flag(argv, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} expects a number, got "${raw}"`);
  return value;
}

async function loadContractors(file: string): Promise<PermitContractor[]> {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array`);
  return parsed.flatMap((entry): PermitContractor[] => {
    if (typeof entry === 'string') return [{ name: entry }];
    const name = (entry as { name?: unknown }).name;
    if (typeof name !== 'string') return [];
    const permitCount = (entry as { permitCount?: unknown }).permitCount;
    return [{ name, permitCount: typeof permitCount === 'number' ? permitCount : undefined }];
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--probe')) {
    const probe = await probeExtract();
    say(`status          ${probe.status}`);
    say(`total bytes     ${probe.totalBytes ?? 'unknown'}`);
    say(`last modified   ${probe.lastModified ?? 'unknown'}`);
    return;
  }

  const runId = flag(argv, 'run-id') ?? `local-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const contractorsFile = flag(argv, 'contractors');
  const extractFile = flag(argv, 'extract');

  const contractors = contractorsFile ? await loadContractors(contractorsFile) : undefined;

  say(`run ${runId}`);
  say(`sink ${process.env.LICENCES_LOCAL_DIR ? `local ${process.env.LICENCES_LOCAL_DIR}` : 'S3'}`);
  if (contractors) say(`contractors ${contractors.length} from ${contractorsFile}`);

  const extractOverride = extractFile
    ? {
        bytes: new Uint8Array(await readFile(extractFile)),
        // A local file has no response headers; the mtime is not the publication time, so it
        // is reported as unknown rather than guessed at.
        lastModified: null,
        fetchedAt: new Date().toISOString(),
        durationMs: 0,
        sourceUrl: DBPR_LICENCE_CSV_URL,
      }
    : undefined;
  if (extractFile) say(`extract ${extractFile} (no request to DBPR)`);

  const { summary } = await harvest({
    runId,
    contractors,
    contractorSource: contractors ? 'request' : 'permits',
    freshnessDays: numberFlag(argv, 'freshness-days'),
    keepRawCopy: argv.includes('--keep-raw'),
    extractOverride,
    onProgress: (message, detail) => say(`  ${message} ${JSON.stringify(detail ?? {})}`),
  });

  say('');
  say(`source              ${summary.sourceUrl}`);
  say(`last modified       ${summary.sourceLastModified ?? 'unknown'}`);
  say(`download            ${summary.downloadBytes} bytes in ${summary.downloadSeconds}s` +
    `${summary.servedFromLedger ? ' (served from ledger)' : ''}`);
  say(`rows parsed         ${summary.rowsParsed} (${summary.raggedRows} ragged)`);
  say(`seminole licences   ${summary.seminoleLicences} ` +
    `(${summary.qualifiedBusinessRows} QB, ${summary.licencedRows} numbered)`);
  say(`standing            ${JSON.stringify(summary.standingDistribution)}`);
  say(`expiry cliff        ${summary.expiredBreakdown.note}`);
  say(`primary status      ${JSON.stringify(summary.primaryStatusDistribution)}`);
  say(`secondary status    ${JSON.stringify(summary.secondaryStatusDistribution)}`);
  say(`adverse licences    ${summary.adverseLicences}`);
  say(`contractors         ${summary.contractorsConsidered}`);
  say(`matched             ${summary.contractorsMatched} (${(summary.matchRate * 100).toFixed(1)}%)`);
  say(`  of which keyed    ${summary.contractorsMatchedByKey} (${(summary.keyedMatchRate * 100).toFixed(1)}%)`);
  say(`tiers               ${JSON.stringify(summary.matchTierCounts)}`);
  say(`adverse contractors ${summary.contractorsWithAdverseLicence}`);
  say(`  counted how       ${summary.adverseSignalBasis}`);
  say(`licences key        ${summary.licencesKey}`);
  say(`matches key         ${summary.matchesKey}`);
  say(`elapsed             ${summary.elapsedSeconds}s`);
  for (const warning of summary.warnings) say(`warning             ${warning}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

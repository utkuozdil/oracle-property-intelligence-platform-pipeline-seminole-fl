/**
 * Local runner for the BBB harvest.
 *
 * BBB is a national source with no credentials and no county-specific plumbing, so a run
 * needs nothing but network access. This is how the throughput and match-rate figures in
 * `docs/seminole-bbb-findings.md` were measured, and it is the cheapest way to re-measure
 * them after a parser or matcher change.
 *
 *   BBB_LOCAL_DIR=.bbb-work/out \
 *     pnpm --filter @oracle-seminole/api exec tsx src/bbb/run-local.ts \
 *       --contractors .bbb-work/permit-contractors.json --seed-pages 15
 *
 * Flags:
 *   --contractors <file>  JSON array of `{ name, permitCount }` or of plain strings.
 *                         Omit to read the permit census from S3 instead.
 *   --seed-pages <n>      Pages per city seed search (1-15). Default 15.
 *   --contractor-limit <n>
 *   --freshness-days <n>  0 forces a full re-fetch, ignoring the ledger.
 *   --no-seed             Skip the city seed sweep.
 *   --run-id <id>
 */
import { readFile } from 'node:fs/promises';
import { harvest } from './harvest';
import type { PermitContractor } from './match';
import { MAX_PAGES_PER_SEARCH } from './config';

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
  const runId = flag(argv, 'run-id') ?? `local-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const contractorsFile = flag(argv, 'contractors');

  const contractors = contractorsFile ? await loadContractors(contractorsFile) : undefined;

  say(`run ${runId}`);
  say(`sink ${process.env.BBB_LOCAL_DIR ? `local ${process.env.BBB_LOCAL_DIR}` : 'S3'}`);
  if (contractors) say(`contractors ${contractors.length} from ${contractorsFile}`);

  const { summary } = await harvest({
    runId,
    seedCities: !argv.includes('--no-seed'),
    seedPages: numberFlag(argv, 'seed-pages') ?? MAX_PAGES_PER_SEARCH,
    contractorLimit: numberFlag(argv, 'contractor-limit'),
    freshnessDays: numberFlag(argv, 'freshness-days'),
    contractors,
    contractorSource: contractors ? 'request' : 'permits',
    onProgress: (message, detail) => say(`  ${message} ${JSON.stringify(detail ?? {})}`),
  });

  say('');
  say(`searches            ${summary.searchesIssued} (${summary.searchesServedFromLedger} from ledger)`);
  say(`requests            ${summary.requestsMade} in ${summary.elapsedSeconds}s ` +
    `= ${summary.requestsPerSecond} req/s`);
  say(`latency ms          min ${summary.latencyMs.min} median ${summary.latencyMs.median} max ${summary.latencyMs.max}`);
  say(`businesses          ${summary.businessesDistinct} distinct (${summary.roofingBusinesses} roofing)`);
  say(`ratings             ${JSON.stringify(summary.ratingDistribution)}`);
  say(`contractors         ${summary.contractorsConsidered}`);
  say(`matched             ${summary.contractorsMatched} (${(summary.matchRate * 100).toFixed(1)}%)`);
  say(`tiers               ${JSON.stringify(summary.matchTierCounts)}`);
  say(`businesses key      ${summary.businessesKey}`);
  say(`matches key         ${summary.matchesKey}`);
  for (const warning of summary.warnings) say(`warning             ${warning}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

# Oracle pipeline — Seminole County, FL

Ingests Seminole County property, permit, and enrichment data and publishes a snapshot the [Roofing CRM](https://github.com/prismteam-ai/roofing-crm) reads.

**Live:** https://d1gfdmw7ud0jxj.cloudfront.net

The SPA and API share that hostname (`/trpc` is the API).

## What is published

- Parcel snapshot under `publish/` (181,218 parcels), pointed at by `publish/current.json`
- Permit history under `publish/permits/`, pointed at by `publish/permits/current.json`
- Status coverage is partial. `unknown` means the Click2Gov status page has not been harvested, not that the permit is closed.

The CRM is granted `publish/*` only. Do not point it at `raw/` or `staged/`.

## Layout

```
apps/web             Vite + React run-summary UI
apps/api             tRPC, harvest/publish jobs, TypeScript CDK
packages/shared      keys, prefixes, service identity
pipeline/            Python Glue CDK app (reads bucket/topic from SSM)
```

Deploy TypeScript stacks first. Glue reads `/oracle-seminole/dev/data-bucket-name` and `/oracle-seminole/dev/operations-topic-arn`.

## Commands

```sh
just setup
just test
just type-check
just deploy       # TypeScript, then Glue
```

Permit republish (needs DuckDB; no `just` recipe):

```sh
DATA_BUCKET=… PERMIT_PUBLISH_WORK_DIR="$PWD/.publish-work/permits" \
  pnpm --filter @oracle-seminole/api exec tsx src/publish/permit-cli.ts
```

Account `795366345505`, region `us-east-2`.

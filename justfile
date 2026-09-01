set dotenv-load := false

TS_CDK_DIR := "apps/api"
PY_CDK_DIR := "pipeline"

# Pinned so `synth` and `deploy` always resolve the same bootstrap roles, in both
# the TypeScript CDK app and the Python CDK app.
export CDK_BOOTSTRAP_QUALIFIER := env_var_or_default("CDK_BOOTSTRAP_QUALIFIER", "hnb659fds")
export AWS_REGION := env_var_or_default("AWS_REGION", "us-east-2")
export TARGET_ENV := env_var_or_default("TARGET_ENV", "dev")

default:
    @just --list

# Install both toolchains
setup:
    pnpm install --frozen-lockfile
    cd {{ PY_CDK_DIR }} && uv sync --frozen

# Check code formatting in both toolchains
format:
    pnpm exec prettier --check .
    cd {{ PY_CDK_DIR }} && uv run ruff format --check .

# Run linting in both toolchains
lint:
    pnpm exec eslint .
    cd {{ PY_CDK_DIR }} && uv run ruff check .

# Run type checking in both toolchains
type-check:
    pnpm turbo run typecheck
    cd {{ PY_CDK_DIR }} && uv run basedpyright

# Run tests in both toolchains
test:
    pnpm turbo run test
    cd {{ PY_CDK_DIR }} && uv run pytest --cov --cov-report=xml --cov-report=term-missing

# Build the SPA, then synthesize both CDK apps
build:
    pnpm turbo run build
    cd {{ TS_CDK_DIR }} && pnpm exec cdk synth --strict \
      --context "@aws-cdk/core:bootstrapQualifier=$CDK_BOOTSTRAP_QUALIFIER"
    cd {{ PY_CDK_DIR }} && pnpm exec cdk synth --strict \
      --context "@aws-cdk/core:bootstrapQualifier=$CDK_BOOTSTRAP_QUALIFIER"

# Deploy both CDK apps. The TypeScript app runs first: it publishes the SSM parameters
# the Python app reads for the data bucket and the operations topic.
deploy: build
    cd {{ TS_CDK_DIR }} && pnpm exec cdk deploy --all --require-approval never \
      --context "@aws-cdk/core:bootstrapQualifier=$CDK_BOOTSTRAP_QUALIFIER"
    cd {{ PY_CDK_DIR }} && pnpm exec cdk deploy --all --require-approval never \
      --context "@aws-cdk/core:bootstrapQualifier=$CDK_BOOTSTRAP_QUALIFIER"

# Tear the environment down completely, Python app first
destroy:
    cd {{ PY_CDK_DIR }} && pnpm exec cdk destroy --all --force \
      --context "@aws-cdk/core:bootstrapQualifier=$CDK_BOOTSTRAP_QUALIFIER"
    cd {{ TS_CDK_DIR }} && pnpm exec cdk destroy --all --force \
      --context "@aws-cdk/core:bootstrapQualifier=$CDK_BOOTSTRAP_QUALIFIER"

# Resolve the data bucket name the TypeScript CDK app published to SSM
_data-bucket:
    @aws ssm get-parameter --region "$AWS_REGION" \
      --name "/oracle-seminole/$TARGET_ENV/data-bucket-name" --query Parameter.Value --output text

# Publish the current S3 snapshot to Elephant IPFS via Filebase, and re-point the IPNS name.
#
# Runs from here rather than from a deployed Lambda: the step needs the Filebase key pair,
# and hosting it would mean a secret, a KMS key and a role that bill every month for
# something that runs once per refresh. Idempotent on content — an unchanged snapshot
# produces the same CIDs and uploads nothing, which matters on a 5 GB free plan.
#
# `just publish-ipfs --dry-run` builds and packs, reports which datasets would move and
# how many bytes that costs, and uploads nothing.
publish-ipfs *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ ! -f "$HOME/.filebase/credentials" ]]; then
      echo "missing ~/.filebase/credentials (FILEBASE_ACCESS_KEY_ID / FILEBASE_SECRET_ACCESS_KEY)" >&2
      exit 1
    fi
    # Sourced, never echoed: the IPNS bearer token is a base64 of this key pair.
    set -a; . "$HOME/.filebase/credentials"; set +a
    export DATA_BUCKET="$(just _data-bucket)"
    export TABLE_NAME="$(aws ssm get-parameter --region "$AWS_REGION" \
      --name "/oracle-seminole/$TARGET_ENV/table-name" --query Parameter.Value --output text)"
    # Scratch space at the repo root, not under apps/api, so a re-run after a failure
    # reuses the already-downloaded snapshot instead of pulling 40 MB again.
    export PUBLISH_WORK_DIR="{{ justfile_directory() }}/.publish-work"
    cd {{ TS_CDK_DIR }} && pnpm exec tsx src/publish/cli.ts {{ ARGS }}

# Roofing places are joined to permit contractors and BBB ratings when those tiers have
# output on disk, so run this after them to pick up the enrichment without a code change.
#
# Ingest Overture business places for Seminole County, clipped to the county polygon.
places-ingest *ARGS:
    pnpm exec tsx apps/api/src/places/cli.ts ingest --diff {{ ARGS }}

# Print the DuckDB command for the business-places demo, resolved against the built artifact.
places-demo:
    pnpm exec tsx apps/api/src/places/cli.ts demo

# Open the DuckDB-backed query layer over the IPFS-published Parquet and answer the
# roofing-lead questions. No database, no server: DuckDB range-reads row groups off a
# public gateway and exits.
#
# Set PARQUET_URL to override the source — useful if a gateway is slow mid-demo, e.g.
#   PARQUET_URL=.publish-work/build/query-table/seminole.parquet just duckdb-demo
duckdb-demo:
    #!/usr/bin/env bash
    set -euo pipefail
    record="$(aws s3 cp "s3://$(just _data-bucket)/publish/ipfs.json" - --region "$AWS_REGION")"
    parquet="${PARQUET_URL:-$(jq -r '.datasets["query-table"].url' <<<"$record")}"
    manifest="${MANIFEST_URL:-$(jq -r '.ipns.url + "/query-table/manifest.json"' <<<"$record")}"
    echo "IPNS  $(jq -r .ipns.name <<<"$record")"
    echo "root  $(jq -r .rootCid <<<"$record")"
    echo "table $parquet"
    echo
    {
      printf "INSTALL httpfs; LOAD httpfs;\n"
      printf "CREATE VIEW properties AS SELECT * FROM read_parquet('%s');\n" "$parquet"
      printf "CREATE VIEW manifest AS SELECT * FROM read_json('%s');\n" "$manifest"
      cat {{ TS_CDK_DIR }}/src/publish/demo.sql
    } | duckdb

# Execute both Step Functions stubs and report their terminal status
smoke-test-state-machines:
    #!/usr/bin/env bash
    set -euo pipefail
    for name in SeminoleRefresh PermitHarvest; do
      arn=$(aws stepfunctions list-state-machines --region "$AWS_REGION" \
        --query "stateMachines[?name=='${name}'].stateMachineArn" --output text)
      execution=$(aws stepfunctions start-execution --region "$AWS_REGION" \
        --state-machine-arn "$arn" --input '{}' --query executionArn --output text)
      for _ in $(seq 1 60); do
        status=$(aws stepfunctions describe-execution --region "$AWS_REGION" \
          --execution-arn "$execution" --query status --output text)
        [[ "$status" == "RUNNING" ]] || break
        sleep 2
      done
      echo "${name}: ${status}"
      [[ "$status" == "SUCCEEDED" ]]
    done

# Serve the published dataset to an MCP client over stdio.
#
# Nothing is deployed and nothing is hosted: the data is public and content-addressed, so
# each consuming agent runs its own copy of this server against the same IPNS name. Point
# an MCP client at this command rather than at a URL. See docs/seminole-mcp-access.md.
#
# Serve the published dataset to an MCP client over stdio
mcp-serve:
    pnpm --config.verify-deps-before-run=false --filter @oracle-seminole/mcp run start

# Prove the MCP server end to end: spawn it over stdio as a real MCP client, list its
# tools, and answer the demo's questions with timings.
#
# Permit and BBB enrichment live in the private bucket, not in the published dataset, so
# they are wired in only when AWS credentials resolve. Without them the probe still runs
# and the server reports the permit half of the headline question as unanswered, which is
# exactly what an outside consumer sees. `MCP_ENRICHMENT=off just mcp-probe` forces that.
#
# Prove the MCP server answers agent questions end to end, with timings
mcp-probe:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ "${MCP_ENRICHMENT:-on}" == "on" ]]; then
      export ORACLE_DATA_BUCKET="$(just _data-bucket 2>/dev/null || true)"
    fi
    pnpm --config.verify-deps-before-run=false --filter @oracle-seminole/mcp run probe

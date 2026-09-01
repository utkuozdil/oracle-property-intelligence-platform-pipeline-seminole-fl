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

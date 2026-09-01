"""Values shared with the TypeScript tier.

These duplicate `packages/shared/src/service.ts`. They are kept in sync by hand because
the two CDK apps are separate runtimes; the tests assert the SSM parameter paths so a
drift is caught rather than silently deploying against the wrong parameter.
"""

from __future__ import annotations

from typing import Literal

SERVICE_NAME = "oracle-seminole"
METRICS_NAMESPACE = "OracleSeminole"
AWS_REGION = "us-east-2"
COUNTY = "Seminole County, FL"

TargetEnv = Literal["dev", "prod"]


def parse_target_env(value: str | None) -> TargetEnv:
    return "prod" if value == "prod" else "dev"


def operations_topic_name(target_env: TargetEnv) -> str:
    """Mirror of the `topicName` the TypeScript `CoreStack` gives the operations topic."""
    return f"{SERVICE_NAME}-{target_env}-operations"


def ssm_parameter_names(target_env: TargetEnv) -> dict[str, str]:
    """Mirror of `ssmParameterNames` in `packages/shared/src/service.ts`."""
    prefix = f"/{SERVICE_NAME}/{target_env}"
    return {
        "data_bucket_name": f"{prefix}/data-bucket-name",
        "operations_topic_arn": f"{prefix}/operations-topic-arn",
        "table_name": f"{prefix}/table-name",
    }


def cost_tags(target_env: TargetEnv) -> dict[str, str]:
    """Identical tag set to the TypeScript CDK app.

    `project_name` matches the `service` dimension used by the `CostPredicted` metric,
    so predicted and billed cost line up on the same key across both tiers.
    """
    return {
        "project_name": SERVICE_NAME,
        "environment": target_env,
        "managed_by": "cdk",
        "phase": "phase-0",
    }

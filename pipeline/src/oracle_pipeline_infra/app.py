"""CDK app definition for the Glue tier."""

from __future__ import annotations

import os

import aws_cdk as cdk

from oracle_pipeline_infra.constants import AWS_REGION, cost_tags, parse_target_env
from oracle_pipeline_infra.glue_stack import GlueStack


def main() -> None:
    app = cdk.App()
    target_env = parse_target_env(os.environ.get("TARGET_ENV"))

    GlueStack(
        app,
        f"OracleSeminole-{target_env}-Glue",
        description="Oracle Seminole PySpark Glue tier",
        env=cdk.Environment(
            account=os.environ.get("CDK_DEFAULT_ACCOUNT"),
            region=AWS_REGION,
        ),
        tags=cost_tags(target_env),
        target_env=target_env,
    )

    app.synth()

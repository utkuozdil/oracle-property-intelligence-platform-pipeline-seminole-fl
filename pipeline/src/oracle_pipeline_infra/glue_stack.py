"""Glue tier: the PySpark job, its role, its assets, and its failure alerting."""

from __future__ import annotations

from typing import cast

import aws_cdk as cdk
from aws_cdk import aws_events as events
from aws_cdk import aws_events_targets as targets
from aws_cdk import aws_glue as glue
from aws_cdk import aws_iam as iam
from aws_cdk import aws_s3 as s3
from aws_cdk import aws_s3_assets as s3_assets
from aws_cdk import aws_sns as sns
from aws_cdk import aws_ssm as ssm
from constructs import Construct

from oracle_pipeline_infra.constants import (
    SERVICE_NAME,
    TargetEnv,
    operations_topic_name,
    ssm_parameter_names,
)

GLUE_VERSION = "5.0"
WORKER_TYPE = "G.1X"
NUMBER_OF_WORKERS = 2

#: Glue job states that mean the run will not complete and a human is needed.
TERMINAL_JOB_STATES = ["FAILED", "TIMEOUT", "ERROR", "STOPPED"]


class GlueStack(cdk.Stack):
    """Deploys the Seminole refresh Glue job.

    The data bucket and the operations topic are owned by the TypeScript CDK app and
    imported by name/ARN from SSM Parameter Store, so this stack never hardcodes a
    physical resource identifier and the two apps can be deployed independently — the
    TypeScript app first.
    """

    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        *,
        target_env: TargetEnv,
        description: str | None = None,
        env: cdk.Environment | None = None,
        tags: dict[str, str] | None = None,
    ) -> None:
        super().__init__(scope, construct_id, description=description, env=env, tags=tags)

        parameters = ssm_parameter_names(target_env)

        data_bucket_name = ssm.StringParameter.value_for_string_parameter(
            self, parameters["data_bucket_name"]
        )
        data_bucket = s3.Bucket.from_bucket_name(self, "DataBucket", data_bucket_name)

        # The topic is named deterministically by the TypeScript app, so deriving the ARN
        # here keeps its account and region resolved. Importing the ARN from SSM instead
        # would yield a token, and EventBridge cannot verify that a token-ARN target sits
        # in this environment — which fails `cdk synth --strict`.
        operations_topic = sns.Topic.from_topic_arn(
            self,
            "OperationsTopic",
            self.format_arn(service="sns", resource=operations_topic_name(target_env)),
        )

        script_asset = s3_assets.Asset(
            self,
            "SeminoleRefreshScript",
            path="src/oracle_pipeline/jobs/seminole_refresh.py",
        )

        # Ships the whole `oracle_pipeline` package so the job script can import the
        # shared manifest writer instead of duplicating it inline.
        library_asset = s3_assets.Asset(
            self,
            "PipelineLibrary",
            path="src",
            exclude=["oracle_pipeline_infra", "oracle_pipeline_infra/**", "**/__pycache__/**"],
        )

        job_role = iam.Role(
            self,
            "SeminoleRefreshRole",
            # jsii generates the concrete classes with `_`-prefixed parameter names, so a
            # strict checker sees them as incompatible with the protocols they implement.
            assumed_by=cast(iam.IPrincipal, iam.ServicePrincipal("glue.amazonaws.com")),
            description=f"Execution role for the {SERVICE_NAME} Seminole refresh Glue job",
            managed_policies=[
                iam.ManagedPolicy.from_aws_managed_policy_name("service-role/AWSGlueServiceRole")
            ],
        )
        data_bucket.grant_read_write(job_role)
        script_asset.grant_read(job_role)
        library_asset.grant_read(job_role)

        job_name = f"{SERVICE_NAME}-{target_env}-seminole-refresh"

        glue.CfnJob(
            self,
            "SeminoleRefreshJob",
            name=job_name,
            description="Phase 0 stub PySpark refresh for Seminole County, FL",
            role=job_role.role_arn,
            glue_version=GLUE_VERSION,
            worker_type=WORKER_TYPE,
            number_of_workers=NUMBER_OF_WORKERS,
            # A stub job that hangs should stop costing money on its own.
            timeout=30,
            max_retries=0,
            execution_property=glue.CfnJob.ExecutionPropertyProperty(
                max_concurrent_runs=1,
            ),
            command=glue.CfnJob.JobCommandProperty(
                name="glueetl",
                python_version="3",
                script_location=script_asset.s3_object_url,
            ),
            default_arguments={
                "--job-language": "python",
                "--extra-py-files": library_asset.s3_object_url,
                "--enable-metrics": "true",
                "--enable-observability-metrics": "true",
                "--enable-continuous-cloudwatch-log": "true",
                "--data_bucket": data_bucket_name,
                "--run_id": "phase-0-stub",
                "--TempDir": f"s3://{data_bucket_name}/staged/glue-temp/",
            },
        )

        # A terminal Glue failure must reach the same operations topic the DLQ alarms use,
        # so PagerDuty sees it through the one channel fan-out rather than a second path.
        events.Rule(
            self,
            "SeminoleRefreshFailed",
            description=f"Terminal state of {job_name} — notifies the operations topic",
            event_pattern=events.EventPattern(
                source=["aws.glue"],
                detail_type=["Glue Job State Change"],
                detail={"jobName": [job_name], "state": TERMINAL_JOB_STATES},
            ),
            targets=[cast(events.IRuleTarget, targets.SnsTopic(operations_topic))],
        )

        cdk.CfnOutput(self, "GlueJobName", value=job_name)
        cdk.CfnOutput(self, "GlueScriptLocation", value=script_asset.s3_object_url)

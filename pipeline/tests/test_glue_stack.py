"""Assertions that lock in the Glue tier's contract with the TypeScript tier."""

from __future__ import annotations

import aws_cdk as cdk
import pytest
from aws_cdk.assertions import Match, Template

from oracle_pipeline_infra.constants import (
    SERVICE_NAME,
    cost_tags,
    operations_topic_name,
    ssm_parameter_names,
)
from oracle_pipeline_infra.glue_stack import GlueStack


@pytest.fixture(scope="module")
def template() -> Template:
    app = cdk.App()
    stack = GlueStack(
        app,
        "TestGlue",
        target_env="dev",
        env=cdk.Environment(account="795366345505", region="us-east-2"),
        tags=cost_tags("dev"),
    )
    return Template.from_stack(stack)


def test_ssm_parameter_paths_match_the_typescript_tier() -> None:
    """`packages/shared/src/service.ts` owns these paths; drift here breaks the deploy."""
    assert ssm_parameter_names("dev") == {
        "data_bucket_name": "/oracle-seminole/dev/data-bucket-name",
        "operations_topic_arn": "/oracle-seminole/dev/operations-topic-arn",
        "table_name": "/oracle-seminole/dev/table-name",
    }


def test_cost_tags_use_the_service_name_as_project_name() -> None:
    """`project_name` must equal the `service` dimension carried by `CostPredicted`."""
    assert cost_tags("dev")["project_name"] == SERVICE_NAME


def test_glue_job_is_a_pyspark_job_with_bounded_cost(template: Template) -> None:
    template.resource_count_is("AWS::Glue::Job", 1)
    template.has_resource_properties(
        "AWS::Glue::Job",
        {
            "Name": "oracle-seminole-dev-seminole-refresh",
            "GlueVersion": "5.0",
            "WorkerType": "G.1X",
            "NumberOfWorkers": 2,
            "Timeout": 30,
            "MaxRetries": 0,
            "Command": Match.object_like({"Name": "glueetl", "PythonVersion": "3"}),
        },
    )


def test_glue_job_enables_metrics_and_continuous_logging(template: Template) -> None:
    template.has_resource_properties(
        "AWS::Glue::Job",
        {
            "DefaultArguments": Match.object_like(
                {
                    "--enable-metrics": "true",
                    "--enable-observability-metrics": "true",
                    "--enable-continuous-cloudwatch-log": "true",
                }
            )
        },
    )


def test_terminal_job_states_notify_the_operations_topic(template: Template) -> None:
    template.resource_count_is("AWS::Events::Rule", 1)
    template.has_resource_properties(
        "AWS::Events::Rule",
        {
            "EventPattern": Match.object_like(
                {
                    "source": ["aws.glue"],
                    "detail-type": ["Glue Job State Change"],
                    "detail": Match.object_like(
                        {"state": ["FAILED", "TIMEOUT", "ERROR", "STOPPED"]}
                    ),
                }
            ),
        },
    )


def test_operations_topic_arn_resolves_account_region_and_name(template: Template) -> None:
    """A token ARN leaves the rule's environment unresolved and fails `synth --strict`.

    Only the partition may stay symbolic; account, region, and topic name must be literal.
    """
    rule = next(iter(template.find_resources("AWS::Events::Rule").values()))
    arn = rule["Properties"]["Targets"][0]["Arn"]
    literal = "".join(part for part in arn["Fn::Join"][1] if isinstance(part, str))
    assert literal.endswith(f":sns:us-east-2:795366345505:{operations_topic_name('dev')}")


def test_stack_creates_no_lambda(template: Template) -> None:
    """Python is permitted for Glue only; a Python Lambda here would violate the stack rule."""
    template.resource_count_is("AWS::Lambda::Function", 0)

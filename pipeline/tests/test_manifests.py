"""Manifest writer tests, backed by moto rather than a mocked boto3 client."""

from __future__ import annotations

import json

import boto3
import pytest
from moto import mock_aws

from oracle_pipeline.manifests import manifest_key, write_manifest

BUCKET = "oracle-seminole-test-bucket"
REGION = "us-east-2"


@pytest.fixture
def s3_client():
    with mock_aws():
        client = boto3.client("s3", region_name=REGION)
        client.create_bucket(
            Bucket=BUCKET,
            CreateBucketConfiguration={"LocationConstraint": REGION},
        )
        yield client


def test_manifest_key_is_scoped_to_the_run() -> None:
    assert manifest_key("run-7") == "manifests/run-7/manifest.json"
    assert manifest_key("run-8") != manifest_key("run-7")


def test_write_manifest_stores_json_under_the_manifests_prefix(s3_client) -> None:
    payload = {"runId": "run-7", "county": "Seminole County, FL", "sources": []}

    key = write_manifest(BUCKET, "run-7", payload, client=s3_client)

    assert key == "manifests/run-7/manifest.json"
    stored = s3_client.get_object(Bucket=BUCKET, Key=key)
    assert stored["ContentType"] == "application/json"
    assert json.loads(stored["Body"].read()) == payload


def test_write_manifest_is_idempotent_for_the_same_run(s3_client) -> None:
    write_manifest(BUCKET, "run-7", {"attempt": 1}, client=s3_client)
    write_manifest(BUCKET, "run-7", {"attempt": 2}, client=s3_client)

    listing = s3_client.list_objects_v2(Bucket=BUCKET, Prefix="manifests/run-7/")
    assert listing["KeyCount"] == 1

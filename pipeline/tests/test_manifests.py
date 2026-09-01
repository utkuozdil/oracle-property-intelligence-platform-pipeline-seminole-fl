"""Manifest writer tests, backed by moto rather than a mocked boto3 client."""

from __future__ import annotations

import json

import boto3
import pytest
from moto import mock_aws

from oracle_pipeline.constants import fdor_pointer_key
from oracle_pipeline.manifests import (
    manifest_key,
    read_fdor_pointer,
    write_manifest,
    write_reconciliation,
)

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


def test_write_reconciliation_lands_beside_the_manifest(s3_client) -> None:
    document = {"version": 1, "overlap": {"matched": 178_863}}

    key = write_reconciliation(BUCKET, "run-7", document, client=s3_client)

    assert key == "manifests/run-7/reconciliation.json"
    stored = s3_client.get_object(Bucket=BUCKET, Key=key)
    assert json.loads(stored["Body"].read()) == document


def test_read_fdor_pointer_returns_none_before_any_snapshot_exists(s3_client) -> None:
    """The first run of a county, and any run before FDOR has ever been acquired."""
    assert read_fdor_pointer(BUCKET, client=s3_client) is None


def test_read_fdor_pointer_returns_the_snapshot_in_force(s3_client) -> None:
    pointer = {
        "runId": "run-1",
        "snapshotToken": "edit-1780974574367-n179107",
        "prefix": "raw/fdor/run-1/",
        "recordCount": 179_107,
    }
    s3_client.put_object(
        Bucket=BUCKET,
        Key=fdor_pointer_key(),
        Body=json.dumps(pointer).encode("utf-8"),
    )

    # A later run reconciles against run-1's snapshot without having fetched anything
    # itself, which is the normal case on 364 nights out of 365.
    assert read_fdor_pointer(BUCKET, client=s3_client) == pointer

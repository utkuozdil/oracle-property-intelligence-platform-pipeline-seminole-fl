"""Run-manifest writing, shared by every Glue job.

A manifest is the durable record that a run happened: which sources it read, how many
records it touched, and when. Phase 0 writes the envelope only.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import boto3

if TYPE_CHECKING:
    from mypy_boto3_s3.client import S3Client

MANIFEST_PREFIX = "manifests/"


def manifest_key(run_id: str) -> str:
    """Return the object key for a run's manifest.

    Keys are scoped by ``run_id`` so re-running never overwrites a previous manifest.
    """
    return f"{MANIFEST_PREFIX}{run_id}/manifest.json"


def write_manifest(
    bucket: str,
    run_id: str,
    payload: dict[str, Any],
    *,
    client: S3Client | None = None,
) -> str:
    """Write ``payload`` as the manifest for ``run_id`` and return the object key."""
    s3: S3Client = client if client is not None else boto3.client("s3")
    key = manifest_key(run_id)
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(payload, sort_keys=True).encode("utf-8"),
        ContentType="application/json",
    )
    return key

"""Run-manifest and change-set writing, shared by every Glue job.

A manifest is the durable record that a run happened: which sources it read, how many
records it touched, and when.

The canonical pointer at ``manifests/current/manifest.json`` is only ever updated by
copying a completed run-scoped manifest over it — never by writing to it in place. A
reader therefore sees either the previous complete manifest or the new one, never a
partial object, and a run that dies mid-write leaves the last good snapshot as the one
the next run diffs against.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import boto3

from oracle_pipeline.constants import (
    change_set_key,
    current_manifest_key,
    fdor_pointer_key,
    reconciliation_key,
)

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


def write_change_set(
    bucket: str,
    run_id: str,
    document: dict[str, Any],
    *,
    client: S3Client | None = None,
) -> str:
    """Write ``change_set.json`` for ``run_id`` and return the object key."""
    s3: S3Client = client if client is not None else boto3.client("s3")
    key = change_set_key(run_id)
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(document, sort_keys=True).encode("utf-8"),
        ContentType="application/json",
    )
    return key


def write_reconciliation(
    bucket: str,
    run_id: str,
    document: dict[str, Any],
    *,
    client: S3Client | None = None,
) -> str:
    """Write ``reconciliation.json`` for ``run_id`` and return the object key.

    Lands beside the run's manifest and change set rather than under a prefix of its own,
    because it describes the same run and is read by the same consumer.
    """
    s3: S3Client = client if client is not None else boto3.client("s3")
    key = reconciliation_key(run_id)
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(document, sort_keys=True).encode("utf-8"),
        ContentType="application/json",
    )
    return key


def read_fdor_pointer(
    bucket: str,
    *,
    client: S3Client | None = None,
) -> dict[str, Any] | None:
    """Read the pointer at the FDOR snapshot in force, or ``None`` when there is none.

    Absence is a normal state in two situations, and neither is an error: the very first
    run of a county, and any run where the FDOR acquisition failed before a snapshot had
    ever been landed. Reconciliation is a cross-check on the night's parcels, not a
    precondition for producing them, so the caller skips it rather than failing.
    """
    s3: S3Client = client if client is not None else boto3.client("s3")
    try:
        response = s3.get_object(Bucket=bucket, Key=fdor_pointer_key())
    except s3.exceptions.NoSuchKey:
        return None
    parsed: dict[str, Any] = json.loads(response["Body"].read())
    return parsed


def promote_manifest(
    bucket: str,
    run_id: str,
    *,
    client: S3Client | None = None,
) -> str:
    """Point ``manifests/current/manifest.json`` at ``run_id``'s manifest.

    A server-side copy of an already-durable object, so the pointer flips in one
    operation. Called only after the staged Parquet is written — the pointer's contract
    is "the last run whose output is complete", and it is what the next run reads to
    find the snapshot it must diff against.
    """
    s3: S3Client = client if client is not None else boto3.client("s3")
    target = current_manifest_key()
    s3.copy_object(
        Bucket=bucket,
        Key=target,
        CopySource={"Bucket": bucket, "Key": manifest_key(run_id)},
        ContentType="application/json",
        MetadataDirective="REPLACE",
    )
    return target


def read_current_manifest(
    bucket: str,
    *,
    client: S3Client | None = None,
) -> dict[str, Any] | None:
    """Read the current manifest pointer, or ``None`` on the very first run.

    Absence is a normal state, not an error: the first run of a county has nothing to
    diff against and treats every parcel as ``new``.
    """
    s3: S3Client = client if client is not None else boto3.client("s3")
    try:
        response = s3.get_object(Bucket=bucket, Key=current_manifest_key())
    except s3.exceptions.NoSuchKey:
        return None
    parsed: dict[str, Any] = json.loads(response["Body"].read())
    return parsed

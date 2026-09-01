"""Expansion of the source ZIP into per-table CSV objects Spark can read.

Spark cannot read a member of a ZIP archive directly, so something has to expand the
95 MB download into its 641 MB of CSVs. That happens here, on the Glue **driver**,
streaming one member at a time to S3 — not in a Lambda. A Lambda would need ephemeral
storage sized for the largest member and would be a Python data-processing Lambda, which
the stack rule forbids; the Glue driver already has the disk, already has the IAM grant
on the bucket, and is already the sanctioned place for Python.

The member list is validated against the expected table set before anything is written,
so a source that quietly drops a table fails here rather than three joins later.
"""

from __future__ import annotations

import zipfile
from collections.abc import Iterator
from typing import IO, TYPE_CHECKING, Final, NamedTuple

from oracle_pipeline.schema import CAMA_TABLES

if TYPE_CHECKING:
    from mypy_boto3_s3.client import S3Client

#: Streamed to S3 in 8 MiB parts. Large enough that the 185 MB member takes ~24 parts,
#: small enough that the driver never holds a whole table in memory.
UPLOAD_CHUNK_BYTES: Final = 8 * 1024 * 1024


class ArchiveMemberError(RuntimeError):
    """The archive's contents do not match the expected set of CAMA tables."""


class ExpandedTable(NamedTuple):
    """One CSV member written out of the archive."""

    table: str
    key: str
    uncompressed_bytes: int


def validate_members(member_names: list[str]) -> list[str]:
    """Assert the archive holds exactly the nine expected CSVs.

    Both directions are fatal, for the same reason column drift is: an archive missing
    ``Taxes.csv`` produces a snapshot with no tax data and no error, and an archive with
    a tenth table means the county changed something worth reading before ingesting.
    """
    expected = set(CAMA_TABLES)
    actual = {name for name in member_names if not name.endswith("/")}

    missing = sorted(expected - actual)
    unexpected = sorted(actual - expected)
    if missing or unexpected:
        raise ArchiveMemberError(
            f"archive members do not match the CAMA contract — "
            f"missing={missing or None}, unexpected={unexpected or None}"
        )
    return sorted(expected)


def _stream(handle: IO[bytes], chunk_bytes: int) -> Iterator[bytes]:
    while chunk := handle.read(chunk_bytes):
        yield chunk


def expand_archive(
    *,
    archive_path: str,
    bucket: str,
    destination_prefix: str,
    client: S3Client,
    chunk_bytes: int = UPLOAD_CHUNK_BYTES,
) -> list[ExpandedTable]:
    """Expand every CAMA table out of ``archive_path`` into ``destination_prefix``.

    Returns one :class:`ExpandedTable` per member. Uses a multipart upload per member so
    the 185 MB ``AllSales.csv`` never has to be buffered whole.
    """
    written: list[ExpandedTable] = []

    with zipfile.ZipFile(archive_path) as archive:
        tables = validate_members(archive.namelist())
        for table in tables:
            key = f"{destination_prefix}{table}"
            info = archive.getinfo(table)
            with archive.open(table) as member:
                _upload_stream(
                    body=_stream(member, chunk_bytes),
                    bucket=bucket,
                    key=key,
                    client=client,
                )
            written.append(ExpandedTable(table=table, key=key, uncompressed_bytes=info.file_size))

    return written


def _upload_stream(
    *,
    body: Iterator[bytes],
    bucket: str,
    key: str,
    client: S3Client,
) -> None:
    """Multipart-upload an iterator of chunks, aborting the upload on any failure.

    An abandoned multipart upload keeps billing for its parts indefinitely, so the abort
    is not optional cleanup — it is the difference between a failed run costing nothing
    and costing 641 MB of storage a month forever.
    """
    upload = client.create_multipart_upload(Bucket=bucket, Key=key, ContentType="text/csv")
    upload_id = upload["UploadId"]
    parts: list[dict[str, object]] = []

    try:
        buffer = bytearray()
        part_number = 1
        for chunk in body:
            buffer.extend(chunk)
            # S3 requires every part except the last to be at least 5 MiB.
            if len(buffer) >= UPLOAD_CHUNK_BYTES:
                parts.append(
                    _upload_part(client, bucket, key, upload_id, part_number, bytes(buffer))
                )
                buffer.clear()
                part_number += 1
        if buffer or not parts:
            parts.append(_upload_part(client, bucket, key, upload_id, part_number, bytes(buffer)))

        client.complete_multipart_upload(
            Bucket=bucket,
            Key=key,
            UploadId=upload_id,
            MultipartUpload={"Parts": parts},  # pyright: ignore[reportArgumentType]
        )
    except Exception:
        client.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
        raise


def _upload_part(
    client: S3Client,
    bucket: str,
    key: str,
    upload_id: str,
    part_number: int,
    body: bytes,
) -> dict[str, object]:
    response = client.upload_part(
        Bucket=bucket,
        Key=key,
        UploadId=upload_id,
        PartNumber=part_number,
        Body=body,
    )
    return {"ETag": response["ETag"], "PartNumber": part_number}

"""Snapshot diffing and the ``change_set.json`` document.

The shape follows the file-share sync workflow's manifest diff — the same four statuses
(``new`` / ``changed`` / ``unchanged`` / ``missing-on-source``), the same
``change_set.json`` artifact, and the same atomic manifest swap — because the problem is
the same problem: decide what actually moved between two snapshots of a source that
rewrites itself wholesale every night.

The difference is what a "key" is. That workflow keys on an S3 object and compares
ETags. Here the key is a parcel id and the comparison is the row hash from
:mod:`oracle_pipeline.rowhash`, because the source's own ETag is a rebuild timestamp
rather than a content digest and would report the entire county as changed nightly.

Pure module: the counts and statuses are decided here and the Glue job only supplies the
joined hash pairs.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Final, Literal

STATUS_NEW: Final = "new"
STATUS_CHANGED: Final = "changed"
STATUS_UNCHANGED: Final = "unchanged"
STATUS_MISSING_ON_SOURCE: Final = "missing-on-source"

ChangeStatus = Literal["new", "changed", "unchanged", "missing-on-source"]

CHANGE_STATUSES: Final[tuple[ChangeStatus, ...]] = (
    STATUS_NEW,
    STATUS_CHANGED,
    STATUS_UNCHANGED,
    STATUS_MISSING_ON_SOURCE,
)

#: Document schema version. Consumers pin it; the reconciliation report that reads this
#: artifact in Phase 1b must fail loudly rather than misread a future shape.
CHANGE_SET_VERSION: Final = 1

#: Fraction of the prior snapshot that may vanish before the run is treated as suspect.
#: Parcels do disappear — splits, merges, and municipal takings — but at a rate of tens
#: per year, not thousands. A source-side truncation shows up here first.
DEFAULT_MAX_MISSING_RATIO: Final = 0.02


class ChangeSetAnomalyError(RuntimeError):
    """The computed delta is too large to be a genuine night's worth of change."""


def classify(prior_hash: str | None, current_hash: str | None) -> ChangeStatus:
    """Classify one parcel from its prior and current row hashes.

    A parcel present on both sides with equal hashes is ``unchanged``; unequal is
    ``changed``. Present only now is ``new``. Present only before is
    ``missing-on-source`` — never "deleted", because the parcel may simply have been
    dropped from one nightly extract, and this pipeline does not delete published data
    on the strength of one absence.
    """
    if prior_hash is None and current_hash is None:
        raise ValueError("a parcel must exist on at least one side of the diff")
    if prior_hash is None:
        return STATUS_NEW
    if current_hash is None:
        return STATUS_MISSING_ON_SOURCE
    return STATUS_CHANGED if prior_hash != current_hash else STATUS_UNCHANGED


def classify_all(
    pairs: Iterable[tuple[str, str | None, str | None]],
) -> dict[str, ChangeStatus]:
    """Classify ``(parcel_id, prior_hash, current_hash)`` triples."""
    return {
        parcel_id: classify(prior_hash, current_hash)
        for parcel_id, prior_hash, current_hash in pairs
    }


def empty_counts() -> dict[str, int]:
    """A zeroed count for every status, so a key is never absent from the document."""
    return dict.fromkeys(CHANGE_STATUSES, 0)


def tally(statuses: Iterable[ChangeStatus]) -> dict[str, int]:
    """Count statuses into a complete, zero-filled tally."""
    counts = empty_counts()
    for status in statuses:
        counts[status] += 1
    return counts


def assert_delta_is_plausible(
    counts: Mapping[str, int],
    *,
    prior_total: int,
    max_missing_ratio: float = DEFAULT_MAX_MISSING_RATIO,
) -> None:
    """Fail the run when an implausible share of the prior snapshot disappeared.

    The first run has no prior snapshot, so there is nothing to compare and the check is
    skipped. Afterwards this is the backstop behind the row-count bounds: those catch a
    truncated *file*, this catches a source that shipped a complete-looking file
    describing a different, smaller county.
    """
    if prior_total <= 0:
        return
    missing = counts.get(STATUS_MISSING_ON_SOURCE, 0)
    ratio = missing / prior_total
    if ratio > max_missing_ratio:
        raise ChangeSetAnomalyError(
            f"{missing:,} of {prior_total:,} parcels ({ratio:.2%}) are missing on source, "
            f"above the {max_missing_ratio:.2%} ceiling — refusing to publish this snapshot"
        )


def build_change_set_document(
    *,
    run_id: str,
    county: str,
    source_url: str,
    source_etag: str | None,
    source_last_modified: str | None,
    source_fingerprint: str,
    snapshot_year: int,
    started_at: str,
    finished_at: str,
    counts: Mapping[str, int],
    prior_total: int,
    current_total: int,
    staged_prefix: str,
    partition_count: int,
) -> dict[str, Any]:
    """Assemble ``change_set.json``.

    Carries the full identity of the source snapshot alongside the delta so a consumer
    can tell which extract produced a given set of parcels without going back to the run
    manifest — the reconciliation report in Phase 1b needs exactly that pairing.
    """
    complete_counts = empty_counts() | dict(counts)
    return {
        "version": CHANGE_SET_VERSION,
        "runId": run_id,
        "county": county,
        "source": {
            "url": source_url,
            "etag": source_etag,
            "lastModified": source_last_modified,
            # Content digest of the downloaded archive. Unlike the ETag this really is a
            # function of the bytes, so it is what the idempotency ledger keys on.
            "fingerprint": source_fingerprint,
        },
        "snapshotYear": snapshot_year,
        "startedAt": started_at,
        "finishedAt": finished_at,
        "counts": complete_counts,
        "totals": {
            "prior": prior_total,
            "current": current_total,
            # `new + changed` is the set a downstream publisher must actually re-emit.
            "actionable": complete_counts[STATUS_NEW] + complete_counts[STATUS_CHANGED],
        },
        "output": {
            "stagedPrefix": staged_prefix,
            "format": "parquet",
            "partitionedBy": ["geohash5"],
            "partitionCount": partition_count,
        },
    }

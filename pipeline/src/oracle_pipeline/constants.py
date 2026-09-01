"""Runtime constants for the Glue tier.

These live in ``oracle_pipeline`` rather than ``oracle_pipeline_infra`` because only the
former is shipped to the Glue runtime — the CDK app excludes the infra package from the
``--extra-py-files`` library asset. The infra package imports from here, so the service
name that becomes the ``service`` metric dimension and the one that becomes the
``project_name`` cost tag are the same object rather than two strings kept in step.

Still mirrored by hand into `packages/shared/src/service.ts` for the TypeScript tier;
`tests/test_glue_stack.py` asserts the paths so a drift fails CI rather than a deploy.
"""

from __future__ import annotations

from typing import Final, Literal

SERVICE_NAME: Final = "oracle-seminole"
METRICS_NAMESPACE: Final = "OracleSeminole"
AWS_REGION: Final = "us-east-2"
COUNTY: Final = "Seminole County, FL"

TargetEnv = Literal["dev", "prod"]

#: Nightly CAMA extract. Rebuilt around 04:00 local, nine CSVs, ~95 MB compressed.
SOURCE_URL: Final = "https://files.scpafl.org/data/cama/SeminoleCounty.zip"

#: The host stalls — it does not 403 — when the request carries no browser-like
#: ``User-Agent``, so the header is part of the source contract rather than a nicety.
SOURCE_USER_AGENT: Final = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)

#: Object layout inside the data bucket, mirroring `DATA_PREFIXES` in the shared package.
RAW_PREFIX: Final = "raw/"
STAGED_PREFIX: Final = "staged/"
PUBLISH_PREFIX: Final = "publish/"
MANIFESTS_PREFIX: Final = "manifests/"

#: Where the joined, derived parcel snapshot lands, partitioned by ``geohash5``.
STAGED_PARCELS_PREFIX: Final = f"{STAGED_PREFIX}parcels/"


#: The archive and the CSVs expanded from it sit under sibling prefixes because they have
#: different lifetimes: the archive is the provenance record and is kept, the 640 MB of
#: CSVs are a derivable intermediate and are expired by an S3 lifecycle rule.
#:
#: The discriminator sits above the run id because an S3 lifecycle filter matches a
#: literal prefix with no wildcard — ``raw/<runId>/cama/`` could not be expressed as a
#: rule, and ``raw/expanded/`` can. Mirrored by `storage.ts` in the shared package.
RAW_ARCHIVE_PREFIX: Final = f"{RAW_PREFIX}archive/"
RAW_EXPANDED_PREFIX: Final = f"{RAW_PREFIX}expanded/"

#: The second parcel source: FDOR's certified 2025 NAL tax roll joined to parcel
#: centroids, published as a statewide Esri feature layer. Seminole is ``CO_NO=69``.
#: Acquired by the ``FetchFdor`` Lambda; this tier only ever reads what it landed.
FDOR_SOURCE_URL: Final = (
    "https://services9.arcgis.com/Gh9awoU677aKree0/ArcGIS/rest/services/"
    "Florida_Statewide_Parcel_Centroid_Version/FeatureServer/0"
)

#: A third sibling under ``raw/``, with its own lifetime: FDOR publishes once a year, so
#: a snapshot landed in August must still be there the following July. Mirrored by
#: `storage.ts`. Neither lifecycle expiry rule may reach this prefix.
RAW_FDOR_PREFIX: Final = f"{RAW_PREFIX}fdor/"


def fdor_pointer_key() -> str:
    """Stable pointer to the FDOR snapshot in force.

    The CAMA archive is re-downloaded nightly, so the transform can name its own run's
    archive directly. FDOR is annual, so on all but one night a year the run has no
    snapshot of its own and has to be told which previous run's snapshot to read. This
    indirection is what lets the acquisition step skip without stopping reconciliation.
    """
    return f"{RAW_FDOR_PREFIX}current.json"


def raw_archive_key(run_id: str) -> str:
    """Key of the downloaded source archive for a run."""
    return f"{RAW_ARCHIVE_PREFIX}{run_id}/SeminoleCounty.zip"


def raw_table_prefix(run_id: str) -> str:
    """Prefix the archive's CSV members are expanded to for a run.

    Everything written here is reproducible from the archive, so it is expected to be
    deleted by lifecycle policy well before the archive is.
    """
    return f"{RAW_EXPANDED_PREFIX}{run_id}/"


def change_set_key(run_id: str) -> str:
    """Key of a run's ``change_set.json``."""
    return f"{MANIFESTS_PREFIX}{run_id}/change_set.json"


def reconciliation_key(run_id: str) -> str:
    """Key of a run's ``reconciliation.json``, written beside its manifest."""
    return f"{MANIFESTS_PREFIX}{run_id}/reconciliation.json"


def current_manifest_key() -> str:
    """Stable pointer to the most recently completed run's manifest.

    Written by copying a run-scoped manifest over it, never by writing in place, so a
    reader either sees the previous complete manifest or the new one.
    """
    return f"{MANIFESTS_PREFIX}current/manifest.json"

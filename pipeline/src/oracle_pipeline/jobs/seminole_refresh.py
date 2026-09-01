"""Phase 0 stub Glue job for the Seminole County incremental refresh.

The job starts a Spark session, writes the run manifest envelope, and commits. It reads
no source data and performs no transformation — its purpose is to prove the Glue job,
its IAM role, its script and library assets, and its failure alerting are all deployed
and wired correctly.

``awsglue`` and ``pyspark`` are provided only by the Glue runtime, so they are not
installable locally and their imports are suppressed for basedpyright.
"""

from __future__ import annotations

import sys
from datetime import UTC, datetime

from awsglue.context import GlueContext  # pyright: ignore[reportMissingImports]
from awsglue.job import Job  # pyright: ignore[reportMissingImports]
from awsglue.utils import getResolvedOptions  # pyright: ignore[reportMissingImports]
from pyspark.context import SparkContext  # pyright: ignore[reportMissingImports]

from oracle_pipeline.manifests import write_manifest

REQUIRED_ARGS = ["JOB_NAME", "data_bucket", "run_id"]


def main() -> None:
    args = getResolvedOptions(sys.argv, REQUIRED_ARGS)

    spark_context = SparkContext.getOrCreate()
    glue_context = GlueContext(spark_context)
    job = Job(glue_context)
    job.init(args["JOB_NAME"], args)

    key = write_manifest(
        bucket=args["data_bucket"],
        run_id=args["run_id"],
        payload={
            "runId": args["run_id"],
            "county": "Seminole County, FL",
            "phase": "phase-0",
            "sources": [],
            "recordCounts": {},
            "startedAt": datetime.now(UTC).isoformat(),
        },
    )

    glue_context.get_logger().info(f"Wrote Phase 0 run manifest to {key}")

    job.commit()


if __name__ == "__main__":
    main()

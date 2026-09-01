"""Per-worker-unit business metrics for the Glue tier.

The rule is that metrics are emitted by each worker unit as it processes items, never
aggregated into one publish at a terminal step. In a Lambda fan-out the worker unit is
the invocation. In PySpark it is the **Spark partition**, so this module is called from
inside a ``mapInPandas`` on the executors: each partition emits its own metric set the
moment its rows have been streamed to the writer.

Measured on the first full run: 21 independent EMF emissions from 9 executors, summing
to exactly the 181,218 rows written. Note what that does *not* buy. Those 21 flushes
landed inside a 3.6-second window, because the stage they instrument is the write and
the write is short — so in CloudWatch, at its 60-second minimum resolution for standard
metrics, a county-sized run still resolves to a single bucket. The emission is genuinely
per worker unit and genuinely concurrent with the work; the visible *ramp* only appears
once the instrumented stage runs longer than a CloudWatch period. On a job this fast,
`SampleCount` is the honest evidence of per-unit emission, not the shape of the curve.

Mechanism, since this is not a Lambda: Powertools Metrics serialises to CloudWatch
Embedded Metric Format and writes it to stdout. CloudWatch Logs extracts EMF from any
log group, not only Lambda's. Observed routing on Glue 5.0: executor stdout lands in
``/aws-glue/jobs/error`` under a per-executor stream, unprefixed, and CloudWatch parses
the EMF from there. ``/aws-glue/jobs/logs-v2`` stayed empty on this run despite
continuous logging being enabled, so do not go looking for the metrics there.

:class:`~aws_lambda_powertools.metrics.EphemeralMetrics` rather than ``Metrics``:
``Metrics`` keeps a class-level metric store designed to be shared across a Lambda
container's invocations. On an executor that shared store would accumulate across every
partition the executor handles and double-count on each flush. ``EphemeralMetrics``
isolates the set per instance, which is exactly one partition here.

Raw ``put_metric_data`` is never used.
"""

from __future__ import annotations

import os
from typing import Any, Final

from aws_lambda_powertools.metrics import EphemeralMetrics, MetricUnit

from oracle_pipeline.constants import METRICS_NAMESPACE, SERVICE_NAME

#: Domain noun this job counts, matching `METRIC_ITEMS.parcel` in the TypeScript tier so
#: `ParcelProcessed` means the same thing whichever tier emitted it.
PARCEL_PROCESSED: Final = "ParcelProcessed"
PARCEL_FAILED: Final = "ParcelFailed"
PROCESSING_DURATION: Final = "ProcessingDuration"


def target_env() -> str:
    """Environment dimension, defaulting to ``dev`` when the job argument is absent."""
    return os.environ.get("TARGET_ENV", "dev")


def build_partition_metric_payload(
    *,
    partition_index: int,
    rows_processed: int,
    rows_failed: int,
    duration_ms: float,
    environment: str,
) -> dict[str, Any]:
    """Describe one partition's metric set.

    Split out from the emission so the values and dimensions are unit-testable without
    Powertools' stdout side effect.

    ``partition_index`` is carried as metadata, not a dimension: dimensions form the
    metric's identity in CloudWatch, and a per-partition dimension would mint a separate
    metric per partition on every run, making the county-wide counter unsummable and the
    custom-metric bill grow with the data.
    """
    if rows_processed < 0 or rows_failed < 0:
        raise ValueError("row counts cannot be negative")
    return {
        "dimensions": {"service": SERVICE_NAME, "environment": environment},
        "metadata": {"partitionIndex": partition_index},
        "metrics": {
            PARCEL_PROCESSED: rows_processed,
            PARCEL_FAILED: rows_failed,
            PROCESSING_DURATION: duration_ms,
        },
    }


def emit_partition_metrics(
    *,
    partition_index: int,
    rows_processed: int,
    rows_failed: int,
    duration_ms: float,
    environment: str | None = None,
) -> dict[str, Any]:
    """Emit one partition's metrics as EMF and return the payload that was emitted.

    Called on the executor, once per Spark partition. Returns the payload so the caller
    can log it in the job's structured log line without rebuilding it.
    """
    payload = build_partition_metric_payload(
        partition_index=partition_index,
        rows_processed=rows_processed,
        rows_failed=rows_failed,
        duration_ms=duration_ms,
        environment=environment if environment is not None else target_env(),
    )

    metrics = EphemeralMetrics(service=SERVICE_NAME, namespace=METRICS_NAMESPACE)
    for name, value in payload["dimensions"].items():
        metrics.add_dimension(name=name, value=value)
    metrics.add_metadata(key="partitionIndex", value=str(partition_index))
    metrics.add_metric(name=PARCEL_PROCESSED, unit=MetricUnit.Count, value=rows_processed)
    metrics.add_metric(name=PARCEL_FAILED, unit=MetricUnit.Count, value=rows_failed)
    metrics.add_metric(name=PROCESSING_DURATION, unit=MetricUnit.Milliseconds, value=duration_ms)
    # A partition that legitimately received zero rows must not raise; an empty geohash
    # cell is normal and is not worth failing a county-wide run over.
    metrics.flush_metrics(raise_on_empty_metrics=False)

    return payload

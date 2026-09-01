"""Tests for per-partition metric emission on the Glue executors.

The emission itself writes Embedded Metric Format to stdout, so these capture stdout and
assert on the EMF document — that is the actual contract with CloudWatch, and asserting
on it is what catches a Powertools upgrade quietly changing the serialisation.
"""

from __future__ import annotations

import json

import pytest

from oracle_pipeline.constants import METRICS_NAMESPACE, SERVICE_NAME
from oracle_pipeline.metrics import (
    PARCEL_FAILED,
    PARCEL_PROCESSED,
    PROCESSING_DURATION,
    build_partition_metric_payload,
    emit_partition_metrics,
)


class TestPayload:
    def test_carries_the_service_dimension_that_matches_the_cost_tag(self) -> None:
        # `service` must equal the CDK `project_name` tag or predicted spend and billed
        # spend cannot be joined on one key.
        payload = build_partition_metric_payload(
            partition_index=3,
            rows_processed=1_000,
            rows_failed=0,
            duration_ms=250.0,
            environment="dev",
        )
        assert payload["dimensions"] == {"service": SERVICE_NAME, "environment": "dev"}

    def test_partition_index_is_metadata_not_a_dimension(self) -> None:
        # A per-partition dimension would mint a distinct metric per partition per run,
        # making the county-wide counter unsummable and the bill grow with the data.
        payload = build_partition_metric_payload(
            partition_index=7,
            rows_processed=10,
            rows_failed=0,
            duration_ms=1.0,
            environment="dev",
        )
        assert payload["metadata"] == {"partitionIndex": 7}
        assert "partitionIndex" not in payload["dimensions"]

    def test_metric_names_are_pascal_case_nouns(self) -> None:
        for name in (PARCEL_PROCESSED, PARCEL_FAILED, PROCESSING_DURATION):
            assert name[0].isupper()
            assert "_" not in name and "-" not in name

    def test_negative_counts_are_rejected(self) -> None:
        with pytest.raises(ValueError):
            build_partition_metric_payload(
                partition_index=0,
                rows_processed=-1,
                rows_failed=0,
                duration_ms=1.0,
                environment="dev",
            )


def emitted_document(capsys: pytest.CaptureFixture[str]) -> dict:
    printed = capsys.readouterr().out.strip().splitlines()
    assert printed, "nothing was written to stdout, so CloudWatch would see no metric"
    return json.loads(printed[-1])


def metric_value(document: dict, name: str) -> float:
    """Read one metric out of an EMF document.

    EMF carries each metric as an array, because the format allows several observations
    of the same metric in one blob. Emissions here are one value per partition, so the
    array always has exactly one element — asserted rather than assumed, since a stray
    second element would mean a metric store leaked across partitions.
    """
    raw = document[name]
    values = raw if isinstance(raw, list) else [raw]
    assert len(values) == 1, f"{name} carried {len(values)} values, expected exactly one"
    return values[0]


class TestEmission:
    def test_writes_parseable_emf_to_stdout(self, capsys: pytest.CaptureFixture[str]) -> None:
        # stdout is the transport: CloudWatch Logs extracts EMF from the executor stream.
        emit_partition_metrics(
            partition_index=1,
            rows_processed=3_236,
            rows_failed=0,
            duration_ms=412.5,
            environment="dev",
        )
        document = emitted_document(capsys)
        assert document["_aws"]["CloudWatchMetrics"][0]["Namespace"] == METRICS_NAMESPACE
        assert metric_value(document, PARCEL_PROCESSED) == 3_236
        assert document["service"] == SERVICE_NAME

    def test_declares_the_service_and_environment_dimension_set(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        emit_partition_metrics(
            partition_index=0,
            rows_processed=1,
            rows_failed=0,
            duration_ms=1.0,
            environment="prod",
        )
        dimensions = emitted_document(capsys)["_aws"]["CloudWatchMetrics"][0]["Dimensions"]
        assert dimensions == [["service", "environment"]]

    def test_an_empty_partition_emits_rather_than_raising(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # An empty geohash cell is normal and must not fail a county-wide run.
        emit_partition_metrics(
            partition_index=55,
            rows_processed=0,
            rows_failed=0,
            duration_ms=0.0,
            environment="dev",
        )
        assert metric_value(emitted_document(capsys), PARCEL_PROCESSED) == 0

    def test_each_call_emits_its_own_count_without_accumulating(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """The reason this uses `EphemeralMetrics` rather than `Metrics`.

        An executor handles many partitions in sequence. A shared class-level metric
        store would carry the previous partition's rows into the next flush, so the
        county total would be inflated by every re-flush. Two emissions must report
        their own values and sum to the truth.
        """
        emit_partition_metrics(
            partition_index=0,
            rows_processed=100,
            rows_failed=0,
            duration_ms=1.0,
            environment="dev",
        )
        first = metric_value(emitted_document(capsys), PARCEL_PROCESSED)

        emit_partition_metrics(
            partition_index=1,
            rows_processed=50,
            rows_failed=0,
            duration_ms=1.0,
            environment="dev",
        )
        second = metric_value(emitted_document(capsys), PARCEL_PROCESSED)

        assert (first, second) == (100, 50)
        assert first + second == 150

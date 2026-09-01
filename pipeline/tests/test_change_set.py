"""Tests for snapshot diffing and the ``change_set.json`` contract.

The document these produce is read by a Zod schema in the `RecordRun` Lambda, so the
shape assertions here are one half of a cross-language contract; breaking either side
without the other fails the run at the recording step rather than silently.
"""

from __future__ import annotations

import pytest

from oracle_pipeline.change_set import (
    CHANGE_SET_VERSION,
    STATUS_CHANGED,
    STATUS_MISSING_ON_SOURCE,
    STATUS_NEW,
    STATUS_UNCHANGED,
    ChangeSetAnomalyError,
    assert_delta_is_plausible,
    build_change_set_document,
    classify,
    classify_all,
    empty_counts,
    tally,
)


class TestClassify:
    def test_absent_before_is_new(self) -> None:
        assert classify(None, "abc") == STATUS_NEW

    def test_absent_now_is_missing_on_source(self) -> None:
        # Deliberately not "deleted": one night's absence is not proof of removal.
        assert classify("abc", None) == STATUS_MISSING_ON_SOURCE

    def test_equal_hashes_are_unchanged(self) -> None:
        assert classify("abc", "abc") == STATUS_UNCHANGED

    def test_differing_hashes_are_changed(self) -> None:
        assert classify("abc", "def") == STATUS_CHANGED

    def test_absent_on_both_sides_is_a_programming_error(self) -> None:
        # A parcel in neither snapshot should never have reached the diff at all.
        with pytest.raises(ValueError):
            classify(None, None)


class TestTally:
    def test_every_status_is_present_even_at_zero(self) -> None:
        # Consumers index these keys directly, so a missing key is a KeyError downstream.
        assert set(empty_counts()) == {
            STATUS_NEW,
            STATUS_CHANGED,
            STATUS_UNCHANGED,
            STATUS_MISSING_ON_SOURCE,
        }
        assert all(value == 0 for value in empty_counts().values())

    def test_counts_each_status(self) -> None:
        counts = tally([STATUS_NEW, STATUS_NEW, STATUS_CHANGED, STATUS_UNCHANGED])
        assert counts[STATUS_NEW] == 2
        assert counts[STATUS_CHANGED] == 1
        assert counts[STATUS_UNCHANGED] == 1
        assert counts[STATUS_MISSING_ON_SOURCE] == 0

    def test_classify_all_keys_by_parcel(self) -> None:
        result = classify_all(
            [
                ("01-20-30-300-0010-0000", None, "h1"),
                ("01-20-30-300-0020-0000", "h2", "h2"),
                ("01-20-30-300-0030-0000", "h3", None),
            ]
        )
        assert result == {
            "01-20-30-300-0010-0000": STATUS_NEW,
            "01-20-30-300-0020-0000": STATUS_UNCHANGED,
            "01-20-30-300-0030-0000": STATUS_MISSING_ON_SOURCE,
        }


class TestDeltaPlausibility:
    def test_first_run_has_nothing_to_compare(self) -> None:
        assert_delta_is_plausible({STATUS_MISSING_ON_SOURCE: 0}, prior_total=0)

    def test_a_normal_night_of_churn_passes(self) -> None:
        # Tens of parcels vanish per year through splits, merges, and takings.
        assert_delta_is_plausible({STATUS_MISSING_ON_SOURCE: 40}, prior_total=181_218)

    def test_a_truncated_source_is_refused(self) -> None:
        # Half the county disappearing overnight is a bad file, not a bad night.
        with pytest.raises(ChangeSetAnomalyError):
            assert_delta_is_plausible({STATUS_MISSING_ON_SOURCE: 90_000}, prior_total=181_218)

    def test_the_boundary_itself_is_allowed(self) -> None:
        assert_delta_is_plausible(
            {STATUS_MISSING_ON_SOURCE: 200}, prior_total=10_000, max_missing_ratio=0.02
        )


def build(**overrides: object) -> dict:
    defaults = {
        "run_id": "run-20260901T121923Z",
        "county": "Seminole County, FL",
        "source_url": "https://files.scpafl.org/data/cama/SeminoleCounty.zip",
        "source_etag": '"951370b7e839dd1:0"',
        "source_last_modified": "Tue, 01 Sep 2026 08:05:56 GMT",
        "source_fingerprint": "30d40230c83d5d1de40b9d4b9fe0a217656d4f252bdb03281045dea169a048ad",
        "snapshot_year": 2026,
        "started_at": "2026-09-01T12:20:19.192064+00:00",
        "finished_at": "2026-09-01T12:22:21.689601+00:00",
        "counts": {STATUS_NEW: 181_218},
        "prior_total": 0,
        "current_total": 181_218,
        "staged_prefix": "s3://bucket/staged/parcels/",
        "partition_count": 56,
    }
    return build_change_set_document(**(defaults | overrides))  # type: ignore[arg-type]


class TestChangeSetDocument:
    def test_matches_the_shape_the_recorder_validates(self) -> None:
        document = build()
        assert document["version"] == CHANGE_SET_VERSION
        assert document["runId"] == "run-20260901T121923Z"
        assert document["output"] == {
            "stagedPrefix": "s3://bucket/staged/parcels/",
            "format": "parquet",
            "partitionedBy": ["geohash5"],
            "partitionCount": 56,
        }

    def test_zero_fills_statuses_the_caller_omitted(self) -> None:
        assert build()["counts"] == {
            STATUS_NEW: 181_218,
            STATUS_CHANGED: 0,
            STATUS_UNCHANGED: 0,
            STATUS_MISSING_ON_SOURCE: 0,
        }

    def test_actionable_is_what_a_publisher_must_re_emit(self) -> None:
        # Unchanged parcels are deliberately excluded: re-publishing them is the cost
        # the row hash exists to avoid.
        document = build(counts={STATUS_NEW: 10, STATUS_CHANGED: 5, STATUS_UNCHANGED: 181_203})
        assert document["totals"]["actionable"] == 15

    def test_carries_the_source_identity_alongside_the_delta(self) -> None:
        # Phase 1b's reconciliation report has to pair a parcel set with the exact
        # extract that produced it without re-reading the run manifest.
        source = build()["source"]
        assert source["etag"] == '"951370b7e839dd1:0"'
        assert source["fingerprint"].startswith("30d40230")

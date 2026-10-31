import json
from pathlib import Path
import tempfile
import unittest

from metrics import score
from refinement import paired_summary, report


def row(sid, reference, live, candidate, cluster=None, ok=True):
    return {"id": sid, "cluster": cluster or sid, "reference": reference, "text": live,
            "refined_text": candidate, "live_score": score(reference, live), "refined_score": score(reference, candidate),
            "ok": ok, "duration_s": 5, "refinement_s": 1,
            "refinement": {"items": [{"state": "ready"}]}}


class RefinementBenchmarkChecks(unittest.TestCase):
    def test_paired_aggregate_and_accent_preservation(self):
        rows = [row("vi", "tiếng Việt", "tieng Viet", "tiếng Việt"),
                row("en", "a b c", "a b c", "a x c")]
        s = paired_summary(rows)
        self.assertEqual(s["live_wer_pct"], 40)
        self.assertEqual(s["candidate_wer_pct"], 20)
        self.assertEqual(s["delta_wer_pp"], -20)
        self.assertEqual((s["clips_better"], s["clips_worse"]), (1, 1))

    def test_same_meeting_conditions_are_one_cluster(self):
        rows = [row("mic1", "a b", "a", "a b", cluster="meeting1"),
                row("mic2", "a b", "a", "a b", cluster="meeting1")]
        s = paired_summary(rows)
        self.assertEqual(s["clusters"], 1)
        self.assertEqual(s["delta_wer_bootstrap95_pp"], [-50, -50])

    def test_failed_live_is_not_excluded_and_refinement_fallback_is_explicit(self):
        failed = row("failure", "a b", "", "", ok=False)
        s = paired_summary([failed])
        self.assertEqual((s["live_failures"], s["live_wer_pct"], s["candidate_wer_pct"]), (1, 100, 100))
        fallback = row("fallback", "a b", "a", "a")
        fallback["refinement_error"] = "timeout"
        fallback["refinement"]["items"] = [{"state": "failed"}]
        s = paired_summary([fallback])
        self.assertEqual(s["delta_wer_pp"], 0)
        self.assertEqual(s["refinement_request_failures"], 1)
        self.assertEqual(s["segment_states"]["failed"], 1)

    def test_incomplete_or_duplicate_rows_cannot_be_reported_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            (out / "manifest.json").write_text(json.dumps({"samples": [{"id": "a"}, {"id": "b"}]}))
            for rows in ([{"id": "a"}], [{"id": "a"}, {"id": "a"}]):
                (out / "pairs.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
                with self.assertRaisesRegex(RuntimeError, "Incomplete/mismatched"):
                    report(out)


if __name__ == "__main__":
    unittest.main()

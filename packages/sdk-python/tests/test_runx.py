import json
import sys
import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from runx import (
    RunxClient,
    SkillSearchResult,
    create_framework_bridge,
    create_openai_adapter,
    normalize_framework_result,
)


class RunxClientTests(unittest.TestCase):
    def test_parses_search_results(self) -> None:
        result = SkillSearchResult.from_dict(
            {
                "skill_id": "acme/sourcey",
                "name": "sourcey",
                "owner": "acme",
                "source": "runx-registry",
                "source_label": "runx registry",
                "source_type": "cli-tool",
                "trust_tier": "community",
                "required_scopes": ["repo:read"],
                "tags": ["docs"],
                "version": "1.0.0",
            }
        )

        self.assertEqual(result.skill_id, "acme/sourcey")
        self.assertEqual(result.required_scopes, ("repo:read",))
        self.assertEqual(result.tags, ("docs",))

    def test_invokes_runx_cli_compatible_json_surface(self) -> None:
        with TemporaryDirectory() as tmp:
            fake_runx = Path(tmp) / "fake_runx.py"
            fake_runx.write_text(
                textwrap.dedent(
                    """
                    import json
                    import sys

                    args = sys.argv[1:]
                    if args[:2] == ["skill", "search"]:
                        print(json.dumps({
                            "status": "success",
                            "results": [{
                                "skill_id": "acme/sourcey",
                                "name": "sourcey",
                                "owner": "acme",
                                "source": "runx-registry",
                                "source_label": "runx registry",
                                "source_type": "cli-tool",
                                "trust_tier": "community",
                                "required_scopes": [],
                                "tags": [],
                            }],
                        }))
                    else:
                        print(json.dumps({"status": "success", "args": args}))
                    """
                ).strip()
            )

            client = RunxClient(command=(sys.executable, str(fake_runx)))
            results = client.search_skills("sourcey")
            run_report = client.run_skill("skills/example", inputs={"message": "hi"})

            self.assertEqual(results[0].skill_id, "acme/sourcey")
            self.assertEqual(
                run_report["args"],
                ["skill", "skills/example", "--message", "hi", "--non-interactive", "--json"],
            )

    def test_resume_run_posts_answers_and_approvals_json(self) -> None:
        with TemporaryDirectory() as tmp:
            fake_runx = Path(tmp) / "fake_runx.py"
            output_path = Path(tmp) / "payload.json"
            fake_runx.write_text(
                textwrap.dedent(
                    f"""
                    import json
                    import pathlib
                    import sys

                    args = sys.argv[1:]
                    if args[:1] == ["resume"]:
                        payload = json.loads(sys.stdin.read())
                        pathlib.Path({str(output_path)!r}).write_text(json.dumps(payload))
                        print(json.dumps({{"status": "success", "args": args}}))
                    else:
                        print(json.dumps({{"status": "success", "args": args}}))
                    """
                ).strip()
            )

            client = RunxClient(command=(sys.executable, str(fake_runx)))
            client.resume_run("run-123", answers={"req-1": {"ok": True}}, approvals={"gate-1": True})

            payload = json.loads(output_path.read_text())
            self.assertEqual(payload["answers"]["req-1"]["ok"], True)
            self.assertEqual(payload["approvals"]["gate-1"], True)

    def test_framework_bridge_resumes_paused_runs(self) -> None:
        class FakeClient:
            def __init__(self) -> None:
                self.resume_calls: list[tuple[str, dict[str, object], dict[str, bool]]] = []

            def run_skill(self, skill_path: str, inputs=None, non_interactive: bool = True):
                return {
                    "status": "needs_resolution",
                    "run_id": "run-123",
                    "skill": {"name": skill_path},
                    "requests": [
                        {"id": "req-1", "kind": "cognitive_work", "prompt": "Need a fix"},
                        {"kind": "approval", "gate": {"id": "gate-1"}},
                    ],
                }

            def resume_run(self, run_id: str, answers=None, approvals=None):
                self.resume_calls.append((run_id, dict(answers or {}), dict(approvals or {})))
                return {
                    "status": "success",
                    "skill": {"name": "skills/sourcey"},
                    "execution": {"stdout": "done"},
                    "receipt": {"id": "receipt-123"},
                }

        bridge = create_framework_bridge(FakeClient())
        result = bridge.run(
            "skills/sourcey",
            resolver=lambda context: True if context.request.get("kind") == "approval" else {"draft": "apply docs update"},
        )

        self.assertEqual(result.status, "completed")
        self.assertEqual(result.receipt_id, "receipt-123")

    def test_openai_adapter_formats_framework_result(self) -> None:
        class FakeClient:
            def run_skill(self, skill_path: str, inputs=None, non_interactive: bool = True):
                return {
                    "status": "success",
                    "skill": {"name": skill_path},
                    "execution": {"stdout": "built docs"},
                    "receipt": {"id": "receipt-456"},
                }

            def resume_run(self, run_id: str, answers=None, approvals=None):
                raise AssertionError("resume_run should not be called")

        adapter = create_openai_adapter(create_framework_bridge(FakeClient()))
        response = adapter.run("skills/sourcey")

        self.assertEqual(response["role"], "tool")
        self.assertEqual(response["structuredContent"]["runx"]["status"], "completed")
        self.assertEqual(response["structuredContent"]["runx"]["receipt_id"], "receipt-456")

    def test_normalize_framework_result_maps_denial(self) -> None:
        result = normalize_framework_result(
            {
                "status": "policy_denied",
                "skill": {"name": "skills/sourcey"},
                "reasons": ["missing approval"],
                "receipt": {"id": "receipt-789"},
            }
        )

        self.assertEqual(result.status, "denied")
        self.assertEqual(result.reasons, ("missing approval",))


if __name__ == "__main__":
    unittest.main()

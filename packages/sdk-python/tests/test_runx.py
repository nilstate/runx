import json
import sys
import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from runx import RunxClient, SkillSearchResult


class RunxClientTests(unittest.TestCase):
    def test_parses_search_results(self) -> None:
        result = SkillSearchResult.from_dict(
            {
                "skill_id": "0state/sourcey",
                "name": "sourcey",
                "owner": "0state",
                "source": "runx-registry",
                "source_label": "runx registry",
                "source_type": "cli-tool",
                "trust_tier": "runx-derived",
                "required_scopes": ["repo:read"],
                "tags": ["docs"],
                "version": "1.0.0",
            }
        )

        self.assertEqual(result.skill_id, "0state/sourcey")
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
                                "skill_id": "0state/sourcey",
                                "name": "sourcey",
                                "owner": "0state",
                                "source": "runx-registry",
                                "source_label": "runx registry",
                                "source_type": "cli-tool",
                                "trust_tier": "runx-derived",
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

            self.assertEqual(results[0].skill_id, "0state/sourcey")
            self.assertEqual(
                run_report["args"],
                ["skill", "skills/example", "--message", "hi", "--non-interactive", "--json"],
            )


if __name__ == "__main__":
    unittest.main()

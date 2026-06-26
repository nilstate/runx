# flaky-test-judge Report

- Package: `dh0h/flaky-test-judge@0.1.0`.
- CLI: `runx-cli 0.6.13`.
- Registry public URL: `https://runx.ai/x/dh0h/flaky-test-judge`.
- Public PR URL: `https://github.com/runxhq/runx/pull/147`.
- Source URL: `https://github.com/dh0h/runx/tree/codex/flaky-test-judge/skills/flaky-test-judge`.
- Local harness: passed with two cases, `quarantine_justified` and `missing_run_history`.
- Quarantine case: 65% pass rate over 20 supplied runs; 7 failures; 6 timeout failures.
- Quarantine output: `disposition.decision=quarantine`, confidence `0.84`, duration `3` days, marker `@flaky-quarantine:flaky-test-judge`.
- Stop case: no run history produces `disposition.decision=stop`, `reason_code=missing-evidence`, `quarantine_packet=null`, and exits as the required stop/error harness case.
- Dispatch: the packet names `issue-to-pr` and provides `thread_title`, `thread_body`, `target_repo`, and `base`; the skill never invokes the downstream lane.
- Human gate: any live disable still requires a separate governed `issue-to-pr` run and human merge approval.
- Registry publish: passed; publish returned `status=published`, digest `sha256:f7221122e35e2ec46d935b90c8aad4b6d9f08bffb6b1707c60586282849920c2`, and profile digest `sha256:b8dfe2a52e6e5f89f11cd24f43338642fcec617dc347ff6c5b3a1c9fc7ee0b5c`.
- Clean install: `runx add dh0h/flaky-test-judge@0.1.0 --registry https://api.runx.ai` succeeded in an isolated directory.
- Post-publish dogfood: sealed receipt `sha256:afd608911f082cef36247da7a7fa752d41d75eaba826e3f335c4f31303669400`.
- Post-publish verify: valid; digest, content address, and Ed25519 signature all verified.
- Install/run/verify after publish:
  - `runx add dh0h/flaky-test-judge@0.1.0`
  - `runx skill dh0h/flaky-test-judge@0.1.0 --json`
  - `runx verify --receipt <receipt.json> --json`

Pending before Frantic delivery:

- Raw `X.yaml` URL from the final PR head commit.
- Raw `SKILL.md` URL from the final PR head commit.

# Flaky Test Judge delivery report

- Published `bbbbzzzzcc-afk/flaky-test-judge@sha-cd2fdb45ec9e` to the public Runx registry and confirmed the immutable package can be read back and installed into an empty directory.
- Opened upstream pull request [runxhq/runx#197](https://github.com/runxhq/runx/pull/197) with the skill definition, operator documentation, and exactly two harness cases.
- Exercised the published package against 20 supplied runs: 13 passes, six explicit timeout failures, and one assertion failure. The resulting pass rate is 65%.
- The reviewed disposition is `quarantine` with confidence `0.96`, a seven-day ceiling, an explicit pytest exclusion marker, and downstream handoff target `issue-to-pr`.
- The empty-history boundary refuses to invent evidence. The harness leaves it at `needs_agent`, and the independent fixture requires a `missing-evidence` stop, no quarantine object, and no dispatch target.
- The skill is evidence-only. It does not edit repositories, change CI, disable a test, open an issue, create a pull request, or merge code.
- The dogfood run emitted receipt `runx:receipt:c4bb972e74c43278b503eba0cc076b00264582addfce9a72eeadac8674f92550`.
- Independent verification of that receipt returned `valid: true` in production mode with no findings.
- Raw machine-readable evidence is in [`evidence.json`](./evidence.json), and the verification matrix is in [`verification.json`](./verification.json).

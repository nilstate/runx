# Receipt Evidence Bundle verification report

- Scope: one public `receipt-evidence-bundle` skill package with a Node runner,
  a governed `X.yaml` profile, and embedded hosted-harness cases.
- CLI: `runx-cli 0.6.13`, installed from the official checksummed release.
- Harness: 3 cases passed with zero assertion errors.
- Positive path: two valid caller-supplied receipt verifications produce a
  sealed packet with verified facts, bounded parent-child inference, missing
  evidence, reviewer actions, redaction notes, and artifact links.
- Refusal path: a malformed receipt reference exits non-zero and seals the
  expected failed process receipt.
- Verification gate: an invalid verification verdict exits non-zero and seals
  the expected failed process receipt.
- Redaction: sensitive-key values, bearer/provider tokens, PEM private keys,
  and caller-supplied literal terms are removed before fact extraction.
- Dogfood: the valid harness run minted receipt
  `sha256:63deddf28a3f5712f3109bf81bd8e59b9daa972e2b90878a1d839467ae360157`.
- Receipt verification: `runx verify` returned `valid: true`, production
  signature mode, one receipt in the tree, and no findings.
- Reviewer replay: inspect `references/harness.json`, then run the commands in
  `references/evidence.json` with an authorized receipt verification key.
- Safety boundary: the skill has no network, wallet, signing, payout, or
  mutation authority; it only summarizes verification results supplied by the
  caller and refuses unsupported evidence.
- Source: `https://github.com/zdfgu113/runx/tree/codex/receipt-evidence-bundle/skills/receipt-evidence-bundle`.
- Registry target: `https://runx.ai/x/zdfgu113/receipt-evidence-bundle`.

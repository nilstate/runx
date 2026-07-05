# answer-from-docs Report

- Package: `answer-from-docs@0.1.0`.
- CLI: `runx-cli 0.6.16`.
- Local harness: passed with `grounded-policy-answer` and `refused-uncovered-question`.
- Dogfood receipt: `sha256:bcb85e5dbe78616efff4231821534b56ee640e8c3b44dfa0e2822dcfdd3bf770`.
- Verification: `runx verify` returned `valid: true` for the dogfood receipt with local-development signatures.
- Inputs: `question` and `corpus[]`.
- Outputs: `answer`, `kb_gaps[]`, and `grounded`.
- Grounded behavior: the password-policy question returns the cited corpus sentence from `acme-password-policy`.
- Refusal behavior: the travel-reimbursement question returns `grounded: false` and names missing evidence in `kb_gaps[]`.
- Boundary: the runner only reads supplied runx inputs and performs no network access, live retrieval, external fetch, mutation, or credential access.

## Commands

```sh
npx --yes @runxhq/cli@0.6.16 harness skills/answer-from-docs -R "$HOME/runx-answer-receipts" -j
npx --yes @runxhq/cli@0.6.16 skill skills/answer-from-docs --receipt-dir "$HOME/runx-answer-dogfood" -i "question=What must an Acme Cloud password contain?" --input-json corpus='[{"id":"acme-password-policy","title":"Acme Cloud password policy","text":"Acme Cloud passwords must contain at least twelve characters, one number, and one symbol. Administrators must rotate emergency access keys every ninety days."}]' -j
npx --yes @runxhq/cli@0.6.16 verify sha256:bcb85e5dbe78616efff4231821534b56ee640e8c3b44dfa0e2822dcfdd3bf770 --receipt-dir "$HOME/runx-answer-dogfood" --allow-local-development-signatures -j
```

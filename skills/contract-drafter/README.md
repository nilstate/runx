# Contract Drafter

Bounded contract outline composer.

## Inputs

- `parties[]` — non-empty array of `{role, name}`.
- `term` — non-empty duration string.
- `jurisdiction`, `payment_terms`, `governing_law`, `renewal`,
  `termination_for_convenience`, `liability_cap` — optional hints.

## Run

```bash
RUNX_INPUTS_PATH=fixtures/inputs.json node run.mjs | jq .
```

## Output schema

See `SKILL.md` for `runx.contract.draft.v1`.

This skill composes a draft outline only; it never sends for signature,
never uploads to DocuSign, never files anywhere.
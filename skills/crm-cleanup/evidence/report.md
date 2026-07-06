# Delivery Report — Frantic Bounty #79: crm-cleanup runx skill

**Bounty:** #79 ($8)
**Skill:** armstrongsam25/crm-cleanup
**Version:** sha-3ce7ea783bf5
**Date:** 2026-07-06

---

## 1. Overview

This report documents the delivery of the `crm-cleanup` runx skill for Frantic bounty #79. The skill reads an interaction transcript and a CRM schema, extracts grounded takeaways from the transcript, maps them to CRM fields allowed by the schema, and emits a gated `write_proposal`. The skill performs no live CRM write — the proposal is advisory only with `gate: "proposed"` and `performed_write: false`.

## 2. Skill Details

| Field | Value |
|---|---|
| Skill ID | `armstrongsam25/crm-cleanup` |
| Version | `sha-3ce7ea783bf5` |
| Category | ops |
| Trust tier | community |
| Source type | cli-tool |
| Registry page | https://runx.ai/x/armstrongsam25/crm-cleanup@sha-3ce7ea783bf5 |

## 3. Source Repository

- **Repo:** https://github.com/armstrongsam25/runx-crm-cleanup-skill
- **Commit SHA:** `bad3ec77d931b1a79d2234c7f06413a3c9539a9c`
- **Source URL (pinned):** https://github.com/armstrongsam25/runx-crm-cleanup-skill/tree/bad3ec77d931b1a79d2234c7f06413a3c9539a9c
- **Skill path:** `skills/crm-cleanup/`

## 4. Pull Request

- **PR:** https://github.com/runxhq/runx/pull/248
- **Title:** Add crm-cleanup skill
- **Head:** `armstrongsam25:skill/crm-cleanup`
- **Base:** `main`
- **State:** OPEN

## 5. Harness Verification (Hosted Registry)

| Field | Value |
|---|---|
| Status | **passed** |
| Cases | 3 |
| Checks passed | 3 |
| Checks failed | 0 |

### Cases

1. **sealed_transcript_yields_updates** (sealed) — Transcript with Sarah Chen from Acme Corp yields 4 takeaways and 4 field_updates
   - Receipt: `sha256:0b2cd9b1a54a6e9e162f0ae112a9569653cff0695a89bd3f188cd147b1246ecc`
2. **sealed_noop_empty_field_updates** (sealed) — General support call with no actionable CRM info yields empty field_updates
   - Receipt: `sha256:5e5a8a16053b9a119859037d9dc18a8988e14b4a934c38f150cfcb35d0d857db`
3. **stop_missing_transcript** (failure) — Empty transcript → failure/stop
   - Receipt: `sha256:4521b8fb5d8b4ee3d8c45222f48d01c68bd8b1d71c0f011f459ac78b6648b120`

## 6. Dogfood Test (Hosted Registry)

### Command

```bash
runx skill armstrongsam25/crm-cleanup@sha-3ce7ea783bf5 \
  --registry https://api.runx.ai \
  --input transcript='Call with Sarah Chen from Acme Corp on 2026-07-01...' \
  --input-json crm_schema='{"fields":[...]}' \
  --json
```

### Result

| Field | Value |
|---|---|
| Status | **sealed** |
| Run ID | `run_default_5ee7f8dfb719` |
| Receipt ID | `sha256:f365bdf83c3940321a7ae9292754dccd7431b870532e35104f1dfb91ed33d711` |
| Disposition | closed |
| Reason code | process_closed |

### Skill Output

- **Takeaways:** 4 grounded takeaways extracted from transcript:
  - tk1: company=Acme Corp (quote: "Call with Sarah Chen from Acme Corp")
  - tk2: deal_value=50000 (quote: "budget of 50000 for Q3")
  - tk3: stage=qualified (quote: "wants to move forward")
  - tk4: expected_close_date=July (quote: "expects to sign by end of July")
- **Field updates:** 4 field_updates mapped to crm_schema fields (company, deal_value, stage, expected_close_date)
- **Write proposal:** gate=proposed, performed_write=false — no live CRM write performed

## 7. Receipt Verification

| Check | Status |
|---|---|
| Overall valid | **true** |
| Digest | valid |
| Content address | valid |
| Signature | valid (production mode, kid: runx-demo-key) |

## 8. runx CLI Version

`runx-cli 0.6.16` (satisfies 0.6.14 floor)

## 9. New User Walkthrough

1. Install: `runx add armstrongsam25/crm-cleanup@sha-3ce7ea783bf5`
2. Run: `runx skill armstrongsam25/crm-cleanup@sha-3ce7ea783bf5 --input transcript='...' --input-json crm_schema='...' --json`
3. Verify: `runx verify --receipt <receipt.json> --json`

## 10. Conclusion

- ✅ Published to GitHub (public repo, commit-pinned source URL)
- ✅ PR #248 opened against runxhq/runx
- ✅ Harness passes 3/3 on the hosted runx registry
- ✅ Dogfood run from the hosted registry sealed successfully
- ✅ Receipt verified (valid signature, digest, content address)
- ✅ Write proposal is gated — no live CRM write performed
- ✅ Every field_update traces to a transcript takeaway and targets only schema-allowed fields

---
name: compliance-pack
description: Build a read-only compliance evidence pack by mapping declared controls to supplied evidence refs and reporting gaps without inventing attestation.
runx:
  category: ops
---

# Compliance Pack

Compliance Pack turns a small control set and a caller-supplied evidence index
into a reviewer-ready evidence packet. It maps each control to matching evidence
refs, explains the fit, summarizes coverage, and reports missing, stale, or
mismatched evidence as gaps.

This skill is a packaging and review aid. It does not file compliance reports,
attest on behalf of a company, call external auditors, fetch private documents,
or mark stale evidence as current. The caller remains responsible for reviewing
the pack before it is used in any formal compliance workflow.

## What This Skill Does

1. **Validate pack inputs.** Refuse when controls, evidence refs, or pack policy
   are missing or malformed.
2. **Evaluate evidence freshness.** Compare each evidence ref with
   `pack_policy.as_of_date` and `max_evidence_age_days` when supplied.
3. **Match controls to evidence.** A control maps only when an evidence ref
   explicitly lists the control id or a policy-defined tag match. The mapping
   cites the evidence ref and explains why it fits.
4. **Report gaps.** Missing evidence, stale evidence, failed status, or
   mismatched scope becomes a gap. The skill refuses to produce an
   `evidence_pack` when any required control remains uncovered.
5. **Emit a read-only packet.** A successful run emits `evidence_pack`,
   `control_map`, `gaps`, and `summary`. No source material is mutated.

## Contract Boundaries

- **Typed inputs are required.**
  - `controls[]`: control id, title, framework, requirement, and required flag.
  - `evidence_refs[]`: caller-supplied evidence refs with id, uri or digest,
    control ids or tags, status, collected date, owner, and summary.
  - `pack_policy`: as-of date, freshness window, framework, scope, and optional
    tag-to-control matching rules.
- **Typed output is deterministic.** The output contains `evidence_pack`,
  `control_map[]`, `gaps[]`, and `summary`.
- **Read-only behavior.** The skill performs no network calls, no provider
  writes, no filings, and no live attestations.
- **No invented evidence.** Every positive mapping cites a supplied evidence
  ref. Stale, failed, out-of-scope, or absent evidence is reported as a gap.

## Refusals And Stops

- Missing controls, evidence refs, or pack policy returns a refused result.
- A required control without current matching evidence returns a gap and no
  `evidence_pack`.
- Evidence with a failed status, stale collected date, or nonmatching scope does
  not cover a required control.
- Ambiguous matching is left as a gap for human review rather than inferred.

## Quality Profile

- Purpose: prepare a compact, auditable evidence pack for control review.
- Audience: security, compliance, procurement, and operator review teams.
- Artifact contract: evidence pack metadata, control-to-evidence map, gaps, and
  coverage summary.
- Evidence bar: every mapped control cites an input evidence ref and a fit
  explanation.
- Safety bar: no external filing, no live attestation, and no invented evidence.
- Stop conditions: missing input, stale evidence, failed evidence, out-of-scope
  evidence, or uncovered required controls.

## Output Schema

```yaml
evidence_pack:
  pack_id: string
  framework: string
  scope: string
  as_of_date: string
  controls_total: number
  controls_mapped: number
  evidence_refs:
    - id: string
      uri: string
      digest: string
      owner: string
      collected_at: string
control_map:
  - control_id: string
    control_title: string
    status: mapped | gap
    evidence_ref: string | null
    fit: string
    freshness_days: number | null
gaps:
  - control_id: string
    reason: missing_evidence | stale_evidence | failed_evidence | scope_mismatch | needs_human
    detail: string
summary:
  decision: ready | refused
  mapped_controls: number
  gap_count: number
  required_gap_count: number
  notes:
    - string
```

## Inputs

- `controls` (required): array of declared controls to map.
- `evidence_refs` (required): array of supplied evidence references.
- `pack_policy` (required): freshness, framework, scope, and optional matching
  rules.

---
name: postmortem-maker
description: Turn incident fragments (timeline, alerts, deploys, chat notes) into a traceable postmortem where every claim cites input evidence, unresolved facts go to unknowns, and a gated publish proposal is emitted only when the evidence is consistent — never posting or assigning anything.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
runx:
  tags:
    - incident
    - postmortem
    - sre
links:
  source: https://github.com/epistemedeus/postmortem-maker
---

## What this skill does

This skill turns incident fragments into a traceable postmortem **without
pretending unknowns are facts**. It reads `incident_timeline[]`, `alerts[]`,
`deploy_events[]`, `chat_notes[]`, and a `postmortem_policy`, then emits a
postmortem packet: `postmortem{summary,timeline,impact,root_cause,status}`,
`unknowns[]`, `action_items[]`, and — only when allowed — a `publish_proposal`.

Every input record gets a stable evidence ref (`incident_timeline[2]`,
`alerts[0]`, …). Every timeline entry and every root-cause claim cites the
ref(s) it came from. Facts that cannot be grounded — untimed records,
uncorroborated causes, contradictory statements, missing resolution evidence —
are recorded in `unknowns[]` instead of being asserted.

The skill is offline and effect-free beyond its own artifacts. It makes no
network calls and never posts, publishes, sends, or assigns anything; its only
writes are the `evidence.json`/`report.md` artifacts inside the skill
directory (`output_dir`, default `artifacts/`). Publishing the postmortem is
the gated `doc-publisher` executor's effect (or `send-as` for comms),
performed only after approval of the emitted proposal.

## When to use this skill

Use it after an incident, when the raw fragments (pager alerts, deploy log,
war-room chat, a rough timeline) exist but no postmortem does. It is
appropriate as the drafting step in an agent pipeline where a human or the
`doc-publisher` executor decides what actually gets published, and as the
evidence-grounded alternative to free-form LLM postmortem prose.

## When not to use this skill

Do not use it to publish or distribute a postmortem — it only proposes. Do not
treat a `determined` root cause as forensic truth: it means exactly one
candidate deploy preceding the incident start was corroborated by a timeline
event or chat note and disputed by none (multiple corroborated candidates or
any dispute yield `undetermined`), nothing more. Coverage is bounded by the
records provided; the skill never infers facts that are not literally in the
inputs.

## Procedure

1. Normalize the four evidence collections; give every record a stable ref
   (`kind[index]`) and parse its timestamp (`at`/`ts`/`timestamp`/…). String
   timestamps must carry an explicit UTC offset (`Z` or `+/-HH:MM`) or be a
   bare ISO date; offset-less local times parse differently per machine and
   are treated as unparseable (deterministic, reproducible receipts).
2. Merge all timestamped records into one chronological `postmortem.timeline`;
   each entry carries `evidence: [ref]`. Records without a parseable timestamp
   go to `unknowns` as `untimed_record`, never into the timeline.
3. Derive `impact` strictly from evidence: alerts fired/resolved, max severity,
   the impact window (first alert → resolved alert or timestamped resolution
   statement), and quoted impact statements with refs. A missing window end or
   an unresolved alert becomes an unknown; a fired alert counts as resolved
   only when a resolved alert exists for the same monitor — a generic
   resolution statement never silently resolves it; a resolution timestamped
   before the window start is a contradiction (`impact_window_contradictory`)
   and no end is asserted; no number is invented.
4. Determine `root_cause` only from an uncontradicted chain: a deploy event
   that precedes the incident start and is corroborated by a timeline event or
   chat note (matching its service/version on whole-token boundaries), citing
   all supporting refs. Multiple corroborated candidates, disputed candidates
   (negations like "ruled out", "not the cause", "isn't the cause"), or no
   corroboration ⇒ `status: "undetermined"` and the gap recorded in
   `unknowns`.
5. Emit `action_items[]`, each citing the evidence or unknown that motivates it
   and the policy rule when one applies; `owner` is always `null` — this skill
   assigns no work.
6. Check `postmortem_policy.required_sections`; an unmet required section is an
   unknown plus an action item, not a fabricated section.
7. Set `postmortem.status`: `ready_for_review` when the timeline is non-empty,
   the root cause is determined (or explicitly waived via
   `require_root_cause: false`), and there are no evidence conflicts;
   otherwise `draft_incomplete`.
8. Emit `publish_proposal` **only** when the policy allows publishing, the
   draft is `ready_for_review`, and `unknowns` is empty. Any unknown withholds
   the proposal (fail closed).
9. If a caller sets `apply`/`publish`/`post`/`assign`, refuse and stop.

## Edge cases and stop conditions

Stop with a governed refusal (non-zero exit) when:

- `postmortem_policy` is missing or not an object — publish gating and
  required sections cannot be resolved;
- no evidence records exist at all (all four collections empty) — nothing in a
  postmortem could cite input evidence;
- a collection input is not an array (or an unparseable JSON string);
- `apply`, `publish`, `post`, or `assign` is set — this skill never performs
  the publish itself.

The refusal message names the unresolved gaps.

Partial evidence does **not** refuse: it seals with `unknowns[]` populated,
`postmortem.status: "draft_incomplete"` where applicable, and no
`publish_proposal` — a provable, gated refusal to publish, not a crash.

## Output schema

The primary output is `postmortem_maker_result`, with schema
`postmortem.maker.result.v1`:

```json
{
  "schema": "postmortem.maker.result.v1",
  "skill": "postmortem-maker",
  "version": "0.1.0",
  "postmortem": {
    "summary": "Incident reconstructed from 7 evidence-cited timeline event(s); ...",
    "timeline": [
      {
        "at": "2026-03-14T09:05:00.000Z",
        "source": "deploy_events",
        "description": "deploy checkout-api 2026.03.14.1 by deploy-bot — ...",
        "evidence": ["deploy_events[0]"]
      }
    ],
    "impact": {
      "alerts_fired": 1,
      "alerts_resolved": 1,
      "max_severity": "critical",
      "window": { "start": "...", "end": "...", "duration_minutes": 45, "evidence": ["alerts[0]", "alerts[1]"] },
      "statements": [{ "text": "...", "evidence": ["incident_timeline[0]"] }],
      "note": "Derived only from supplied alerts and evidence statements; no figures are inferred."
    },
    "root_cause": {
      "status": "determined",
      "statement": "deploy of checkout-api 2026.03.14.1 (deploy_events[0]) at ... preceded the incident start at ... (alerts[0]) and is corroborated by incident_timeline[1], chat_notes[0].",
      "evidence": ["deploy_events[0]", "alerts[0]", "incident_timeline[1]", "chat_notes[0]"],
      "candidates": [ { "deploy": "deploy_events[0]", "corroborated_by": ["..."], "disputed_by": [] } ]
    },
    "status": "ready_for_review"
  },
  "unknowns": [],
  "action_items": [
    { "id": "AI-1", "title": "...", "evidence": ["deploy_events[0]"], "policy_rule": null, "owner": null }
  ],
  "publish_proposal": {
    "kind": "publish_proposal",
    "decision": "proposed",
    "performed_by": "doc-publisher",
    "requires_approval": true,
    "target": { "kind": "doc", "path": "postmortems/2026-03-14-checkout-api.md" },
    "document": { "title": "...", "format": "markdown", "sections": ["summary", "timeline", "impact", "root_cause", "action_items"] },
    "postmortem_digest": "sha256:...",
    "note": "Proposal only. postmortem-maker posts nothing and assigns no live tasks; the doc-publisher executor (or send-as for comms) performs the gated publish after approval."
  },
  "summary": {
    "timeline_count": 7,
    "unknown_count": 0,
    "action_item_count": 2,
    "root_cause_status": "determined",
    "postmortem_status": "ready_for_review",
    "proposal_status": "proposed",
    "alerts_fired": 1,
    "alerts_resolved": 1,
    "impact_window_minutes": 45
  },
  "validation": {
    "every_timeline_entry_cites_evidence": true,
    "root_cause_claim_cites_evidence": true,
    "unresolved_facts_in_unknowns": true,
    "proposal_iff_consistent": true,
    "no_live_post_or_assignment": true,
    "finding_rule": "..."
  }
}
```

With ambiguous evidence the run still seals: `unknowns[]` lists each gap with
its kind (`untimed_record`, `conflicting_root_cause_evidence`,
`root_cause_unresolved`, `impact_window_unresolved`,
`impact_window_contradictory`, `alert_unresolved`, `required_section_unmet`)
and its evidence refs, `postmortem.status` is `draft_incomplete`,
`proposal_status` is `withheld`, and `publish_proposal` is `null`.

The runner always writes `evidence.json` and `report.md` into `output_dir`
(default `artifacts/`, confined inside the skill directory).

## Worked example

Draft a postmortem from a consistent evidence chain (a deploy precedes the
first alert and both a timeline event and a chat note corroborate it):

```bash
runx skill "$PWD" \
  --input-json incident_timeline='[{"at":"2026-03-14T09:12:00Z","text":"Incident declared: checkout errors spiking"},{"at":"2026-03-14T09:55:00Z","text":"Checkout recovered; error rate back to baseline"}]' \
  --input-json alerts='[{"at":"2026-03-14T09:10:00Z","monitor":"checkout-5xx-rate","severity":"critical","status":"firing","summary":"5xx rate above 5% on checkout-api"},{"at":"2026-03-14T09:55:00Z","monitor":"checkout-5xx-rate","status":"resolved","summary":"recovered"}]' \
  --input-json deploy_events='[{"at":"2026-03-14T09:05:00Z","service":"checkout-api","version":"2026.03.14.1","summary":"Deploy checkout-api 2026.03.14.1"}]' \
  --input-json chat_notes='[{"at":"2026-03-14T09:50:00Z","author":"sre-oncall","text":"the checkout-api 2026.03.14.1 deploy is the root cause"}]' \
  --input-json postmortem_policy='{"allow_publish":true,"require_root_cause":true}' \
  --json
```

Expected: `postmortem.root_cause.status` is `determined` with cited refs,
`postmortem.status` is `ready_for_review`, and
`publish_proposal.performed_by` is `doc-publisher`. Removing the corroborating
note and adding a second pre-incident deploy makes the root cause
`undetermined`, populates `unknowns`, and withholds the proposal. Omitting
`postmortem_policy` entirely makes the skill refuse and stop.

## Inputs

- `incident_timeline`: incident timeline records (required; refs `incident_timeline[i]`).
- `alerts`: alert records `{ at, monitor, severity, status, summary }` (refs `alerts[i]`).
- `deploy_events`: deploy/change records `{ at, service, version, actor, summary }` (refs `deploy_events[i]`).
- `chat_notes`: notes `{ at?, author, text }`; untimed notes stay out of the timeline but can corroborate or dispute a cause (refs `chat_notes[i]`).
- `postmortem_policy`: `{ allow_publish, require_root_cause, required_sections[], publish_target, action_item_rules{max_items} }` — required by governance; the skill refuses without it. `allow_publish` defaults to **false** when unset (fail closed: a proposal is emitted only when the policy explicitly sets `allow_publish: true`); `require_root_cause` defaults to true.
- `apply`: must be absent or false; if set (also `publish`/`post`/`assign`), the skill refuses.
- `output_dir`: directory for `evidence.json` and `report.md` (default `artifacts/`, always written, confined to the skill directory).

## Outputs

- `postmortem_maker_result`: the complete packet.
- `postmortem`: `{ summary, timeline[], impact, root_cause, status }`, every entry evidence-cited.
- `unknowns`: unresolved facts `{ kind, detail, evidence[] }` — never asserted as facts.
- `action_items`: `{ id, title, evidence[], policy_rule, owner: null }` — grounded follow-ups, no assignment.
- `publish_proposal`: gated proposal for the `doc-publisher` executor (or `send-as` for comms), only when the policy allows it and unknowns is empty.

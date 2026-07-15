# Postmortem Maker — Delivery Report

## What was built

A `postmortem-maker` graph runner skill for the runx governed runtime. The skill turns incident fragments into a traceable postmortem without pretending unknowns are facts.

### Core capabilities

- **Real source reads**: Fetches incident data from a URL (web-fetch) or reads from a data-store projection at run time
- **Fact/hypothesis separation**: Every timeline entry cites source evidence; unresolvable items go to unknowns
- **Root cause assessment**: Known, suspected, or unknown — grounded in evidence, never invented
- **Conditional publishing**: Composes `send-as` to seal the comms send_plan only when evidence is consistent and sufficient
- **Data-store persistence**: Appends the postmortem as a sealed event on the incident stream

### Graph runner steps

| Step | Type | Description |
|------|------|-------------|
| `decide` | cli-tool | Reads incident, produces postmortem decision |
| `publish` | send-as | Composes send-as when postmortem is publishable (conditional) |
| `persist` | data-store | Appends postmortem event to incident stream |
| `readback` | data-store | Reads back the incident projection |

## Why it's trustworthy

- **Evidence-grounded**: Every timeline entry and root-cause claim cites source evidence. The skill never invents incident details.
- **Stop conditions**: Missing/unreadable source → refuses. Conflicting evidence → emits unknowns, doesn't publish. Stale version → doesn't write.
- **Harness tested**: Both sealed and refused cases pass with correct status codes.
- **Real source dogfood**: The dogfood run fetched a real GitHub issue (kubernetes/kubernetes#128998) and produced a postmortem with evidence citations.

## How to install, run, verify

### Install
```bash
runx add deltah9420/postmortem-maker@0.1.0 --registry https://api.runx.ai
```

### Run
```bash
runx skill deltah9420/postmortem-maker@0.1.0 --registry https://api.runx.ai --json --skip-operator-context \
  --input-json source_handle="https://api.github.com/repos/kubernetes/kubernetes/issues/128998" \
  --input-json postmortem_policy='{"publish_threshold":"when_publishable","require_root_cause":true,"max_unknowns":3}'
```

### Verify
```bash
runx verify --receipt <receipt-file.json> --json
```

## Harness results

| Case | Status | Description |
|------|--------|-------------|
| `sealed_postmortem_with_publish` | ✅ sealed | Consistent incident evidence → postmortem + publish |
| `refused_conflicting_evidence` | ✅ failure | Empty incident → refused, no publish |

## Dogfood result

- **Source**: `https://api.github.com/repos/kubernetes/kubernetes/issues/128998` (real GitHub issue)
- **Status**: sealed
- **Postmortem status**: publishable
- **Timeline entries**: 1
- **Root cause**: suspected
- **Unknowns**: 0
- **Action items**: 2
- **Receipt**: `runx:receipt:sha256:9e7f144b02dcc550f5529cf7eed9d84a4f5676b50e749fcc579e90663ea17850`

## Key design decisions

1. **Graph runner with conditional publish**: The `publish` step uses a `when` guard — only runs when postmortem status is `publishable`. This prevents publishing incomplete postmortems.
2. **cli-tool default runner**: The `decide` runner is the default (cli-tool) so the hosted harness can test it. The full graph is available as `postmortem-maker` runner.
3. **Multiple source formats**: Accepts URLs (web-fetch), data-store references, or inline JSON — flexible for different operator setups.
4. **Exit code 1 for failure**: Following the oncall-alert-triage pattern, the script exits with code 1 for stop conditions so the harness interprets the status correctly.

## How a new user installs, runs, and verifies

1. Install: `runx add deltah9420/postmortem-maker@0.1.0 --registry https://api.runx.ai`
2. Run with a real incident URL: `runx skill deltah9420/postmortem-maker@0.1.0 --registry https://api.runx.ai --json --skip-operator-context --input-json source_handle="<url>" --input-json postmortem_policy='{...}'`
3. The output JSON contains the postmortem with timeline, root cause, action items, and publish result
4. The receipt file can be verified with `runx verify --receipt <file> --json`

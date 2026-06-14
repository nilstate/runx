---
name: weather-forecast
description: Normalize provider weather evidence into an action-safe forecast packet with provenance, uncertainty, and stop conditions for downstream agents.
runx:
  category: data
---

# Weather Forecast

Turn weather provider evidence into a bounded forecast packet.

This is the canonical weather verb. It does not fetch provider data itself; it
normalizes evidence from a branded provider skill such as `nws-weather-forecast`
or from caller-supplied forecast material. It is context-only and read-only. Any
downstream action, alert, trip change, or production mutation needs its own
authority gate and receipt.

## What this skill does

`weather-forecast` reads provider evidence, extracts the forecast that matters
for the requested horizon and purpose, states uncertainty, and names what the
agent may and may not do with it. It keeps volatile forecast prose separate from
stable provider metadata and returns `needs_more_evidence` when the evidence is
missing, stale, out of area, or insufficient for the requested decision.

## When to use this skill

- A workflow has weather evidence and needs a concise packet for planning.
- A downstream travel, event, operations, or content skill needs weather context
  without direct provider coupling.
- A branded provider skill returned raw metadata or forecast JSON that should be
  interpreted before use.
- A receipt must prove which forecast evidence was consumed by the agent.

## When not to use this skill

- To fetch provider data directly. Use a branded provider skill such as
  `nws-weather-forecast`.
- For emergency, medical, aviation, maritime, evacuation, or life-safety
  decisions.
- To fabricate a forecast for an unsupported location or stale evidence.
- To send alerts, move schedules, notify customers, or change operations without
  the downstream action skill and its gate.

## Procedure

1. Identify the location, horizon, purpose, provider, and observation time.
2. Confirm the provider evidence is fresh enough for the purpose. If no
   timestamp or generated time is available, mark uncertainty clearly.
3. Extract the relevant periods, hazards, confidence notes, and source metadata.
4. State operational implications only within the requested purpose. Do not
   create advice outside the evidence.
5. Preserve provider refs, URLs, timestamps, and receipt refs in the packet.
6. Return `needs_input` for missing location, horizon, or purpose; return
   `needs_more_evidence` for stale, unsupported, or ambiguous evidence.
7. Refuse life-safety or regulated decisions and point the user to official
   channels.

## Edge cases and stop conditions

- **No provider evidence:** return `needs_more_evidence`.
- **Unsupported geography:** return `needs_input` with the supported provider
  coverage. NWS, for example, is United States focused.
- **Stale forecast:** return `needs_more_evidence` unless the user only needs a
  historical note.
- **Conflicting provider data:** preserve both sources and return
  `needs_more_evidence` for high-stakes uses.
- **Life-safety use:** return `refused`; do not provide emergency guidance.
- **Downstream mutation requested:** stop at context and require the action
  skill that owns the relevant authority gate.

## Output schema

```yaml
decision: ready | needs_input | needs_more_evidence | refused
location: string
horizon: string
forecast_packet:
  summary: string
  periods: array
  hazards: array
  confidence: string
  generated_at: string
provider_evidence:
  provider: string
  source_refs: array
  receipt_refs: array
safety_notes: array
stop_conditions: array
receipt_notes:
  authority: "context-only"
  mutation: false
```

## Worked example

Input: `nws-weather-forecast` returns a sealed forecast for `LWX/97,71`, and the
user asks whether an outdoor product demo tomorrow needs a backup plan.

Output: `decision: ready`; the packet summarizes the relevant forecast periods,
flags rain or wind risk if present, cites the NWS source refs, and says the
agent may recommend a backup plan but may not reschedule or notify attendees
without a separate action gate.

## Inputs

- `location` (required): place, coordinates, gridpoint, or provider location
  label.
- `forecast_evidence` (required): raw provider response, forecast periods,
  source refs, receipt refs, or a sealed branded skill output.
- `horizon` (optional): time range to interpret.
- `purpose` (optional): planning context, such as event, travel, field work, or
  content.
- `freshness_requirement` (optional): maximum acceptable age or timestamp
  policy.

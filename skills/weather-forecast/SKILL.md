---
name: weather-forecast
description: Normalize supplied provider weather evidence into a provenance-bound forecast packet with uncertainty and stop conditions. Use when a downstream planning workflow needs provider-neutral weather context; do not use it to fetch forecasts, make life-safety decisions, or perform downstream actions.
---

# Weather Forecast

Interpret supplied weather evidence, then let the deterministic finalizer bind the result to that evidence.

This skill is read-only. It does not fetch forecasts, send alerts, change schedules, or mutate provider state. Use `nws-weather-forecast`, `open-meteo-weather-forecast`, or another provider skill to obtain evidence first.

## Procedure

1. Identify the requested location, horizon, purpose, and freshness requirement.
2. Read only `forecast_evidence`. Do not add provider references, timestamps, or forecast periods that are absent from it.
3. Assess whether the evidence is fresh and complete enough for the stated purpose. Return `needs_more_evidence` when it is stale, ambiguous, unsupported, or too thin.
4. Summarize relevant periods, uncertainty, hazards, and planning implications without claiming a downstream action occurred.
5. Return `refused` for emergency, evacuation, aviation, maritime, medical, or other life-safety use.

The finalizer enforces the requested location and horizon, context-only authority, provider identity, provenance references, generation timestamp, and period-name fidelity. A draft that invents any of those fails instead of sealing a forecast packet.

## Output

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
  authority: context-only
  mutation: false
```

For `ready`, the supplied evidence must include `provider`, `generated_at`, `periods`, and at least one `source_ref` or `receipt_ref`. Missing `forecast_evidence` stops before agent interpretation. A missing optional horizon remains an empty string; the agent must not invent one.

## Agent task contracts

### `weather-forecast-interpret`

Interpret only the supplied forecast evidence and return forecast_draft using the documented
output fields. Preserve the requested location and horizon, provider, generated_at, source_refs,
receipt_refs, and relevant period names. Summaries, hazards, uncertainty, and stop conditions
require analyst judgment, but do not invent evidence. Return needs_more_evidence when freshness
or coverage is insufficient. Return refused for life-safety use.

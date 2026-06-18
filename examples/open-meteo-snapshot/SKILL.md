---
name: open-meteo-snapshot
description: Fetch a public weather and air-quality snapshot through Runx governed HTTP graph stages.
---

# Open-Meteo Snapshot

Fetch current weather and air-quality observations from Open-Meteo through
Runx's governed HTTP front. The skill uses public, keyless endpoints and keeps
each provider call inside an auditable graph step so the receipt records the
requested URL, status, and authority surface.

## What this skill does

`open-meteo-snapshot` accepts a latitude and longitude, then runs two read-only
HTTP graph stages:

- `current_weather` calls the Open-Meteo forecast endpoint for current
  temperature and wind speed.
- `air_quality` calls the Open-Meteo air-quality endpoint for current PM10 and
  PM2.5 observations.

The output is provider evidence for downstream planning, monitoring, or report
generation. It is not an emergency, health, or compliance decision system.

## When to use this skill

- You need a sealed example of multiple public HTTP provider calls in one graph.
- You need current weather and air-quality evidence for a latitude/longitude.
- You want a keyless API fixture that can run in CI without secrets.
- You need to prove the calls used Runx's governed HTTP path rather than an ad
  hoc fetch implementation.

## When not to use this skill

- For life-safety, aviation, maritime, medical, or evacuation decisions.
- For locations where Open-Meteo does not return current observations.
- To mutate external systems or notify users based on weather or air quality.
- To call private networks, authenticated APIs, or endpoints outside Open-Meteo.

## Procedure

1. Collect decimal `lat` and `lon` inputs from the caller.
2. Run the default `snapshot` runner.
3. Confirm both graph steps return a 2xx HTTP status in the sealed receipt.
4. Preserve the Open-Meteo source URLs, current observation timestamps, and
   receipt references.
5. Return `needs_input` for malformed coordinates.
6. Return `needs_more_evidence` for provider outages, non-2xx responses,
   timeout failures, rate limiting, or missing current observations.
7. Stop before recommending user action; pass the sealed evidence to a separate
   planning skill if an action is requested.

## Edge cases and stop conditions

- **Invalid coordinates:** return `needs_input`; the provider expects decimal
  latitude and longitude.
- **Provider timeout or rate limit:** return `needs_more_evidence` and preserve
  the failed HTTP status or timeout reason in the receipt.
- **Partial provider failure:** return `needs_more_evidence`; do not combine a
  successful weather call with missing air-quality evidence as if complete.
- **Unsupported geography:** return `needs_input` if Open-Meteo cannot resolve
  the requested coordinates.
- **Life-safety or health advice:** return `refused`; this skill only gathers
  public evidence and does not grant authority to make safety decisions.

## Output schema

```yaml
decision: ready | needs_input | needs_more_evidence | refused
runtime_path: http
provider: open-meteo
provider_evidence:
  current_weather:
    endpoint: string
    http_status: string
    current: object
  air_quality:
    endpoint: string
    http_status: string
    current: object
receipt_refs: array
stop_conditions: array
```

## Worked example

Run the harness case for Washington, DC:

```sh
runx harness examples/open-meteo-snapshot --json
```

The graph calls the forecast and air-quality endpoints for
`38.8894,-77.0352`. A successful run seals both HTTP observations into the run
receipt.

## Inputs

- `lat` (required): decimal latitude, for example `38.8894`.
- `lon` (required): decimal longitude, for example `-77.0352`.

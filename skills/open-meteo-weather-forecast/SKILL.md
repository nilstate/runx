---
name: open-meteo-weather-forecast
description: Resolve a place and fetch a global forecast through governed, keyless Open-Meteo HTTP calls.
runx:
  category: weather
---

# Open-Meteo Weather Forecast

Fetch global place and forecast evidence through runx's governed HTTP front.
The skill never performs an ad-hoc fetch. Each stage is a bounded, read-only
HTTP runner whose endpoint, inputs, status, authority scope, and output packet
are recorded in the sealed receipt. Open-Meteo requires no API key.

## Procedure

1. Run `locate` with a city or place name.
2. Select the intended result and preserve its latitude, longitude, timezone,
   and country as a typed provider-evidence packet.
3. Run the default `forecast` runner with the selected coordinates.
4. Require a 2xx response and preserve the provider URL, timezone, generation
   time, current conditions, daily forecast, and receipt references.
5. Treat the result as context only. Any notification, scheduling change, or
   operational mutation requires a separate skill and authority gate.

## Inputs

- `name` (`locate`, required): city or place to resolve.
- `count` (`locate`, optional): maximum candidate results, default `5`.
- `latitude` (`forecast`, required): decimal latitude.
- `longitude` (`forecast`, required): decimal longitude.
- `forecast_days` (`forecast`, optional): days requested, default `3`.

## Output packets

The two graph steps produce typed sealed packets:

- `locate` produces Open-Meteo geocoding provider evidence.
- `forecast` produces Open-Meteo forecast provider evidence.

Preserve provider metadata and receipt references when passing either packet to
another skill. Do not convert provider evidence into high-stakes advice.

## Failure, retry, and stop conditions

- **Ambiguous or missing place:** return `needs_input`; do not silently choose a
  similarly named location.
- **Invalid coordinates or forecast-days value:** return `needs_input`.
- **Non-2xx response, timeout, or rate limit:** return `needs_more_evidence`,
  preserve the failure in the receipt, and retry only under the caller's retry
  policy.
- **Stale or incomplete provider response:** return `needs_more_evidence`.
- **Life-safety, medical, aviation, maritime, or emergency use:** refuse and
  direct the caller to official channels.
- **Mutation requested from forecast evidence:** stop after the sealed read and
  require a separate authority-scoped action skill.

## Worked example

1. Run `locate` with `name: Shanghai`.
2. Select the result for Shanghai, China.
3. Run `forecast` using the sealed latitude and longitude with
   `forecast_days: "3"`.
4. Preserve both sealed receipts with the returned forecast evidence.

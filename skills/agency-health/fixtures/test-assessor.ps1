# Deterministic local checks for the internal assessor. These mirror the two
# inline harness cases and remain runnable without a bound data-store adapter.
$ErrorActionPreference = 'Stop'
function Invoke-Assessor([string]$json) {
  $old = $env:RUNX_INPUTS_JSON
  try { $env:RUNX_INPUTS_JSON = $json; return (node skills/agency-health/graph/assess/run.mjs | ConvertFrom-Json) }
  finally { $env:RUNX_INPUTS_JSON = $old }
}
$concerning = Invoke-Assessor '{"health_baseline":{"threshold_days_stuck":3,"cap_pressure_pct":80,"refusal_spike_rate":0.25},"fixture_projection":{"events":[{"event":{"type":"opened","payload":{"limits":{"max_turns":10}}}},{"event":{"type":"turn","payload":{"turn":9,"age_days":6}}},{"event":{"type":"refusal","payload":{"reason":"cap exceeded"}}}]}}'
if ($concerning.decision -ne 'ready' -or $concerning.health_verdict.status -ne 'degraded' -or $concerning.intervention_findings.Count -lt 2) { throw 'concerning case failed' }
$empty = Invoke-Assessor '{}'
if ($empty.decision -ne 'needs_more_evidence' -or $empty.health_verdict.status -ne 'unknown' -or $empty.health_verdict.findings.Count -ne 0 -or $empty.intervention_findings.Count -ne 0) { throw 'empty case failed' }
Write-Output 'agency-health assessor fixtures passed'
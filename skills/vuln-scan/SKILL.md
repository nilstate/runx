---
name: vuln-scan
description: Analyze dependency or ecosystem risk and produce remediation and advisory packets.
---

# Vulnerability Scan

Review one dependency surface or project scope and produce a bounded security
packet. This skill is for operator-facing risk analysis, remediation planning,
and advisory drafting. It is not a license to run arbitrary destructive scans.

Keep the output practical: what is affected, how serious it is, what to do
next, and whether a public advisory is justified.

## Output

Scan runner:

- `dependency_inventory`: affected components and versions.
- `advisories`: findings with severity, exposure, and evidence.
- `remediation_plan`: concrete next actions.
- `operator_summary`: concise decision-ready summary.

Advisory runner:

- `advisory_draft`: public or maintainer-facing advisory text.
- `maintainer_summary`: concise summary for repo owners.
- `disclosure_checklist`: what to verify before public release.

## Inputs

- `target` (required): repo, lockfile, package set, or ecosystem slice.
- `objective` (optional): what the operator wants from this scan.
- `scan_context` (optional): known packages, incidents, or prior findings.
- `advisories` (optional): structured findings from the scan runner.
- `remediation_plan` (optional): structured remediation plan for the advisory pass.

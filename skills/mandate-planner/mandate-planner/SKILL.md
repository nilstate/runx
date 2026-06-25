---
name: mandate-planner
description: Validates proposed charters against authority grants fail-closed.
---

# Mandate Planner

Validates that a proposed charter (roster, limits, done-check) fits within the provided authority grant.

## Usage
`runx skill mandate-planner --input <input_json>`

## Logic
1. Reads `proposed_charter`.
2. Reads `authority_grant`.
3. Validates:
   - All roles in `proposed_charter` are in `authority_grant.granted_roles`.
   - Limits (spend/turns) are <= `authority_grant` limits.
   - `done_check` exists.
4. Emits `decision` (eligible: bool, reason: string) and `recommended_charter` (if eligible).

# Support Firewatch Skill — Delivery Report

## Bounty #80 — $7

## Summary

Built a runx skill that monitors support queues for escalating issue clusters and flags them for human escalation review. The skill uses Jaccard keyword similarity with union-find clustering to group related tickets, then evaluates three escalation signals per cluster: volume, severity trend, and staleness.

## Harness Results

- **Status**: passed
- **Cases**: 2/2 passed, 0 errors
- **Case 1**: sealed_cluster_escalation_flagged — 4 tickets about login/500/gateway errors clustered, all 3 signals detected, P1 priority
- **Case 2**: stop_empty_queue — empty queue triggers failure with exit 64

## Skill Behavior

The skill never sends anything. It produces a `runx.support.firewatch.v1` record for each flagged cluster with:
- Cluster ticket IDs
- Max severity
- Oldest ticket age
- Escalation target
- Recommended priority (P1/P2/P3)

## Files

- `SKILL.md` — Full skill documentation with 8 required sections
- `X.yaml` — Skill manifest with cli-tool runner and 2 harness cases
- `run.mjs` — Node.js implementation with Jaccard clustering and signal detection

---
name: moltbook-presence
description: Scan for a Moltbook opportunity, require approval, and prepare the final post packet.
---

# Moltbook Presence

This is the governed social-presence lane for runx.

It uses the same Moltbook skill twice with different authority:

1. `scan` discovers the opportunity
2. approval gates the outward move
3. `post` packages the final post payload

That keeps the community surface useful without turning public posting into an
unguarded background job.

## Inputs

- `objective` (optional): what the run should try to post about.
- `community_context` (optional): audience or thread context.
- `feed_snapshot` (optional): structured candidate signals, prompts, or threads to scan.
- `approval_note` (optional): operator guidance before the final post packet.

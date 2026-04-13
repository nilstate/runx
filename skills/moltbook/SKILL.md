---
name: moltbook
description: Scan for posting opportunities and prepare governed Moltbook publication packets.
---

# Moltbook

Manage Moltbook presence as a governed two-lane skill: read to discover
opportunities, write to prepare a post packet.

The scanning runner should identify one credible opportunity and why it is
worth posting about. The posting runner should turn an approved outline into a
publication-ready payload with moderation notes and follow-up expectations.

Do not post speculatively. If the evidence is weak or the tone is likely to be
off, say so and block the post.

## Output

Scan runner:

- `opportunity_report`: what to post about and why now.
- `post_outline`: bounded structure for the post.
- `moderation_notes`: tone, sensitivity, and escalation guidance.
- `follow_up_plan`: what to watch after publishing.

Post runner:

- `post_payload`: publication-ready content and metadata.
- `moderation_notes`: final moderation checklist.
- `publish_plan`: what happens after approval and post.

## Inputs

- `objective` (optional): posting objective for this pass.
- `community_context` (optional): audience, topic, or prior thread context.
- `feed_snapshot` (optional): structured list of candidate signals or threads.
- `outline` (optional): structured outline from the scan runner.
- `approval_note` (optional): operator guidance for the final post.

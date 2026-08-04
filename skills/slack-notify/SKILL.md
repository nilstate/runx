---
name: slack-notify
description: Plan a digest-bound Slack notification, then deliver the exact approved channel post through a configured Runx Connect grant with provider readback.
runx:
  category: ops
---

# Slack Notify

Send one deliberate Slack channel notification without exposing a Slack token
to the skill or letting approved content drift before delivery. The skill
separates safe message planning from the consequential provider mutation and
requires Slack readback before it calls the notification delivered.

Use this for bounded notifications to a known workspace and channel. It is not
a team inbox, a Slack history reader, or a customer-support workflow. Higher-
level operator skills may prepare the message and destination, but this skill
owns the final channel-post boundary.

## Composes

<!-- Generated from the native execution closure; run pnpm core-skills:composes:generate. -->

- `send-as#plan`

## Runners

`plan` validates a channel name, channel id, or exact
`slack://workspace/channel` destination, computes an inline message digest with
Runx's native `data.digest`, and binds that digest, the named principal, and the
send intent through the canonical `send-as` planning model. It does not post
and needs no approval. Delivery still requires the exact connector locator.

`deliver` accepts only that exact plan, the matching destination and message
text, and a stable UUID idempotency key. Runx recomputes the digest and compares
the complete delivery binding without echoing message content. It then:

1. stops at explicit human approval;
2. resolves the configured Runx Connect grants for `channel.post` and the
   follow-up `channel.post.read`;
3. asks Cloud to execute that bounded mutation while Cloud retains credential
   custody; and
4. reads the returned message locator back from Slack, compares the exact
   locator, destination, content digest, and occurrence time, then seals only
   those bounded evidence fields.

The skill never receives a Slack token, constructs a raw HTTP request, or
stores connector credentials in its inputs or receipts.

## Inputs and result

Planning needs the principal, exact Slack locator, message text, purpose, and
any audience constraints required by `send-as`. Delivery needs the resulting
`notify_plan`, identical locator and text, and stable idempotency key.

A plan ends as not sent. A delivery is valid only when the sealed
`runx.provider.operation.v1` packet identifies the Slack operation and carries
the provider-returned message locator, conversation locator, content digest,
and occurrence time for the posted message. The follow-up channel-post readback must
resolve that exact locator. Provider acceptance without those expected fields,
the exact destination and content identity, and the stable-id readback is not
enough.

## Stop conditions

- Stop on plan, destination, content-digest, principal, or audience drift.
- Stop when approval is absent or denied.
- Refuse a missing, ambiguous, wrong-provider, or insufficient-scope Connect
  grant for either operation rather than falling back to a raw token.
- Replays may reuse the same idempotency binding only for the exact same post;
  changed content must not inherit the old approval.
- Do not call a sealed plan “delivered” and do not manufacture provider
  readback in a fixture or agent answer.

## Example

An operator plans “release 2.4 is verified” for one internal channel. Approval
binds that exact text and destination. If the text changes to include another
claim, delivery refuses the digest mismatch. With a matching plan and one valid
Connect grant, the provider operation posts and returns the Slack message id;
the follow-up channel-post readback resolves that id, and those provider observations—not
the local plan—prove delivery.

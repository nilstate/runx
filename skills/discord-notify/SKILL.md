---
name: discord-notify
description: Planner for Discord notifications using the Nango connector.
---

# Discord Notify

This skill is an `agent-task` planner for the Discord Nango connector.
The skill emits the planned actions a connector lane would run.

1. **Check Inputs:** Verify `provider_context`, `channel`, and `content`. If `provider_context` is missing, return `needs_agent`.
2. **Emit Plan:** Construct a `notify_plan` that specifies the target `channel` and the `provider_actions` necessary to post the message using the Discord Nango connector.
3. **Stop:** End the task and output the plan.

## Emitted Plan Format

```yaml
notify_plan:
  decision: ready
  principal: "{{principal}}"
  channel:
    ref: "{{channel}}"
  content: "{{content}}"
  provider_actions:
    - action: post_message
      via: "{{provider_context.connector}}"
```

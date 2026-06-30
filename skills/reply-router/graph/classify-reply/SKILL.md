---
name: reply-router-classify
description: Deterministically classify a bounded inbound reply and prepare a side-effect-free suppression or routing plan for reply-router.
links:
  source: https://github.com/runxhq/runx/tree/main/skills/reply-router/graph/classify-reply
---

# Reply Router Classifier

Private graph stage for `reply-router`. It validates receipt trust and recipient
correspondence, classifies the reply, and emits only data required by the chosen
branch. It performs no writes and no network actions.

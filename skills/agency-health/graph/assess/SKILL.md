---
name: agency-health-assess
description: Internal deterministic assessment stage for the agency-health graph.
---

# Agency Health Assess

Reduce a bounded agency projection into evidence-backed health findings. This stage
never reads storage itself; its parent graph supplies the `read_projection` result.
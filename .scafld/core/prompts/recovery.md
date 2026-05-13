# RECOVERY HANDOFF TEMPLATE

This file is a renderer template. scafld compiles it into a bounded recovery
handoff by adding the failed criterion, canonical gate state, supporting
diagnostics reference, prior attempts, current phase slice, and relevant prior
phase summary.

You are repairing a specific failed acceptance criterion, not reopening the
entire task.

Rules:
- Work only against the failed criterion and the current phase slice.
- Treat `status --json` and `handoff` as the trusted failure state.
- Use diagnostics only as supporting evidence for the reported blocker.
- Respect the declared recovery attempt budget.
- Do not broaden scope unless the generated context proves the spec is wrong.
- Prefer the smallest fix that can make the criterion pass.
- When the fix is ready, rerun the declared validation rather than guessing.

# Meeting Prep Harness Evidence

This directory contains the checkable local harness evidence for the
`meeting-prep` runx skill.

- `runx-version.txt`: exact CLI version used for the final local harness run.
- `inline-harness-docker-output.json`: final Docker `node:24-bookworm` harness
  output from `npx -y @runxhq/cli@0.6.6 harness ./skills/meeting-prep`.
- `inline-harness-docker-receipts-list.txt`: receipt file sizes from the final
  Docker run.
- `docker-receipts-sanitized/`: receipt JSON snapshots copied to
  Windows-safe filenames. The receipt ids inside each JSON object remain the
  original `sha256:<digest>` ids emitted by runx.

The final local run passed both harness cases with zero assertion errors:

- `meeting-prep-product-review-ready`
- `meeting-prep-insufficient-context-stop`

---
name: ledger
description: "Pinned read-only C7 receipt-ledger runner for the isolated agency-health registry package."
runx:
  category: internal
---

# Pinned ledger read surface

This package-local dependency preserves the `read` runner and runtime from
`runx/ledger@sha-3e6341beba7f` at source commit
`46e85c59bfdc1fc91c380d2d4b0852c1edfc8b77`. Its official lock digest is
`f91e656d6fcef27dec6e12725c8015be47762514278f37342ff40761838e9f6c`.

The runner shells the shipped `runx history`/`runx verify` engine for ambient
history or accepts controlled receipt rows for deterministic evaluation, then
projects them to id-stubs. It never returns a receipt body and has no write or
effect surface.

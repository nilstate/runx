---
name: data-store
description: "Pinned read-only C2 surface for domain-keyed event and projection reads inside the isolated agency-health registry package."
runx:
  category: internal
---

# Pinned data-store read surface

This package-local dependency preserves only the `read_events` and
`read_projection` runners from `runx/data-store@sha-ca3a75ec5f21` at source
commit `46e85c59bfdc1fc91c380d2d4b0852c1edfc8b77`. Its official lock digest is
`fbf0c7356f063f4fa12c9ff3bd944587f9202fb1520238a6652c90c907cb062f`.

Both runners call the runtime's governed `data.source` virtual router with
`runx:data:read`. No append runner, write scope, fixture row, or private binding
is included. This compatibility snapshot exists because a published skill is
reconstructed in isolation and cannot reach sibling packages from the source
monorepo.

The package also carries the upstream `data.sqlite@0.1.0` tool implementation
so an installed registry package can read a durable local case. The public
`agency-health` graph exposes only the two read runners above and never invokes
the adapter's append operation.

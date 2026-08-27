# runx-core

Pure Rust parity kernel for runx state-machine and policy decisions.

This crate implements the Rust-owned state-machine and policy decision surface
against the checked-in kernel fixture set. The policy surface includes local
admission, grant attenuation, retry, graph-scope, authority
proof, credential binding, scope admission, and public work helpers.

Scope names remain open, provider-neutral strings. `ScopeGrantPolicy` is the
single matching registry: exact-only for provider-native permissions,
delegated for one-segment `namespace:*` grants, and trusted for first-party
authority that may also carry the reserved universal `*` grant. Rust owns the
semantics; the published contracts package exposes the conformance-tested
TypeScript projection used by hosted surfaces.

`runx-core` must stay free of filesystem, network, subprocess, MCP, adapter,
and CLI presentation behavior.

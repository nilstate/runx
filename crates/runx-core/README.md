# runx-core

Pure Rust parity kernel for runx state-machine and policy decisions.

This crate implements the Rust-owned state-machine and policy decision surface
against the checked-in kernel fixture set. The policy surface includes local
admission, grant attenuation, retry, graph-scope, authority
proof, credential binding, scope admission, and public work helpers.

`runx-core` must stay free of filesystem, network, subprocess, MCP, adapter,
and CLI presentation behavior.

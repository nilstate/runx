# runx-cli

`runx-cli` contains the native `runx` command.

```bash
npm install --global @runxhq/cli
```

The current CLI is distributed through npm and the signed GitHub release
archives. The historical crates.io package is not the current release channel:
publishing this crate requires a coordinated release of its internal Rust
dependencies, and CLI releases intentionally do not publish those libraries.

## Runtime Requirements

- No Rust toolchain is required for the published CLI packages.
- No Node.js runtime is required for the native CLI.

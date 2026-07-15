# Releasing the runx CLI

Maintainer doc. Most contributors do not need it.

## Identity

The CLI ships from `github.com/runxhq/runx`. Release tags are `cli-vX.Y.Z`
(prefixed so they do not collide with the repo's other release trains). In the
workspace, `release/status.json` is the operator source of truth for package
release status, the CLI package allowlist, and the cloud pin. The git tag is the
immutable OSS release event that the public workflow builds.

Release policy lives at the workspace root (`AGENTS.md` plus
`release/status.json`). This doc is the OSS maintainer runbook. If a release doc,
package manifest, cloud pin, or channel table disagrees with `release/status.json`,
fix the drift there and run the root checks; do not invent a second release flow.

The same product version is used on every active channel. The release workflow
is secret-gated, so package-manager channels that are not configured are skipped
with a warning instead of blocking the npm/GitHub release.

- GitHub Release: `cli-vX.Y.Z` (the hub; serves the raw per-target archives)
- npm: `@runxhq/cli@X.Y.Z` (+ `@runxhq/cli-<platform>@X.Y.Z`)
- Homebrew, Scoop, winget, AUR, Docker (GHCR): `X.Y.Z` when their channel
  credentials are configured
- crates.io: `runx-cli X.Y.Z` (`cargo install runx-cli`) when the crate channel
  is configured

`runx --version` reports `CARGO_PKG_VERSION`, so the crate and npm versions are
stamped from the tag at build time and the number is truthful regardless of how
the binary was installed.

## Versioning model

The source tree keeps its development version; release jobs **stamp** the tag
version, they never commit it. `cli-vX.Y.Z` is the CLI distribution version, not
a workspace-wide library-crate release. One command stamps only the CLI package
surfaces: npm `package.json` + its `optionalDependencies`, `runx-cli`, and the
`runx-cli` lockfile entry.

```bash
pnpm exec tsx scripts/set-release-version.ts X.Y.Z          # write
pnpm exec tsx scripts/set-release-version.ts --check X.Y.Z  # CI drift guard
```

It accepts a raw `cli-vX.Y.Z` / `vX.Y.Z` tag and strips the prefix.

Cargo publishing is CLI-only. The release job publishes `runx-cli` and does not
stamp or publish internal Rust crates (`runx-core`, `runx-runtime`,
`runx-parser`, `runx-contracts`, `runx-pay`, `runx-receipts`, `runx-sdk`, or
`runx-contracts-derive`) unless the operator explicitly requests a separate
library-crate release. Never cut a new patch just to repair a package-manager
manifest; repair the existing release asset, channel manifest, or workflow in
place.

## Pipeline

`.github/workflows/release.yml` fires on `cli-v*` tags. `workflow_dispatch`
(with a `version` input) runs a build + render dry-run with no publishing.

Stages (the order is intentional — the GitHub Release must exist before any
channel that downloads its archives):

1. **prepare** — resolve the version, stamp + `--check` manifests, `verify:fast`.
2. **build** (5-platform matrix) — pinned toolchain (`rust-toolchain.toml`), stamp,
   `cargo build --release`, then per platform: npm artifacts (`package-rust-cli.ts`),
   the raw archive (`build-release-archives.ts`), and the `.deb` (linux). Uploads
   npm + archive artifacts.
3. **smoke** (5-platform matrix) — downloads each built archive and runs
   `runx --version` on the real OS. Gates the release: a broken or wrong-arch
   binary fails here before anything is published. Runs in dry-runs too.
4. **github-release** — assemble `checksums.txt`, generate a CycloneDX SBOM, emit
   build-provenance attestations for the binaries, stage the install scripts, and
   publish the Release with all archives. This is the hub.
5. **publish-npm** — verify + publish the selector and native packages with npm
   provenance (`skip-existing`).
6. **publish-crates** — publish `runx-cli` only.
7. **package-managers** — build the channel input from the published checksums
   (`build-channel-input.mjs`), render Homebrew / Scoop / winget / AUR manifests
   (`gen-channel-manifests.ts`), verify them against the actual release archive
   contents (`check-channel-manifests.mjs`), and attach them to the Release.
8. **publish-{homebrew,scoop,winget,aur}** — push to the owned registries when
   their credentials are configured; otherwise skipped with a warning. winget
   submits the validated `channels/winget/` manifest set directly; it must not
   use a generator that guesses archive nesting.
9. **publish-docker** — multi-arch GHCR image (pulls the musl archive from the
   Release; no Rust toolchain in the image build).

GitHub Actions is deliberately disabled on the `winget-pkgs` fork. The fork only
hosts the PR head branch; the checks that gate a winget submission run on
`microsoft/winget-pkgs`. Upstream's workflows are written for that repo's
`pull_request_target` context, where spell check reads only the files a PR
touches. A push to a fork branch has no PR context, so the same workflow scans
the whole repository and fails on upstream's own vocabulary (`HKLM`, `UAC`,
`dsc`) no matter what the manifest contains. Leave Actions off; a red run there
is not a signal about the release.

## Installing (end users)

These work the moment a `cli-v*` tag ships, with no package-manager setup:

```sh
# macOS / Linux
curl -fsSL runx.ai/install | sh
```
```powershell
# Windows
irm runx.ai/install.ps1 | iex
```

`runx.ai/install` and `runx.ai/install.ps1` are clean public paths that **proxy**
to the scripts in this repo ([scripts/install](../scripts/install) and
[scripts/install.ps1](../scripts/install.ps1) on `main`); the script bodies are
not duplicated on the site. Both detect OS/arch, download the matching archive
from the GitHub Release, verify its sha256, and install to a user bin dir.
Overrides: `RUNX_VERSION`, `RUNX_INSTALL_DIR`, `RUNX_BASE_URL` (private mirror).

> Site proxy: point `runx.ai/install` → the raw `scripts/install` and
> `runx.ai/install.ps1` → raw `scripts/install.ps1` (302 or pass-through). Keep
> the path extensionless for the shell installer.

## Required secrets

Publishing degrades gracefully: each registry job is gated on its secret and
skipped (with a `::warning::`) when unset, so a release can go out npm-only and
gain channels as credentials land.

| Secret | Channel | Required for |
| --- | --- | --- |
| `NPM_TOKEN` | npm | selector + native packages |
| `CARGO_REGISTRY_TOKEN` | crates.io | `cargo install runx-cli` |
| `HOMEBREW_TAP_TOKEN` | Homebrew | push to `runxhq/homebrew-tap` |
| `SCOOP_BUCKET_TOKEN` | Scoop | push to `runxhq/scoop-bucket` |
| `WINGET_TOKEN` | winget | PR to `microsoft/winget-pkgs` |
| `AUR_SSH_PRIVATE_KEY` | AUR | push `runx-bin` |
| `GITHUB_TOKEN` | GitHub Release, GHCR | provided automatically |

External repos to create before enabling those channels: `runxhq/homebrew-tap`,
`runxhq/scoop-bucket`, and the `runxhq.runx` winget package / `runx-bin` AUR
package.

## Cutting a release

```bash
# 1. from the workspace root, prepare cloud/status together:
pnpm release:prepare -- --version X.Y.Z
pnpm release:check
pnpm release:check:live # required before claiming public package channels are live

# 2. dry-run from the Actions tab (workflow_dispatch, version = X.Y.Z)
# 3. tag and push:
git tag cli-vX.Y.Z
git push origin cli-vX.Y.Z
```

Never move a published semver tag. Never bump a new patch just to repair channel
drift; fix the existing channel artifact or workflow unless the binary itself is
wrong.

## Layout

```
crates/rust-toolchain.toml    # pinned Rust version for reproducible builds
scripts/
  set-release-version.ts      # stamp / --check the version across manifests
  build-release-archives.ts   # raw tar.gz/zip + .sha256 per target (release hub)
  build-channel-input.mjs     # checksums -> channel manifest input
  gen-channel-manifests.ts    # render Homebrew / Scoop / winget / AUR
  check-channel-manifests.mjs # verify channel manifests against real archives
  publish-winget-manifest.mjs # submit the validated winget manifest set
  make-signature-manifest.ts  # npm native-package signature manifest
  package-rust-cli.ts         # npm selector + native package staging
  check-rust-cli-release-artifacts.ts  # npm release contract validator
  install / install.ps1       # end-user one-liner installers (proxied via runx.ai/install)
packaging/
  docker/Dockerfile           # GHCR image (fetches the musl archive)
```

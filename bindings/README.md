# Upstream Bindings

Bindings connect a verified upstream `SKILL.md` to a runx execution profile.

The upstream repository remains the source of truth for the portable skill
document. This directory stores runx-owned binding data:

- `binding.json`: upstream repo/path/commit provenance, trust tier,
  registry owner, publication state, and proof pointers.
- `X.yaml`: the execution profile artifact containing runner metadata,
  harness cases, policy, scopes, and receipt expectations.

Publishing materializes a pinned registry package into `dist/` from the
upstream `SKILL.md` plus the local binding artifact. The generated package is
an immutable registry artifact, not the source document.

Example:

```bash
node scripts/materialize-upstream-skill-binding.mjs \
  bindings/nilstate/icey-server-operator/binding.json \
  --output-dir dist/upstream-bindings/nilstate/icey-server-operator
```

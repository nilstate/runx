# Publishing a skill to the runx registry

A runx skill is portable on its own, but to make it discoverable and installable
by others it has to be **published to a registry**. There are two registries, and
they behave differently.

## The two registries

- **Local workspace registry.** Lives under your workspace (`.runx`). No
  credentials. Use it to test the publish path and to resolve a skill locally
  before sharing it.
- **The hosted runx registry** (`runx.ai/x`). The shared, public, signed catalog.
  Publishing here is an authenticated write under *your* publisher identity, so it
  requires a publish credential.

## Before you publish

The skill must be real and runnable:

- A valid `SKILL.md` (frontmatter `name`, `description`, `runx.category`) and an
  `X.yaml` execution profile. Format: https://runx.ai/SKILL.md
- It passes the harness:
  ```bash
  runx harness ./skills/<your-skill> --json
  ```

## Publish locally first

```bash
runx registry publish ./skills/<your-skill>/SKILL.md
```

This writes the skill into your local workspace registry. It takes no credentials
and is the fast way to confirm the package resolves and installs before you push
it to the shared catalog. (The native OSS CLI publishes to the *local* registry
only; remote publish goes through the credentialed path below.)

## Publish to the hosted registry

Publishing to `runx.ai/x` is a governed run: you bring a publish credential per
invocation, nothing is persisted, and the scope narrows to that single publish.

```bash
export RUNX_PUBLISH_SECRET=...        # the secret value lives in the env var
runx skill ./skills/<your-skill> \
  --credential publish:<auth_mode>:<material_ref> \
  --secret-env RUNX_PUBLISH_SECRET
```

- `--credential publish:<auth_mode>:<material_ref>` declares the publish
  credential: the auth mode and the reference to your credential material. Get the
  exact value for your publisher from the publish surface at https://runx.ai/x/publish
- `--secret-env <ENV_VAR>` passes the secret by **environment variable name**. The
  value is read from the environment, never placed on the command line. The CLI
  requires `--credential` and `--secret-env` together.

The hosted, no-friction alternative is **managed OAuth connect** from
https://runx.ai/x/publish, which establishes the publish credential for you.

### Why a credential and a secret env var?

Publishing writes a signed package into a shared public catalog under your
publisher identity. That is an authenticated write to an external authority, so
runx treats it like every other governed action, with no special-casing:

- The **credential** proves you are allowed to publish under that identity. Without
  it, anyone could publish under any publisher name (squatting, impersonation).
- The **secret is passed by env-var name, never inline**, so it never lands in your
  shell history, the process argument list, or the receipt.
- It is **scoped per run and not persisted**, so a publish credential cannot be
  reused for anything else later.

The publish, like any governed action, seals into a receipt you can verify.

## After you publish

- Your skill appears as a live registry row on your publisher profile at
  `runx.ai/x/<publisher>`.
- New publishes start at **community** trust tier. Promotion to **verified**
  requires a verified identity, a set domain, passing harnesses, and signing
  (shown on the publisher trust panel).
- Confirm it resolves:
  ```bash
  runx registry search <your-skill>
  runx registry read <publisher>/<skill>@<version> --json
  runx add <publisher>/<skill>            # the friendly install path
  ```

## Links

- Skill format: https://runx.ai/SKILL.md
- Catalog: https://runx.ai/x
- Publish surface: https://runx.ai/x/publish
- Quickstart: https://runx.ai/docs/quickstart

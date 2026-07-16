# Sourcey catalog extractor

This directory creates a 24-page documentation catalog from Runx skill sources
at one immutable Git commit. The local checkout is never used as source content.

## Inputs

`catalog.json` identifies the canonical GitHub repository, the pinned commit,
and five ordered groups. Every entry declares its skill name, output slug,
group, and source path. The extractor accepts only the Runx repository, a
40-character lowercase commit SHA, the exact canonical 24 names and five
groups, slugs equal to names, and paths of the form `skills/<name>/SKILL.md`.

## Run

```sh
node --test docs/sourcey-catalog/extract.test.mjs
node docs/sourcey-catalog/extract.mjs
```

The extractor reads each file through GitHub's Contents API at the catalog's
commit. Optional authentication comes only from `GITHUB_TOKEN`, falling back to
`GH_TOKEN`, and is sent only in the Authorization header. Tokens are redacted
from errors and output. The extractor retries transient failures up to three
total attempts, caps fetch concurrency at four, and waits at most 30 seconds
for a rate-limit reset before returning the reset time and token guidance.
Secondary rate limits are recognized from GitHub's response message or
`Retry-After` header and return the same bounded-wait and token guidance.

Each response must contain canonical base64 for a file no larger than 1 MiB.
The extractor verifies the returned Git blob SHA before rendering the page.

Generated pages are written in catalog order to `pages/*.md`. Each one contains
the group, immutable source URL, commit, source path, authored Markdown with
only recognized leading YAML frontmatter removed. Frontmatter is validated with
the project's `yaml` parser before removal; malformed YAML is rejected. The
extractor normalizes output to UTF-8 LF endings and rejects a symlink
`outputDir`. Within a real output directory, it atomically replaces expected
page paths and safely unlinks stale Markdown files or symlinks without following
symlink targets.

`extractCatalog` returns a `sha256:` digest of each final page in its page
metadata. The digest is not embedded in the generated Markdown body.

---
name: sourcey
description: Generate documentation for a project using Sourcey.
---

# Sourcey

Generate a documentation site for a project using Sourcey. Sourcey is a static
documentation generator that produces HTML sites from markdown pages, OpenAPI
specs, Doxygen XML, and MCP server snapshots.

By default, runx executes Sourcey as a governed mixed-runner skill:

1. discover the bounded documentation scope, evidence, and plan
2. request approval
3. author the bounded docs/config bundle
4. write the source bundle deterministically
5. build docs deterministically
6. critique the built output in one bounded pass
7. apply at most one bounded revision pass
8. rebuild and verify the output deterministically

For already-configured projects, the same `sourcey` runner stays narrow: the
discover step can confirm existing config, the author/revise passes can return
empty bundles, and the deterministic tool steps still perform the build and
verification work.

## Canonical semantics

Complex runx skills share a reusable phase language:

- `scope`
- `ingest`
- `model`
- `materialize`
- `evaluate`
- `revise`
- `verify`
- `ratify`

The current Sourcey runner deliberately uses a bounded subset:

- `discover` folds `scope + ingest + model`
- `approve` is `ratify`
- `author + write-docs + build` form `materialize`
- `critique` is `evaluate`
- `revise + write-revisions + rebuild` form `revise`
- `verify` is `verify`

The current slice uses exactly one bounded revision window. It never loops
until good and it never critiques indefinitely.

## Steps

1. Inspect the project and discover a bounded documentation plan from real project evidence.
2. Approve the discovered plan before authoring.
3. Author the bounded Sourcey source bundle.
4. Persist that bundle deterministically.
5. Run `sourcey build` deterministically with the discovered or authored config.
6. Critique the built output in one bounded evaluation pass.
7. Apply at most one bounded revision pass from that critique.
8. Rebuild deterministically after the revision bundle is written.
9. Verify the output directory contains `index.html`.
10. Inspect the receipt and generated site.

## Discovery contract

`discovery_report` may include additional planning metadata, but the canonical
resolved docs inputs must live under:

- `discovery_report.discovered.brand_name`
- `discovery_report.discovered.homepage_url`
- `discovery_report.discovered.docs_inputs`

Downstream deterministic build steps consume that nested `discovered` object.

## Output

Sourcey build produces: HTML pages, `sourcey.css`, `sourcey.js`,
`search-index.json`, `sitemap.xml`, `llms.txt`, `llms-full.txt`, and
`_og/` directory with generated Open Graph images.

## Inputs

- `project` (required): project root directory.
- `brand_name`: project name (discovered from package evidence if omitted).
- `homepage_url`: project homepage (discovered from project evidence if omitted).
- `docs_inputs`: structured docs inputs, e.g. `{"mode":"config","config":"docs/sourcey.config.ts"}` or `{"mode":"openapi","spec":"openapi.yaml"}`. Discovered if omitted and may point at authored config produced by the skill.
- `output_dir`: output path (default: `<project>/.sourcey/runx-docs`).
- `sourcey_bin`: explicit sourcey executable path (default: `SOURCEY_BIN` env or `sourcey` on PATH).

## Config reference

```typescript
import { defineConfig } from "sourcey";

export default defineConfig({
  name: "Project Name",
  theme: {
    preset: "default",             // "default" | "minimal" | "api-first"
    colors: {
      primary: "#hex",             // required
      light: "#hex",               // optional, derived from primary
      dark: "#hex",                // optional, derived from primary
    },
    fonts: {
      sans: "Inter",               // optional
      mono: "monospace",           // optional
    },
    layout: {
      sidebar: "18rem",            // optional
      toc: "19rem",                // optional
      content: "44rem",            // optional
    },
    css: ["path/to/custom.css"],   // optional
  },
  logo: "path/to/logo.png",       // or { light, dark, href }
  favicon: "path/to/favicon.ico",
  repo: "https://github.com/org/repo",
  editBranch: "main",
  editBasePath: "docs",            // path from repo root to docs source
  codeSamples: ["curl", "javascript", "python"],  // for OpenAPI tabs
  navigation: {
    tabs: [
      // Markdown pages tab
      {
        tab: "Documentation",
        slug: "",                  // empty = default tab
        groups: [
          { group: "Getting Started", pages: ["introduction", "quickstart"] },
          { group: "Guides", pages: ["configuration", "deployment"] },
        ],
      },
      // OpenAPI tab
      {
        tab: "API Reference",
        openapi: "path/to/openapi.yaml",
      },
      // Doxygen tab
      {
        tab: "C++ API",
        doxygen: {
          xml: "path/to/doxygen/xml",
          language: "cpp",         // "cpp" | "java"
          groups: true,            // use doxygen groups for nav
          index: "auto",           // "auto"|"rich"|"structured"|"flat"|"none"
        },
      },
      // MCP tab
      {
        tab: "Tools",
        mcp: "path/to/mcp.json",
      },
    ],
  },
  navbar: {
    links: [
      { type: "github", href: "https://github.com/org/repo" },
      // types: github, twitter, discord, linkedin, youtube, slack,
      //        mastodon, bluesky, reddit, npm, link
    ],
    primary: { type: "button", label: "Demo", href: "/demo" },
  },
  footer: {
    links: [{ type: "github", href: "https://github.com/org/repo" }],
  },
  search: {
    featured: ["introduction", "quickstart"],  // top results when empty query
  },
});
```

## Page format

Pages are markdown files resolved relative to the config file directory.
If config is at `docs/sourcey.config.ts`, then page `"quickstart"` resolves
to `docs/quickstart.md`.

```markdown
---
title: Page Title
description: One-line description for search and meta tags
---

Content here. Standard markdown with code blocks, tables, links.
```

## Constraints

- Only create tabs for content types the project actually has. Do not add an
  OpenAPI tab if there is no spec file. Do not add a Doxygen tab without XML.
- Do not document APIs by hand when a spec file exists — use the spec tab.
- Keep navigation shallow: 1-2 tabs, 2-4 groups for most projects.
- Use project brand colors if identifiable. Otherwise use a neutral palette.
- Match the project's existing voice and terminology.
- Do not encode open-ended critique or revision behavior. Critique is one
  bounded evaluation pass. Revision is at most one explicit bounded pass.

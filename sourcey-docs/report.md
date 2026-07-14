# Sourcey llms.txt delivery report

- **Project:** [runxhq/runx](https://github.com/runxhq/runx), a maintained OSS runtime and CLI whose documentation spans installation, skills, operator workflows, publishing, testing, and reference material. A curated agent map makes those surfaces discoverable without requiring an agent to crawl the entire repository.
- **Pinned source:** generation used upstream commit `da74ceef021159fdb9d2d4929710bf85274d8db2`, so the result can be reproduced against a stable tree.
- **Generation:** Sourcey `3.6.5` ran `sourcey build --config sourcey.config.ts --output sourcey-docs` and reported 8 successfully generated pages. The committed config selects `README.md` and `docs/**/*.md`; `llms.txt` is generated output, not a hand-authored substitute.
- **Public artifact:** the generated [llms.txt](https://raw.githubusercontent.com/runxhq/runx/refs/pull/284/head/sourcey-docs/llms.txt) is anonymously fetchable from the upstream repository's durable PR ref, rather than a claimant-owned fork URL.
- **Upstream adoption:** [runxhq/runx PR #284](https://github.com/runxhq/runx/pull/284) is open against the project's own repository and includes the config, generated site, llms.txt, and a maintainer-facing rationale.
- **Governed validation:** `runx --version` returned `runx-cli 0.7.0`. The deterministic validation checked 8 llms.txt entries, 8 configured Markdown sources, and 8 generated HTML targets. Receipt `runx:receipt:sha256:cb15eef4515c4f8b8c8d572213850d7ac137d5eafeea9ecfefe9443e3642c735` verifies with `valid=true` and `signature.mode=production`; the public verification key is in `sourcey-docs/authority.json`.
- **Audit 1, Getting Started:** the entry maps to `sourcey-docs/documentation/docs/getting-started.html`, generated from the real `docs/getting-started.md` walkthrough.
- **Audit 2, Agent Skills:** the entry maps to `sourcey-docs/documentation/docs/agent-skills.html`, generated from `docs/agent-skills.md` and accurately describes runx integration with Claude and Codex.
- **Audit 3, Operator Skills:** the entry maps to `sourcey-docs/documentation/docs/operator-skills.html`, generated from `docs/operator-skills.md` and covers the project's operator control layer.
- **Audit 4, Issue To PR Flow:** the entry maps to `sourcey-docs/documentation/docs/issue-to-pr.html`, generated from `docs/issue-to-pr.md` and describes the governed issue-to-PR lane.
- **Audit 5, Publishing:** the entry maps to `sourcey-docs/documentation/docs/publishing.html`, generated from `docs/publishing.md` and documents registry publication.
- **Additional coverage:** How We Test and runx reference map to matching generated HTML pages backed by `docs/how-we-test.md` and `docs/reference.md`; all eight llms.txt targets exist in the committed output.

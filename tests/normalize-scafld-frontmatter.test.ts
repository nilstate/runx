import { describe, expect, it } from "vitest";

import normalizeScafldFrontmatter from "../tools/spec/normalize_scafld_frontmatter/src/index.js";

describe("spec.normalize_scafld_frontmatter", () => {
  it("collapses agent-authored top-level titles to one canonical scafld title", async () => {
    const result = await normalizeScafldFrontmatter.runWith({
      task_id: "issue-91-docs",
      thread_title: "Dogfood checklist docs",
      size: "small",
      risk: "low",
      spec_contents: `---
spec_version: '2.0'
task_id: issue-91-docs
created: 2026-05-12T00:00:00Z
updated: 2026-05-12T00:00:00Z
status: draft
harden_status: not_run
size: small
risk_level: low
---

# Draft title from the agent

## Current State

Still relevant.

# Duplicate title from the issue body

## Summary

Keep this section.

\`\`\`
# This is fenced text, not a Markdown title.
\`\`\`
`,
    });

    if (!("data" in result)) {
      throw new Error("expected packet output");
    }

    const packet = result as { readonly data: { readonly contents: string; readonly repairs: readonly string[] } };
    const contents = packet.data.contents;
    const headings = contents.match(/^# .+$/gmu) ?? [];

    expect(headings).toEqual([
      "# Dogfood checklist docs",
      "# This is fenced text, not a Markdown title.",
    ]);
    expect(contents).not.toContain("Draft title from the agent");
    expect(contents).not.toContain("Duplicate title from the issue body");
    expect(contents).toContain("## Current State\n\nStill relevant.");
    expect(contents).toContain("## Summary\n\nKeep this section.");
    expect(packet.data.repairs).toContain("title_heading");
  });
});

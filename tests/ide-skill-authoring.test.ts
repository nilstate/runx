import { describe, expect, it } from "vitest";

import { buildSkillPreview, skillSnippets, validateSkillMarkdown } from "../plugins/ide-core/src/index.js";
import { buildSkillPreview as antigravityPreview } from "../plugins/antigravity/src/skill-authoring.js";

describe("ide skill authoring", () => {
  it("validates portable skills, exposes snippets, and previews execution profile mode", () => {
    const markdown = `---
name: sourcey
description: Generate deep project docs.
---

Use the provided context to generate documentation.
`;

    expect(validateSkillMarkdown(markdown)).toEqual([]);
    expect(validateSkillMarkdown("---\ndescription: Missing name\n---\nBody")).toContainEqual(
      expect.objectContaining({ severity: "error", path: "frontmatter.name" }),
    );
    expect(validateSkillMarkdown("---\nname: old\nrunx: true\n---\nBody")).toContainEqual(
      expect.objectContaining({ severity: "warning", path: "frontmatter.runx" }),
    );

    const snippets = skillSnippets();
    expect(snippets.map((snippet) => snippet.prefix)).toEqual(
      expect.arrayContaining(["runx-skill", "runx-binding-cli", "runx-binding-mcp", "runx-binding-a2a"]),
    );

    const preview = buildSkillPreview({ markdown, profileDocument: "runners:\n  agent:\n    type: agent\n" });
    expect(preview).toMatchObject({
      title: "sourcey",
      summary: "Generate deep project docs.",
      runnerMode: "profiled",
    });
    expect(antigravityPreview({ markdown }).runnerMode).toBe("portable");
  });
});

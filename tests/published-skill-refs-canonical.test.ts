import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveGraphStepExecution } from "../packages/runtime-local/src/runner-local/execution-targets.js";
import { parseRegistryRef, type OfficialSkillResolver } from "@runxhq/runtime-local";
import { rewriteSiblingSkillRefs } from "../packages/cli/src/skill-refs.js";

const SIBLING_PROFILE = `skill: leaf
runners:
  default:
    default: true
    type: agent
`;

const SIBLING_MARKDOWN = `---
name: leaf
description: leaf skill
---
content
`;

describe("graph-step skill resolver recognizes canonical official-skill refs", () => {
  it("falls through to OfficialSkillResolver when ref looks canonical and no registry store is set", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-canonical-resolver-"));
    const cacheRoot = path.join(tempDir, "official-skills");
    const leafDir = path.join(cacheRoot, "runx", "leaf", "sha-deadbeef");
    await mkdir(leafDir, { recursive: true });
    await writeFile(path.join(leafDir, "X.yaml"), SIBLING_PROFILE);
    await writeFile(path.join(leafDir, "SKILL.md"), SIBLING_MARKDOWN);

    const calls: Array<{ owner: string; name: string; version?: string }> = [];
    const officialSkillResolver: OfficialSkillResolver = {
      async resolve(parsed) {
        calls.push({ owner: parsed.owner, name: parsed.name, version: parsed.version });
        return leafDir;
      },
    };

    const result = await resolveGraphStepExecution({
      step: { id: "use-leaf", skill: "runx/leaf@sha-deadbeef" } as never,
      graphDirectory: tempDir,
      graphStepCache: new Map(),
      officialSkillResolver,
    });
    expect(result.skillPath).toBe(leafDir);
    expect(calls).toEqual([{ owner: "runx", name: "leaf", version: "sha-deadbeef" }]);

    await rm(tempDir, { recursive: true, force: true });
  });

  it("throws a clear error when neither resolver nor registry store is configured", async () => {
    await expect(
      resolveGraphStepExecution({
        step: { id: "use-leaf", skill: "runx/leaf" } as never,
        graphDirectory: "/tmp",
        graphStepCache: new Map(),
      }),
    ).rejects.toThrow(/no registry store or official-skill resolver is configured/);
  });

  it("parseRegistryRef captures owner, name, and version", () => {
    expect(parseRegistryRef("runx/leaf@sha-deadbeef")).toMatchObject({
      owner: "runx",
      name: "leaf",
      version: "sha-deadbeef",
    });
  });
});

describe("rewriteSiblingSkillRefs", () => {
  it("rewrites ../sibling refs to canonical ids", () => {
    const text = `runners:
  default:
    type: graph
    graph:
      steps:
        - id: a
          skill: ../scafld
        - id: b
          skill: ../leaf
`;
    const versions = new Map([["scafld", "sha-1"], ["leaf", "sha-2"]]);
    const result = rewriteSiblingSkillRefs(text, "runx", versions);
    expect(result.didRewrite).toBe(true);
    expect(result.text).toContain("skill: runx/scafld@sha-1");
    expect(result.text).toContain("skill: runx/leaf@sha-2");
    expect(result.text).not.toContain("skill: ../scafld");
    expect(result.text).not.toContain("skill: ../leaf");
  });

  it("leaves unknown siblings untouched", () => {
    const text = "skill: ../missing\nskill: ../known\n";
    const versions = new Map([["known", "sha-1"]]);
    const result = rewriteSiblingSkillRefs(text, "runx", versions);
    expect(result.didRewrite).toBe(true);
    expect(result.text).toContain("skill: ../missing");
    expect(result.text).toContain("skill: runx/known@sha-1");
  });

  it("is a no-op when no refs match", () => {
    const text = "skill: runx/already-canonical@v1\n";
    const result = rewriteSiblingSkillRefs(text, "runx", new Map([["foo", "v"]]));
    expect(result.didRewrite).toBe(false);
    expect(result.text).toBe(text);
  });
});

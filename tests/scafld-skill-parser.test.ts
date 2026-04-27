import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseRunnerManifestYaml, parseSkillMarkdown, validateRunnerManifest, validateSkill } from "@runxhq/core/parser";

describe("scafld skill contract", () => {
  it("keeps the portable skill standard while X stays a thin native scafld consumer", async () => {
    const skillPath = path.resolve("skills/scafld/SKILL.md");
    const wrapperPath = path.resolve("skills/scafld/run.mjs");
    const skill = validateSkill(parseSkillMarkdown(await readFile(skillPath, "utf8")), { mode: "strict" });
    const manifest = validateRunnerManifest(parseRunnerManifestYaml(await readFile(path.resolve("skills/scafld/X.yaml"), "utf8")));
    const wrapper = await readFile(wrapperPath, "utf8");
    const runner = manifest.runners["scafld-cli"];
    const agentRunner = manifest.runners.agent;

    expect(skill.name).toBe("scafld");
    expect(skill.source.type).toBe("agent");
    expect(skill.inputs).toEqual({});
    expect(runner?.default).toBe(true);
    expect(runner?.source.type).toBe("cli-tool");
    expect(runner?.source.command).toBe("node");
    expect(runner?.source.args).toEqual(["./run.mjs"]);
    expect(wrapper).toContain("const result = spawnSync(scafld, args");
    expect(wrapper).toContain('args.push("--json")');
    expect(wrapper).toContain("const command = ({ spec: \"new\", execute: \"exec\" })[requested] || requested;");
    expect(wrapper).toContain('"summary"');
    expect(wrapper).toContain('"checks"');
    expect(wrapper).toContain('"pr-body"');
    expect(wrapper).not.toContain("normalizeStructuredOutput");
    expect(wrapper).not.toContain("buildStatusReport");
    expect(wrapper).not.toContain("buildReviewReport");
    expect(wrapper).not.toContain("buildCompleteReport");
    expect(wrapper).not.toContain("env: process.env");
    expect(runner?.source.timeoutSeconds).toBe(300);
    expect(agentRunner?.source.type).toBe("agent");
    expect(agentRunner?.inputs.review_file.required).toBe(true);
    expect(agentRunner?.inputs.review_prompt.required).toBe(true);
    expect(runner?.inputs.command.required).toBe(true);
    expect(runner?.inputs.task_id.required).toBe(false);
    expect(runner?.inputs.base.required).toBe(false);
    expect(runner?.inputs.name.required).toBe(false);
    expect(runner?.inputs.bind_current.required).toBe(false);
    expect(runner?.runtime).toEqual({
      requirements: [
        "scafld CLI with native JSON contracts available on PATH, via SCAFLD_BIN, or through explicit scafld_bin input",
      ],
    });
  });
});

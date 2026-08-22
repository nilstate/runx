import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { validateRunnerManifestYaml } from "../scripts/lib/native-parser.mjs";

type Step = {
  readonly id: string;
  readonly tool?: string;
  readonly skill?: string;
  readonly runner?: string;
  readonly run?: {
    readonly type: string;
    readonly agent?: string;
    readonly task?: string;
    readonly outputs?: Readonly<Record<string, string>>;
  };
};

type Runner = {
  readonly default?: boolean;
  readonly source: {
    readonly type: string;
    readonly graph?: { readonly name: string; readonly steps: readonly Step[] };
  };
};

type Manifest = {
  readonly runners: Readonly<Record<string, Runner>>;
};

describe("operator-first issue-to-PR contract", () => {
  it("uses host-native work and governs only optional PR publication", async () => {
    const skillDir = path.resolve("skills/issue-to-pr");
    const manifest = validateRunnerManifestYaml(
      await readFile(path.join(skillDir, "X.yaml"), "utf8"),
    ) as Manifest;
    const instructions = (await readFile(path.join(skillDir, "SKILL.md"), "utf8"))
      .replace(/\s+/gu, " ");

    expect(manifest.runners["issue-to-pr"]?.default).toBe(true);
    expect(stepIds(manifest.runners["issue-to-pr"])).toEqual([
      "read-issue",
      "bind-issue-evidence",
      "host",
    ]);
    expect(stepIds(manifest.runners["from-evidence"])).toEqual(["host"]);
    expect(stepIds(manifest.runners.host)).toEqual([
      "host-work",
      "admit-host-result",
      "verify-publication",
      "publish-pr",
      "finalize-published",
      "verify-local",
      "finalize-local",
      "finalize-blocked",
    ]);
    expect(stepIds(manifest.runners.resume)).toEqual([
      "admit-host-result",
      "verify-publication",
      "publish-pr",
      "finalize-published",
      "verify-local",
      "finalize-local",
      "finalize-blocked",
    ]);
    expect(stepIds(manifest.runners.publish)).toEqual([
      "verify",
      "publish-pr",
      "finalize",
    ]);

    const hostWork = graph(manifest.runners.host).steps.find((step) => step.id === "host-work");
    expect(hostWork?.run).toEqual({
      type: "agent-task",
      agent: "builder",
      task: "issue-to-pr-host-work",
      outputs: { host_result: "object" },
    });
    expect(graph(manifest.runners.publish).steps).toMatchObject([
      { id: "verify", skill: ".", runner: "verify" },
      { id: "publish-pr", tool: "provider.mutate" },
      { id: "finalize", run: { type: "javascript" } },
    ]);

    expect(instructions).toContain("ordinary tools");
    expect(instructions).toContain("already-authenticated local `gh` and Git paths");
    expect(instructions).toContain("`scafld finalize` exactly once");
    expect(instructions).toContain("optional downstream skills");
    expect(instructions).not.toContain("push-outbox");
    expect(instructions).not.toContain("issue-to-pr-author-spec");
  });
});

function graph(runner: Runner | undefined) {
  if (!runner || runner.source.type !== "graph" || !runner.source.graph) {
    throw new Error("runner must contain a graph");
  }
  return runner.source.graph;
}

function stepIds(runner: Runner | undefined): string[] {
  return graph(runner).steps.map((step) => step.id);
}

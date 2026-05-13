import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseRunnerManifestYaml, validateRunnerManifest } from "@runxhq/core/parser";

describe("scafld issue-to-PR skill contract", () => {
  it("parses as a composite skill with native scafld v2 lifecycle and handoff packaging", async () => {
    const manifest = validateRunnerManifest(
      parseRunnerManifestYaml(await readFile(path.resolve("skills/issue-to-pr/X.yaml"), "utf8")),
    );
    const runner = manifest.runners["issue-to-pr"];

    expect(runner?.source.type).toBe("graph");
    if (!runner || runner.source.type !== "graph" || !runner.source.graph) {
      throw new Error("issue-to-pr runner must declare an inline graph.");
    }
    const graph = runner.source.graph;

    expect(graph.name).toBe("issue-to-pr");
    expect(graph.steps.map((step) => step.id)).toEqual([
      "scafld-plan",
      "author-spec",
      "normalize-spec",
      "write-spec",
      "read-draft-spec",
      "scafld-validate",
      "scafld-approve",
      "read-approved-spec",
      "read-declared-files",
      "author-fix",
      "write-fix",
      "scafld-build",
      "scafld-status",
      "read-current-branch",
      "scafld-review",
      "scafld-complete",
      "scafld-final-status",
      "scafld-handoff",
      "package-pull-request",
      "push-pull-request",
    ]);
    expect(
      Object.fromEntries(graph.steps.filter((step) => step.inputs.command !== undefined).map((step) => [step.id, step.inputs.command])),
    ).toEqual({
      "scafld-plan": "plan",
      "scafld-validate": "validate",
      "scafld-approve": "approve",
      "scafld-build": "build_to_review",
      "scafld-status": "status",
      "scafld-review": "review",
      "scafld-complete": "complete",
      "scafld-final-status": "status",
      "scafld-handoff": "handoff",
    });
    expect(graph.steps.map((step) => step.inputs.command).filter(Boolean)).not.toEqual(
      expect.arrayContaining(["new", "start", "branch", "audit", "summary", "checks", "pr-body"]),
    );
    expect(graph.steps.some((step) => (step.tool ?? "").includes("capture"))).toBe(false);
    expect(graph.steps.find((step) => step.id === "author-spec")).toMatchObject({
      run: {
        type: "agent-task",
        task: "issue-to-pr-author-spec",
      },
      context: {
        spec_path: "scafld-plan.result.path",
      },
    });
    expect(graph.steps.find((step) => step.id === "author-spec")?.instructions).toContain("scafld 2.0 markdown spec");
    expect(graph.steps.find((step) => step.id === "author-spec")?.instructions).toContain("Do not use runx skill runner");
    expect(graph.steps.find((step) => step.id === "author-spec")?.instructions).toContain("Files impacted");
    expect(graph.steps.find((step) => step.id === "author-spec")?.instructions).toContain("repo-change scope empty");
    expect(graph.steps.find((step) => step.id === "normalize-spec")).toMatchObject({
      tool: "spec.normalize_scafld_frontmatter",
      context: {
        spec_contents: "author-spec.spec_contents",
      },
    });
    expect(graph.steps.find((step) => step.id === "write-spec")).toMatchObject({
      tool: "fs.write",
      context: {
        path: "scafld-plan.result.path",
        contents: "normalize-spec.normalized_spec.data.data.contents",
      },
    });
    expect(graph.steps.find((step) => step.id === "read-approved-spec")).toMatchObject({
      tool: "fs.read",
      context: {
        path: "scafld-approve.result.path",
      },
    });
    expect(graph.steps.find((step) => step.id === "author-fix")).toMatchObject({
      run: {
        type: "agent-task",
        task: "issue-to-pr-apply-fix",
      },
      context: {
        spec_path: "scafld-approve.result.path",
        declared_file_context: "read-declared-files.declared_file_context.data",
      },
    });
    expect(graph.steps.find((step) => step.id === "author-fix")?.instructions).toContain("fix_bundle.status: blocked");
    expect(graph.steps.find((step) => step.id === "author-fix")?.instructions).toContain("one scoped docs edit is possible");
    expect(graph.steps.find((step) => step.id === "read-current-branch")).toMatchObject({
      tool: "git.current_branch",
    });
    expect(graph.steps.find((step) => step.id === "package-pull-request")).toMatchObject({
      tool: "outbox.build_pull_request",
      context: {
        handoff_markdown: "scafld-handoff.stdout",
        build_result: "scafld-build.result",
        review_result: "scafld-review.result",
        completion_result: "scafld-complete.result",
        status_snapshot: "scafld-final-status.result",
        current_branch: "read-current-branch.git_branch.data",
      },
    });
    expect(graph.steps.find((step) => step.id === "push-pull-request")).toMatchObject({
      tool: "thread.push_outbox",
      context: {
        outbox_entry: "package-pull-request.outbox_entry.data",
        draft_pull_request: "package-pull-request.draft_pull_request.data",
      },
      inputs: {
        next_status: "draft",
      },
    });
    expect(graph.policy?.transitions).toEqual([
      {
        to: "write-fix",
        field: "author-fix.fix_bundle.data.files",
        notEquals: [],
      },
    ]);
  });
});

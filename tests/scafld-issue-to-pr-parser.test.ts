import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { validateRunnerManifestYaml } from "../scripts/lib/native-parser.mjs";

type IssueToPrManifest = {
  readonly runners: Readonly<Record<string, {
    readonly source: {
      readonly type: string;
      readonly graph?: {
        readonly name: string;
        readonly steps: readonly {
          readonly id: string;
          readonly label?: string;
          readonly inputs: Readonly<Record<string, unknown>>;
        }[];
        readonly policy?: { readonly guards?: unknown };
      };
    };
  }>>;
};

describe("scafld issue-to-PR skill contract", () => {
  it("parses as a composite skill with native scafld v2 lifecycle and handoff packaging", async () => {
    const manifest = validateRunnerManifestYaml(
      await readFile(path.resolve("skills/issue-to-pr/X.yaml"), "utf8"),
    ) as IssueToPrManifest;
    const skillInstructions = await readFile(path.resolve("skills/issue-to-pr/SKILL.md"), "utf8");
    const normalizedSkillInstructions = skillInstructions.replace(/\s+/g, " ");
    const runner = manifest.runners["issue-to-pr"];

    expect(runner?.source.type).toBe("graph");
    if (!runner || runner.source.type !== "graph" || !runner.source.graph) {
      throw new Error("issue-to-pr runner must declare an inline graph.");
    }
    const graph = runner.source.graph;

    expect(graph.name).toBe("issue-to-pr");
    expect(graph.steps.map((step) => step.id)).toEqual([
      "scafld-plan",
      "read-planned-spec",
      "author-spec",
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
      "capture-harness-context",
      "package-pull-request",
      "push-pull-request",
      "package-feed-entry",
      "push-feed-entry",
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
    expect(graph.steps.find((step) => step.id === "capture-harness-context")).toMatchObject({
      tool: "control.capture_harness_context",
      inputs: {
        harness: "$input.harness",
        signal: "$input.signal",
        decision: "$input.decision",
      },
    });
    expect(graph.steps.find((step) => step.id === "author-spec")).toMatchObject({
      run: {
        type: "agent-task",
        task: "issue-to-pr-author-spec",
        outputs: {
          spec_contents: "string",
          context_files: "array",
        },
      },
      context: {
        spec_path: "scafld-plan.result.data.path",
        planned_spec_contents: "read-planned-spec.file_read.data.contents",
      },
    });
    expect(normalizedSkillInstructions).toContain("scafld 2.4-compatible markdown spec");
    expect(normalizedSkillInstructions).toContain("Do not use runx runtime internals");
    expect(normalizedSkillInstructions).toContain("Files impacted");
    expect(normalizedSkillInstructions).toContain("repo-change scope empty");
    expect(normalizedSkillInstructions).toContain("reviewer story");
    expect(normalizedSkillInstructions).toContain("For any code change");
    expect(normalizedSkillInstructions).toContain("targeted test/spec file");
    expect(normalizedSkillInstructions).toContain("code PRs are not publishable");
    expect(normalizedSkillInstructions).toContain("new test/spec file");
    expect(graph.steps.find((step) => step.id === "read-planned-spec")).toMatchObject({
      tool: "fs.read",
      context: {
        path: "scafld-plan.result.data.path",
      },
    });
    expect(graph.steps.find((step) => step.id === "write-spec")).toMatchObject({
      tool: "fs.write",
      context: {
        path: "scafld-plan.result.data.path",
        contents: "author-spec.spec_contents",
      },
    });
    expect(graph.steps.find((step) => step.id === "read-approved-spec")).toMatchObject({
      tool: "fs.read",
      context: {
        path: "scafld-approve.result.data.path",
      },
    });
    expect(graph.steps.find((step) => step.id === "read-declared-files")).toMatchObject({
      tool: "fs.read_bundle",
      inputs: {
        on_missing: "report",
      },
      context: {
        paths: "author-spec.context_files",
      },
    });
    expect(graph.steps.find((step) => step.id === "author-fix")).toMatchObject({
      run: {
        type: "agent-task",
        task: "issue-to-pr-apply-fix",
      },
      context: {
        spec_path: "scafld-approve.result.data.path",
        declared_file_context: "read-declared-files.file_read_bundle.data",
      },
    });
    expect(normalizedSkillInstructions).toContain("fix_bundle.status: blocked");
    expect(normalizedSkillInstructions).toContain("one scoped docs edit is possible");
    expect(normalizedSkillInstructions).toContain("repo_snapshot.recommended_files");
    expect(normalizedSkillInstructions).toContain("For any production code change");
    expect(normalizedSkillInstructions).toContain("targeted test/spec file");
    expect(normalizedSkillInstructions).toContain("Do not publish a code-only fix bundle");
    expect(normalizedSkillInstructions).toContain("directly cover that requested behavior");
    expect(graph.steps.find((step) => step.id === "read-current-branch")).toMatchObject({
      tool: "git.current_branch",
    });
    expect(graph.steps.find((step) => step.id === "package-pull-request")).toMatchObject({
      tool: "outbox.build_pull_request",
      context: {
        harness_context: "capture-harness-context.harness_context.data",
        handoff_markdown: "scafld-handoff.result.data.markdown",
        build_result: "scafld-build.result.data",
        review_result: "scafld-review.result.data",
        completion_result: "scafld-complete.result.data",
        status_snapshot: "scafld-final-status.result.data",
        current_branch: "read-current-branch.git_branch.data",
        fix_bundle: "author-fix.fix_bundle.data",
      },
      inputs: {
        thread_body: "$input.thread_body",
        repo_context: "$input.repo_context",
        repo_snapshot: "$input.repo_snapshot",
      },
    });
    expect(graph.steps.find((step) => step.id === "package-pull-request")?.label).toBe("package reviewer PR story");
    expect(graph.steps.find((step) => step.id === "push-pull-request")).toMatchObject({
      skill: "./push-outbox",
      context: {
        outbox_entry: "package-pull-request.outbox_entry.data",
        draft_pull_request: "package-pull-request.draft_pull_request.data",
      },
      inputs: {
        thread: "$input.thread",
        fixture: "$input.fixture",
        workspace_path: "$input.workspace_path",
        next_status: "draft",
      },
    });
    expect(graph.steps.find((step) => step.id === "package-feed-entry")).toMatchObject({
      tool: "outbox.build_feed_entry",
      context: {
        harness_context: "capture-harness-context.harness_context.data",
        build_result: "scafld-build.result.data",
        review_result: "scafld-review.result.data",
        completion_result: "scafld-complete.result.data",
        status_snapshot: "scafld-final-status.result.data",
        draft_pull_request: "package-pull-request.draft_pull_request.data",
        pull_request_outbox_entry: "push-pull-request.outbox_entry",
        push_result: "push-pull-request.push",
      },
    });
    expect(graph.steps.find((step) => step.id === "push-feed-entry")).toMatchObject({
      skill: "./push-outbox",
      context: {
        outbox_entry: "package-feed-entry.outbox_entry.data",
        draft_pull_request: "package-pull-request.draft_pull_request.data",
      },
      inputs: {
        fixture: "$input.fixture",
        workspace_path: "$input.workspace_path",
        next_status: "published",
      },
    });
    expect(graph.policy?.guards).toEqual([
      {
        step: "write-fix",
        field: "author-fix.fix_bundle.data.files",
        notEquals: [],
      },
    ]);
  });
});

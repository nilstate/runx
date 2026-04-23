import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseRunnerManifestYaml, validateRunnerManifest } from "../packages/parser/src/index.js";

describe("scafld issue-to-PR skill contract", () => {
  it("parses as a composite skill with native scafld branch, sync, status, and projection phases", async () => {
    const manifest = validateRunnerManifest(
      parseRunnerManifestYaml(await readFile(path.resolve("skills/issue-to-pr/X.yaml"), "utf8")),
    );
    const runner = manifest.runners["issue-to-pr"];

    expect(runner?.source.type).toBe("chain");
    if (!runner || runner.source.type !== "chain" || !runner.source.chain) {
      throw new Error("issue-to-pr runner must declare an inline chain.");
    }
    const chain = runner.source.chain;

    expect(chain.name).toBe("issue-to-pr");
    expect(chain.steps.map((step) => step.id)).toEqual([
      "scafld-init",
      "scafld-new",
      "author-spec",
      "write-spec",
      "read-draft-spec",
      "scafld-validate",
      "scafld-approve",
      "scafld-start",
      "scafld-branch",
      "read-active-spec",
      "read-declared-files",
      "author-fix",
      "write-fix",
      "scafld-exec",
      "scafld-status",
      "scafld-audit",
      "scafld-review-open",
      "read-review-template",
      "reviewer-boundary",
      "write-review",
      "scafld-complete",
      "scafld-summary",
      "scafld-checks",
      "scafld-pr-body",
      "package-pull-request",
      "push-pull-request",
    ]);
    expect(chain.steps.map((step) => step.skill ?? "")).toEqual([
      "../scafld",
      "../scafld",
      "",
      "",
      "",
      "../scafld",
      "../scafld",
      "../scafld",
      "../scafld",
      "",
      "",
      "",
      "",
      "../scafld",
      "../scafld",
      "../scafld",
      "../scafld",
      "",
      "",
      "",
      "../scafld",
      "../scafld",
      "",
      "../scafld",
      "",
      "",
    ]);
    expect(chain.steps.map((step) => step.tool ?? "")).toEqual([
      "",
      "",
      "",
      "fs.write",
      "fs.read",
      "",
      "",
      "",
      "",
      "fs.read",
      "spec.read_declared_files",
      "",
      "fs.write_bundle",
      "",
      "",
      "",
      "",
      "fs.read",
      "",
      "fs.write",
      "",
      "",
      "scafld.capture_checks",
      "",
      "outbox.build_pull_request",
      "thread.push_outbox",
    ]);
    expect(
      Object.fromEntries(chain.steps.filter((step) => step.inputs.command !== undefined).map((step) => [step.id, step.inputs.command])),
    ).toEqual({
      "scafld-init": "init",
      "scafld-new": "spec",
      "scafld-validate": "validate",
      "scafld-approve": "approve",
      "scafld-start": "start",
      "scafld-branch": "branch",
      "scafld-exec": "execute",
      "scafld-status": "status",
      "scafld-audit": "audit",
      "scafld-review-open": "review",
      "scafld-complete": "complete",
      "scafld-summary": "summary",
      "scafld-pr-body": "pr-body",
    });
    expect(chain.steps.some((step) => (step.skill ?? "").includes("fixture-agent"))).toBe(false);
    expect(chain.steps.find((step) => step.id === "author-spec")).toMatchObject({
      run: {
        type: "agent-step",
        task: "issue-to-pr-author-spec",
      },
      context: {
        draft_spec_path: "scafld-new.state.file",
      },
    });
    expect(chain.steps.find((step) => step.id === "author-spec")?.instructions).toContain("spec_version");
    expect(chain.steps.find((step) => step.id === "author-spec")?.instructions).toContain("concrete repo-relative");
    expect(chain.steps.find((step) => step.id === "author-spec")?.instructions).toContain("Do not declare any `.ai/specs/drafts/<task_id>.yaml`");
    expect(chain.steps.find((step) => step.id === "author-spec")?.instructions).toContain("do not declare scafld-managed control-plane artifacts");
    expect(chain.steps.find((step) => step.id === "scafld-branch")).toMatchObject({
      skill: "../scafld",
      inputs: {
        command: "branch",
      },
    });
    expect(chain.steps.find((step) => step.id === "read-active-spec")).toMatchObject({
      tool: "fs.read",
      context: {
        path: "scafld-start.result.transition.to",
      },
    });
    expect(chain.steps.find((step) => step.id === "author-fix")).toMatchObject({
      run: {
        type: "agent-step",
        task: "issue-to-pr-apply-fix",
      },
      context: {
        spec_path: "scafld-start.result.transition.to",
        branch_binding: "scafld-branch.result.origin.git",
        sync_state: "scafld-branch.result.sync",
        declared_file_context: "read-declared-files.declared_file_context.data",
      },
    });
    expect(chain.steps.find((step) => step.id === "author-fix")?.instructions).toContain("branch_binding and sync_state");
    expect(chain.steps.find((step) => step.id === "author-fix")?.instructions).toContain("declared_file_context");
    expect(chain.steps.find((step) => step.id === "author-fix")?.instructions).toContain("fix_bundle.status: blocked");
    expect(chain.steps.find((step) => step.id === "author-fix")?.instructions).toContain("do not recreate or hand-edit the");
    expect(chain.steps.find((step) => step.id === "scafld-status")).toMatchObject({
      skill: "../scafld",
      inputs: {
        command: "status",
      },
    });
    expect(chain.steps.find((step) => step.id === "read-review-template")).toMatchObject({
      tool: "fs.read",
      context: {
        path: "scafld-review-open.result.review_file",
      },
    });
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")).toMatchObject({
      run: {
        type: "agent-step",
        task: "issue-to-pr-review",
      },
      context: {
        review_file: "scafld-review-open.result.review_file",
        review_prompt: "scafld-review-open.result.review_prompt",
        review_required_sections: "scafld-review-open.result.required_sections",
        review_file_contents: "read-review-template.file_read.data.contents",
        fix_bundle: "author-fix.fix_bundle.data",
        written_files: "write-fix.file_bundle_write.data.files",
        status_snapshot: "scafld-status.result",
      },
    });
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("schema_version: 3");
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("reviewed_at");
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("reviewed_head");
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("pass_with_issues");
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("review_file_contents");
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("status snapshot");
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("## Review N — <timestamp>");
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("Do not rename");
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("write the literal `None.`");
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")?.instructions).toContain("Do not write placeholder bullets");
    expect(chain.steps.find((step) => step.id === "scafld-summary")).toMatchObject({
      skill: "../scafld",
      inputs: {
        command: "summary",
      },
    });
    expect(chain.steps.find((step) => step.id === "scafld-checks")).toMatchObject({
      tool: "scafld.capture_checks",
    });
    expect(chain.steps.find((step) => step.id === "scafld-pr-body")).toMatchObject({
      skill: "../scafld",
      inputs: {
        command: "pr-body",
      },
    });
    expect(chain.steps.find((step) => step.id === "package-pull-request")).toMatchObject({
      tool: "outbox.build_pull_request",
      context: {
        summary_projection: "scafld-summary.result",
        checks_projection: "scafld-checks.result",
        pr_body_projection: "scafld-pr-body.result",
        completion_result: "scafld-complete.result",
        completion_state: "scafld-complete.state",
        status_snapshot: "scafld-status.result",
      },
    });
    expect(chain.steps.find((step) => step.id === "push-pull-request")).toMatchObject({
      tool: "thread.push_outbox",
      context: {
        outbox_entry: "package-pull-request.outbox_entry.data",
        draft_pull_request: "package-pull-request.draft_pull_request.data",
      },
      inputs: {
        next_status: "draft",
      },
    });
    expect(chain.policy?.transitions).toEqual([
      {
        to: "write-fix",
        field: "author-fix.fix_bundle.data.files",
        notEquals: [],
      },
    ]);
  });
});

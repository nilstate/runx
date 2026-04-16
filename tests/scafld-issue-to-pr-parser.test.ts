import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseRunnerManifestYaml, validateRunnerManifest } from "../packages/parser/src/index.js";

describe("scafld issue-to-PR skill contract", () => {
  it("parses as a composite skill with explicit author, write, execute, and review phases", async () => {
    const manifest = validateRunnerManifest(
      parseRunnerManifestYaml(await readFile(path.resolve("bindings/runx/issue-to-pr/X.yaml"), "utf8")),
    );
    const runner = manifest.runners["issue-to-pr"];

    expect(runner?.source.type).toBe("chain");
    if (!runner || runner.source.type !== "chain" || !runner.source.chain) {
      throw new Error("issue-to-pr runner must declare an inline chain.");
    }
    const chain = runner.source.chain;

    expect(chain.name).toBe("issue-to-pr");
    expect(chain.steps.map((step) => step.id)).toEqual([
      "scafld-new",
      "author-spec",
      "write-spec",
      "read-spec",
      "scafld-validate",
      "scafld-approve",
      "scafld-start",
      "author-fix",
      "write-fix",
      "scafld-exec",
      "scafld-audit",
      "scafld-review-open",
      "reviewer-boundary",
      "write-review",
      "scafld-complete",
    ]);
    expect(chain.steps.map((step) => step.skill ?? "")).toEqual([
      "../scafld",
      "",
      "",
      "",
      "../scafld",
      "../scafld",
      "../scafld",
      "",
      "",
      "../scafld",
      "../scafld",
      "../scafld",
      "",
      "",
      "../scafld",
    ]);
    expect(chain.steps.map((step) => step.tool ?? "")).toEqual([
      "",
      "",
      "fs.write",
      "fs.read",
      "",
      "",
      "",
      "",
      "fs.write_bundle",
      "",
      "",
      "",
      "",
      "fs.write",
      "",
    ]);
    expect(
      Object.fromEntries(chain.steps.filter((step) => step.inputs.command !== undefined).map((step) => [step.id, step.inputs.command])),
    ).toEqual({
      "scafld-new": "spec",
      "scafld-validate": "validate",
      "scafld-approve": "approve",
      "scafld-start": "start",
      "scafld-exec": "execute",
      "scafld-audit": "audit",
      "scafld-review-open": "review",
      "scafld-complete": "complete",
    });
    expect(chain.steps.some((step) => (step.skill ?? "").includes("fixture-agent"))).toBe(false);
    expect(chain.steps.find((step) => step.id === "author-spec")).toMatchObject({
      run: {
        type: "agent-step",
        task: "issue-to-pr-author-spec",
      },
    });
    expect(chain.steps.find((step) => step.id === "author-spec")?.instructions).toContain("spec_version");
    expect(chain.steps.find((step) => step.id === "author-spec")?.instructions).toContain("concrete repo-relative");
    expect(chain.steps.find((step) => step.id === "author-fix")).toMatchObject({
      run: {
        type: "agent-step",
        task: "issue-to-pr-apply-fix",
      },
    });
    expect(chain.steps.find((step) => step.id === "reviewer-boundary")).toMatchObject({
      run: {
        type: "agent-step",
        task: "issue-to-pr-review",
      },
      context: {
        review_file: "scafld-review-open.review_file",
        review_prompt: "scafld-review-open.review_prompt",
        fix_bundle: "author-fix.fix_bundle.data",
        written_files: "write-fix.file_bundle_write.data.files",
      },
    });
    expect(chain.steps.find((step) => step.id === "scafld-complete")).toMatchObject({
      context: {
        reviewer_result: "reviewer-boundary.review_decision.data",
      },
    });
  });
});

import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { runHarnessTarget } from "../packages/harness/src/index.js";
import { parseRunnerManifestYaml, validateRunnerManifest } from "../packages/parser/src/index.js";
import { runLocalSkill, type Caller } from "../packages/runner-local/src/index.js";

const caller: Caller = {
  resolve: async () => undefined,
  report: () => undefined,
};

describe("docs-scan skill", () => {
  it("ships as a deterministic chain over stack detection, input discovery, and quality scoring", async () => {
    const manifest = validateRunnerManifest(
      parseRunnerManifestYaml(await readFile(path.resolve("skills/docs-scan/X.yaml"), "utf8")),
    );
    const runner = manifest.runners["docs-scan"];

    expect(runner?.source.type).toBe("chain");
    if (!runner || runner.source.type !== "chain" || !runner.source.chain) {
      throw new Error("docs-scan runner must declare an inline chain.");
    }

    expect(runner.inputs.repo_root).toMatchObject({
      type: "string",
      required: false,
    });
    expect(runner.inputs.repo_url).toMatchObject({
      type: "string",
      required: false,
    });
    expect(runner.inputs.docs_url).toMatchObject({
      type: "string",
      required: false,
    });
    expect(runner.inputs.objective).toMatchObject({
      type: "string",
      required: false,
    });
    expect(runner.inputs.scan_context).toMatchObject({
      type: "string",
      required: false,
    });

    const steps = runner.source.chain.steps;
    expect(steps.map((step) => step.id)).toEqual([
      "detect-stack",
      "discover-inputs",
      "score-quality",
    ]);
    expect(steps[0]).toMatchObject({
      tool: "docs.detect_stack",
    });
    expect(steps[1]).toMatchObject({
      tool: "docs.discover_inputs",
    });
    expect(steps[2]).toMatchObject({
      tool: "docs.score_quality",
      context: {
        stack_detection: "detect-stack.stack_detection.data",
        docs_input_candidates: "discover-inputs.docs_input_candidates.data.candidates",
      },
    });
  });

  it("passes the inline harness suite for both adopted and migration-target fixtures", async () => {
    const result = await runHarnessTarget(path.resolve("skills/docs-scan"));

    expect(result.source).toBe("inline");
    if (!("cases" in result)) {
      throw new Error("expected inline harness suite for docs-scan");
    }
    expect(result.assertionErrors).toEqual([]);
    expect(result.cases.length).toBe(2);
    expect(result.cases.every((entry) => entry.status === "success")).toBe(true);
  }, 15_000);

  it("returns a non-recommended packet for a repo that already uses Sourcey", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-docs-scan-sourcey-"));

    try {
      const result = await runLocalSkill({
        skillPath: path.resolve("skills/docs-scan"),
        inputs: {
          repo_root: "fixtures/sourcey/basic",
          repo_url: "https://github.com/sourcey/sourcey-basic-fixture",
        },
        caller,
        env: { ...process.env, RUNX_CWD: process.cwd() },
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        throw new Error(result.status === "failure" ? result.execution.stderr || result.execution.errorMessage : result.status);
      }

      const packet = JSON.parse(result.execution.stdout) as {
        schema: string;
        stack_detection: { stack: string; confidence: string };
        docs_input_candidates: Array<{ kind: string; path?: string }>;
        preview_recommendation: { recommended: boolean; rationale: string };
        quality_assessment: { quality_band: string; pain_signals: string[] };
      };

      expect(packet).toMatchObject({
        schema: "runx.docs_scan.v1",
        stack_detection: {
          stack: "sourcey",
          confidence: "high",
        },
        preview_recommendation: {
          recommended: false,
        },
      });
      expect(packet.docs_input_candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "config", path: "sourcey.config.ts" }),
        expect.objectContaining({ kind: "openapi", path: "openapi.yaml" }),
        expect.objectContaining({ kind: "markdown", path: "introduction.md" }),
        expect.objectContaining({ kind: "mcp", path: "mcp.json" }),
      ]));
      expect(packet.quality_assessment.quality_band).toMatch(/excellent|good/);
      expect(packet.quality_assessment.pain_signals).toContain("already_uses_sourcey");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("recommends a private preview for a thin OpenAPI repo without a strong docs stack", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-docs-scan-openapi-"));

    try {
      const result = await runLocalSkill({
        skillPath: path.resolve("skills/docs-scan"),
        inputs: {
          repo_root: "fixtures/docs/scan/openapi-adoption",
          repo_url: "https://github.com/example/openapi-adoption",
        },
        caller,
        env: { ...process.env, RUNX_CWD: process.cwd() },
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        throw new Error(result.status === "failure" ? result.execution.stderr || result.execution.errorMessage : result.status);
      }

      const packet = JSON.parse(result.execution.stdout) as {
        target: { repo_slug?: string };
        stack_detection: { stack: string };
        docs_input_candidates: Array<{ kind: string }>;
        preview_recommendation: { recommended: boolean; rationale: string };
        quality_assessment: { quality_band: string; pain_signals: string[] };
      };

      expect(packet.target.repo_slug).toBe("example/openapi-adoption");
      expect(packet.stack_detection.stack).toMatch(/readme|unknown/);
      expect(packet.docs_input_candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "openapi" }),
        expect.objectContaining({ kind: "markdown" }),
      ]));
      expect(packet.preview_recommendation.recommended).toBe(true);
      expect(packet.preview_recommendation.rationale).toContain("preview");
      expect(packet.quality_assessment.quality_band).toBe("mediocre");
      expect(packet.quality_assessment.pain_signals).toContain("api_spec_without_dedicated_docs_surface");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

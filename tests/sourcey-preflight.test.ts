import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";
import { parseRunnerManifestYaml, parseSkillMarkdown, validateRunnerManifest, validateSkill } from "../packages/parser/src/index.js";
import { runLocalSkill, type Caller } from "../packages/runner-local/src/index.js";

describe("sourcey parser", () => {
  it("keeps the portable skill standard while X owns the mixed-runner contract", async () => {
    const skill = validateSkill(parseSkillMarkdown(await readFile(path.resolve("skills/sourcey/SKILL.md"), "utf8")));
    const manifest = validateRunnerManifest(parseRunnerManifestYaml(await readFile(path.resolve("skills/sourcey/x.yaml"), "utf8")));
    const runner = manifest.runners.sourcey;

    expect(skill.name).toBe("sourcey");
    expect(skill.source.type).toBe("agent");
    expect(skill.inputs).toEqual({});
    expect(runner?.default).toBe(true);
    expect(runner?.source.type).toBe("chain");
    expect(Object.keys(manifest.runners)).toEqual(["agent", "sourcey"]);
  });
});

describe("sourcey preflight", () => {
  it("yields an agent request with explicit allowed_tools through the default mixed-runner JSON CLI", async () => {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const fixtureProject = path.resolve("fixtures/sourcey/incomplete");

    const exitCode = await runCli(
      ["skill", "skills/sourcey", "--project", fixtureProject, "--non-interactive", "--json"],
      { stdin: process.stdin, stdout, stderr },
      { ...process.env, RUNX_CWD: process.cwd() },
    );

    expect(exitCode).toBe(2);
    expect(stderr.contents()).toBe("");

    const report = JSON.parse(stdout.contents()) as {
      status: string;
      requests: Array<{
        id: string;
        kind: string;
        work?: {
          envelope: {
            skill: string;
            allowed_tools: string[];
          };
        };
      }>;
    };
    expect(report.status).toBe("needs_resolution");
    expect(report.requests[0]?.id).toBe("agent_step.sourcey-discover.output");
    expect(report.requests[0]?.kind).toBe("cognitive_work");
    expect(report.requests[0]?.work?.envelope.skill).toBe("sourcey.discover");
    expect(report.requests[0]?.work?.envelope.allowed_tools).toEqual([
      "fs.read",
      "git.status",
      "git.current_branch",
      "git.diff_name_only",
      "cli.capture_help",
    ]);
  });

  it("writes an inspectable chain receipt without storing raw discovered branding inputs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-sourcey-preflight-"));
    const receiptDir = path.join(tempDir, "receipts");
    const sourceyStub = path.join(tempDir, "sourcey-stub.mjs");
    const outputDir = path.join(tempDir, "docs");

    try {
      await writeSourceyStub(sourceyStub);

      const result = await runLocalSkill({
        skillPath: path.resolve("skills/sourcey"),
        inputs: {
          project: "fixtures/sourcey/basic",
          output_dir: outputDir,
          sourcey_bin: sourceyStub,
        },
        caller: createSourceyCaller({
          brandName: "Sourcey Fixture",
          homepageUrl: "https://sourcey.example.test",
        }),
        env: { ...process.env, RUNX_CWD: process.cwd() },
        receiptDir,
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        return;
      }

      expect(result.receipt.kind).toBe("chain_execution");
      const receiptFiles = await readdir(receiptDir);
      expect(receiptFiles).toContain("journals");
      expect(receiptFiles.filter((file) => file.endsWith(".json"))).toContain(`${result.receipt.id}.json`);
      const receiptText = await readFile(path.join(receiptDir, `${result.receipt.id}.json`), "utf8");
      expect(receiptText).not.toContain("https://sourcey.example.test");
      expect(receiptText).not.toContain("Sourcey Fixture");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("does not forward raw runx input environment into the Sourcey subprocess", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-sourcey-env-"));
    const sourceyStub = path.join(tempDir, "sourcey-stub.mjs");
    const envCapturePath = path.join(tempDir, "sourcey-env.json");
    const outputDir = path.join(tempDir, "docs");

    try {
      await writeSourceyStub(sourceyStub, envCapturePath);

      const result = await runLocalSkill({
        skillPath: path.resolve("skills/sourcey"),
        inputs: {
          project: "fixtures/sourcey/basic",
          output_dir: outputDir,
          sourcey_bin: sourceyStub,
        },
        caller: createSourceyCaller({
          brandName: "Sourcey Fixture",
          homepageUrl: "https://sourcey.example.test",
        }),
        env: {
          ...process.env,
          RUNX_CWD: process.cwd(),
          SOURCEY_STUB_ENV_PATH: envCapturePath,
        },
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("success");
      const leakedEnv = JSON.parse(await readFile(envCapturePath, "utf8")) as string[];
      expect(leakedEnv).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("runs config-mode builds from the config directory for default Sourcey config names", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-sourcey-config-cwd-"));
    const projectDir = path.join(tempDir, "project");
    const docsDir = path.join(projectDir, "docs");
    const sourceyStub = path.join(tempDir, "sourcey-stub.mjs");
    const invocationPath = path.join(tempDir, "sourcey-invocation.json");
    const outputDir = path.join(projectDir, ".sourcey", "runx-docs");

    try {
      await mkdir(docsDir, { recursive: true });
      await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: "sourcey-cwd-fixture" }, null, 2));
      await writeFile(path.join(docsDir, "sourcey.config.ts"), "export default {};\n");
      await writeSourceyStub(sourceyStub);

      const result = await runLocalSkill({
        skillPath: path.resolve("skills/sourcey"),
        inputs: {
          project: projectDir,
          output_dir: outputDir,
          sourcey_bin: sourceyStub,
        },
        caller: createSourceyCaller({
          brandName: "Sourcey Fixture",
          homepageUrl: "https://sourcey.example.test",
          configPath: "docs/sourcey.config.ts",
        }),
        env: {
          ...process.env,
          RUNX_CWD: process.cwd(),
          SOURCEY_STUB_INVOCATION_PATH: invocationPath,
        },
        receiptDir: path.join(tempDir, "receipts"),
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("success");
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as { cwd: string; argv: string[] };
      expect(invocation.cwd).toBe(docsDir);
      expect(invocation.argv).toEqual(["build", "-o", outputDir, "--quiet"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);
});

function createSourceyCaller(overrides: { brandName: string; homepageUrl: string; configPath?: string }): Caller {
  return {
    resolve: async (request) => {
      if (request.kind === "approval") {
        return request.gate.id === "sourcey.discovery.approval" ? { actor: "human", payload: true } : undefined;
      }
      if (request.kind !== "cognitive_work") {
        return undefined;
      }
      if (request.work.envelope.skill === "sourcey.discover") {
        return {
          actor: "agent",
          payload: {
          discovery_report: {
            discovered: {
              brand_name: overrides.brandName,
              homepage_url: overrides.homepageUrl,
              docs_inputs: {
                mode: "config",
                config: overrides.configPath || "sourcey.config.ts",
              },
            },
            confidence: "high",
            rationale: ["existing Sourcey fixture already contains configuration and authored pages"],
          },
          },
        };
      }
      if (request.work.envelope.skill === "sourcey.author") {
        return {
          actor: "agent",
          payload: {
          doc_bundle: {
            files: [],
            summary: "Existing Sourcey fixture already contains the required docs source bundle.",
          },
          },
        };
      }
      if (request.work.envelope.skill === "sourcey.critique") {
        return {
          actor: "agent",
          payload: {
          evaluation_report: {
            verdict: "pass",
            grounding: "strong",
            clarity: "strong",
            navigation: "strong",
            obvious_gaps: [],
          },
          },
        };
      }
      if (request.work.envelope.skill === "sourcey.revise") {
        return {
          actor: "agent",
          payload: {
          revision_bundle: {
            files: [],
            summary: "No revision required for the existing Sourcey fixture.",
          },
          },
        };
      }
      throw new Error(`Unexpected agent step ${request.work.envelope.skill}`);
    },
    report: () => undefined,
  };
}

async function writeSourceyStub(stubPath: string, envCapturePath?: string): Promise<void> {
  const lines = [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'if (process.env.SOURCEY_STUB_INVOCATION_PATH) {',
    '  writeFileSync(process.env.SOURCEY_STUB_INVOCATION_PATH, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));',
    '}',
    'const outputFlag = process.argv.indexOf("-o");',
    'const outputDir = outputFlag === -1 ? "dist" : process.argv[outputFlag + 1];',
    'mkdirSync(outputDir, { recursive: true });',
    'writeFileSync(join(outputDir, "index.html"), "<!doctype html><title>Sourcey Fixture</title>");',
  ];

  if (envCapturePath) {
    lines.push(
      'const leaked = Object.keys(process.env).filter((key) => key === "RUNX_INPUTS_JSON" || key.startsWith("RUNX_INPUT_"));',
      'writeFileSync(process.env.SOURCEY_STUB_ENV_PATH, JSON.stringify(leaked));',
    );
  }

  lines.push("");
  await writeFile(stubPath, lines.join("\n"));
}

function createMemoryStream(): NodeJS.WriteStream & { contents: () => string } {
  let buffer = "";
  return {
    write: (chunk: string | Uint8Array) => {
      buffer += chunk.toString();
      return true;
    },
    contents: () => buffer,
  } as NodeJS.WriteStream & { contents: () => string };
}

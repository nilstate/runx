import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runLocalSkill, type Caller } from "../packages/runner-local/src/index.js";

describe("sourcey skill", () => {
  const sourceyBin = resolveSourceyBin();
  const itWithSourcey = sourceyBin ? it : it.skip;

  itWithSourcey("builds deterministic docs for an already-configured project through the mixed-runner skill", async () => {
    expect(sourceyBin).toBeDefined();

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-sourcey-skill-"));
    const receiptDir = path.join(tempDir, "receipts");
    const outputDir = path.join(tempDir, "docs");
    const project = "fixtures/sourcey/basic";
    const expectedProject = path.resolve(project);

    try {
      const caller: Caller = {
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
                  brand_name: "Sourcey Fixture",
                  homepage_url: "https://sourcey.example.test",
                  docs_inputs: {
                    mode: "config",
                    config: "sourcey.config.ts",
                  },
                },
                confidence: "high",
                rationale: ["fixture already includes a valid Sourcey config and docs content"],
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
                summary: "No authoring needed for the already-configured fixture.",
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
                summary: "No revision needed for the already-configured fixture.",
              },
              },
            };
          }
          throw new Error(`Unexpected agent step ${request.work.envelope.skill}`);
        },
        report: () => undefined,
      };

      const result = await runLocalSkill({
        skillPath: path.resolve("skills/sourcey"),
        inputs: {
          project,
          output_dir: outputDir,
          sourcey_bin: sourceyBin as string,
        },
        caller,
        env: { ...process.env, RUNX_CWD: process.cwd() },
        receiptDir,
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        throw new Error(result.status === "failure" ? result.execution.stderr || result.execution.errorMessage : result.status);
      }

      const output = JSON.parse(result.execution.stdout) as {
        schema: string;
        verified: boolean;
        output_dir: string;
        contains_doctype: boolean;
        discovery_report: { discovered: { brand_name: string; docs_inputs: { mode: string; config: string } } };
        verification_report: { verified: boolean };
      };
      expect(output).toMatchObject({
        schema: "runx.sourcey.packet.v1",
        verified: true,
        output_dir: outputDir,
        contains_doctype: true,
        discovery_report: {
          discovered: {
            brand_name: "Sourcey Fixture",
            docs_inputs: {
              mode: "config",
              config: "sourcey.config.ts",
            },
          },
        },
        verification_report: {
          verified: true,
        },
      });

      const generatedFiles = await collectFiles(outputDir);
      expect(generatedFiles.some((file) => file.endsWith("index.html"))).toBe(true);

      const generatedText = (
        await Promise.all(
          generatedFiles
            .filter((file) => /\.(html|txt|json)$/.test(file))
            .map((file) => readFile(file, "utf8")),
        )
      ).join("\n");
      expect(generatedText).toContain("fixture_status");

      const receiptFiles = await readdir(receiptDir);
      expect(receiptFiles).toContain("ledgers");
      expect(receiptFiles.filter((file) => file.endsWith(".json"))).toContain(`${result.receipt.id}.json`);
      const receiptText = await readFile(path.join(receiptDir, `${result.receipt.id}.json`), "utf8");
      expect(receiptText).not.toContain(expectedProject);
      expect(receiptText).not.toContain("fixture_status");
      expect(result.receipt.kind).toBe("graph_execution");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 90000);

  itWithSourcey("runs the default mixed-runner flow through author, critique, bounded revise, and deterministic rebuild", async () => {
    expect(sourceyBin).toBeDefined();

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-sourcey-mixed-"));
    const receiptDir = path.join(tempDir, "receipts");
    const projectDir = path.join(tempDir, "project");
    const outputDir = path.join(tempDir, "docs");
    const projectBrief = {
      project_identity: {
        name: "Sourcey Incomplete Fixture",
        summary: "Governed docs for a fixture that starts from minimal package metadata.",
      },
      brand_system: {
        primary_color: "#5a8a8a",
        visual_direction: "Crisp technical docs with a muted industrial palette.",
      },
      writing_directives: {
        must_cover: ["why it matters"],
        avoid: ["preview", "vendor-generated"],
      },
    };

    const caller: Caller = {
      resolve: async (request) => {
        if (request.kind === "approval") {
          return request.gate.id === "sourcey.discovery.approval" ? { actor: "human", payload: true } : undefined;
        }
        if (request.kind !== "cognitive_work") {
          return undefined;
        }
        if (request.work.envelope.skill === "sourcey.discover") {
          expect(request.work.envelope.allowed_tools).toEqual([
            "fs.read",
            "git.status",
            "git.current_branch",
            "git.diff_name_only",
            "cli.capture_help",
          ]);
          expect(request.work.envelope.inputs.project_brief).toMatchObject(projectBrief);
          return {
            actor: "agent",
            payload: {
            discovery_report: {
              discovered: {
                brand_name: "Sourcey Incomplete Fixture",
                homepage_url: "https://sourcey.example.test",
                docs_inputs: {
                  mode: "config",
                  config: "sourcey.config.ts",
                },
              },
              confidence: "high",
              rationale: ["package metadata exists", "project needs an authored Sourcey config and guide page"],
            },
            },
          };
        }
        if (request.work.envelope.skill === "sourcey.author") {
          expect(request.work.envelope.allowed_tools).toEqual(["fs.read", "cli.capture_help"]);
          return {
            actor: "agent",
            payload: {
            doc_bundle: {
              files: [
                {
                  path: "sourcey.config.ts",
                  contents: [
                    "export default {",
                    '  name: "Sourcey Incomplete Fixture",',
                    '  repo: "https://github.com/sourcey/sourcey-incomplete-fixture",',
                    "  navigation: {",
                    "    tabs: [",
                    "      {",
                    '        tab: "Docs",',
                    "        groups: [",
                    "          {",
                    '            group: "Start",',
                    '            pages: ["introduction"],',
                    "          },",
                    "        ],",
                    "      },",
                    "    ],",
                    "  },",
                    "};",
                    "",
                  ].join("\n"),
                },
                {
                  path: "introduction.md",
                  contents: [
                    "---",
                    "title: Introduction",
                    "description: Guided docs generated through runx and Sourcey",
                    "---",
                    "",
                    "# Sourcey Incomplete Fixture",
                    "",
                    "This site was authored from bounded project evidence through runx.",
                    "",
                    "## What you get",
                    "",
                    "- A governed Sourcey configuration",
                    "- A starter documentation page",
                    "- A deterministic build and verification path",
                    "",
                  ].join("\n"),
                },
              ],
              summary: "Created a minimal Sourcey config and introduction page for the incomplete fixture.",
            },
            },
          };
        }
        if (request.work.envelope.skill === "sourcey.critique") {
          expect(request.work.envelope.allowed_tools).toEqual(["fs.read"]);
          return {
            actor: "agent",
            payload: {
            evaluation_report: {
              verdict: "revise",
              grounding: "strong",
              clarity: "adequate",
              navigation: "good",
              obvious_gaps: ["The introduction page should explain the user-visible hook more clearly."],
            },
            },
          };
        }
        if (request.work.envelope.skill === "sourcey.revise") {
          expect(request.work.envelope.allowed_tools).toEqual(["fs.read"]);
          return {
            actor: "agent",
            payload: {
            revision_bundle: {
              files: [
                {
                  path: "introduction.md",
                  contents: [
                    "---",
                    "title: Introduction",
                    "description: Guided docs generated through runx and Sourcey",
                    "---",
                    "",
                    "# Sourcey Incomplete Fixture",
                    "",
                    "This site was authored from bounded project evidence through runx.",
                    "",
                    "## Why it matters",
                    "",
                    "runx gives Sourcey a governed lane: discover evidence, author docs, build deterministically, critique once, revise once, and verify the output.",
                    "",
                    "## What you get",
                    "",
                    "- A governed Sourcey configuration",
                    "- A starter documentation page",
                    "- A deterministic build and verification path",
                    "",
                  ].join("\n"),
                },
              ],
              summary: "Expanded the introduction with a stronger product hook and clearer value statement.",
            },
            },
          };
        }
        throw new Error(`Unexpected agent step ${request.work.envelope.skill}`);
      },
      report: () => undefined,
    };

    try {
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        path.join(projectDir, "package.json"),
        `${JSON.stringify(
          {
            name: "sourcey-incomplete-fixture",
            version: "0.0.0",
            private: true,
          },
          null,
          2,
        )}\n`,
      );

      const result = await runLocalSkill({
        skillPath: path.resolve("skills/sourcey"),
        inputs: {
          project: projectDir,
          project_brief: projectBrief,
          output_dir: outputDir,
          sourcey_bin: sourceyBin as string,
        },
        caller,
        env: { ...process.env, RUNX_CWD: process.cwd() },
        receiptDir,
        runxHome: path.join(tempDir, "home"),
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        throw new Error(result.status === "failure" ? result.execution.stderr || result.execution.errorMessage : result.status);
      }

      const output = JSON.parse(result.execution.stdout) as {
        schema: string;
        verified: boolean;
        output_dir: string;
        contains_doctype: boolean;
        project_brief: { writing_directives: { avoid: string[] } };
        revision_bundle: { files: Array<{ path: string }> };
      };
      expect(output).toMatchObject({
        schema: "runx.sourcey.packet.v1",
        verified: true,
        output_dir: outputDir,
        contains_doctype: true,
        project_brief: {
          writing_directives: {
            avoid: ["preview", "vendor-generated"],
          },
        },
        revision_bundle: {
          files: [expect.objectContaining({ path: "introduction.md" })],
        },
      });

      const generatedFiles = await collectFiles(outputDir);
      expect(generatedFiles.some((file) => file.endsWith("index.html"))).toBe(true);
      expect(await readFile(path.join(projectDir, "sourcey.config.ts"), "utf8")).toContain('name: "Sourcey Incomplete Fixture"');
      const introduction = await readFile(path.join(projectDir, "introduction.md"), "utf8");
      expect(introduction).toContain("## Why it matters");
      const generatedText = (
        await Promise.all(
          generatedFiles
            .filter((file) => /\.(html|txt|json)$/.test(file))
            .map((file) => readFile(file, "utf8")),
        )
      ).join("\n");
      expect(generatedText).toContain("Why it matters");
      expect(result.receipt.kind).toBe("graph_execution");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 90000);
});

function resolveSourceyBin(): string | undefined {
  const candidates = [
    process.env.SOURCEY_BIN,
    path.resolve(process.cwd(), "../../sourcey/dist/cli.js"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate));
}

async function collectFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      return entry.isDirectory() ? collectFiles(fullPath) : [fullPath];
    }),
  );
  return files.flat();
}

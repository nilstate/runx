import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runHarnessTarget } from "@runxhq/runtime-local/harness";
import { parseRunnerManifestYaml, validateRunnerManifest } from "@runxhq/core/parser";

describe("upstream bindings", () => {
  it("declares the nilstate icey-cli binding as verified and harnessed", async () => {
    const binding = JSON.parse(await readFile("bindings/nilstate/icey-server-operator/binding.json", "utf8")) as {
      schema: string;
      state: string;
      skill: { id: string; name: string };
      upstream: { repo: string; path: string; commit: string; blob_sha: string; source_of_truth: boolean };
      registry: { owner: string; trust_tier: string; version: string; materialized_package_is_registry_artifact: boolean };
      harness: { status: string; case_count: number };
    };
    const manifest = validateRunnerManifest(parseRunnerManifestYaml(await readFile("bindings/nilstate/icey-server-operator/X.yaml", "utf8")));

    expect(binding).toMatchObject({
      schema: "runx.registry_binding.v1",
      state: "harness_verified",
      skill: {
        id: "nilstate/icey-server-operator",
        name: "icey-server-operator",
      },
      upstream: {
        repo: "icey-cli",
        path: "SKILL.md",
        commit: "ee9aa1cc05055c2490537e762c81c9f28451f578",
        source_of_truth: true,
      },
      registry: {
        owner: "nilstate",
        trust_tier: "verified",
        version: "upstream-ee9aa1c",
        materialized_package_is_registry_artifact: true,
      },
      harness: {
        status: "harness_verified",
        case_count: 2,
      },
    });
    expect(binding.upstream.blob_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.skill).toBe("icey-server-operator");
    expect(Object.keys(manifest.runners)).toEqual(["operator-plan"]);
    expect(manifest.harness?.cases.map((entry) => entry.name)).toEqual([
      "operator-plan-classifies-surfaces",
      "release-plan-preserves-pins",
    ]);
  });

  it("runs the icey binding harness without copying upstream SKILL.md into source control", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-upstream-binding-harness-"));
    try {
      await writeFile(
        path.join(tempDir, "SKILL.md"),
        `---
name: icey-server-operator
description: Safely build, validate, package, release, and operate the icey-server CLI and media server surface.
---

# icey-server Operator Workflow

Fixture markdown used only to exercise the runx-owned binding harness.
`,
      );
      const profileDocument = await readFile("bindings/nilstate/icey-server-operator/X.yaml", "utf8");
      await mkdir(path.join(tempDir, ".runx"), { recursive: true });
      await writeFile(
        path.join(tempDir, ".runx/profile.json"),
        `${JSON.stringify(
          {
            schema_version: "runx.skill-profile.v1",
            skill: {
              name: "icey-server-operator",
              path: "SKILL.md",
              digest: "fixture-skill-digest",
            },
            profile: {
              document: profileDocument,
              digest: "fixture-profile-digest",
              runner_names: ["operator-plan"],
            },
            origin: {
              source: "fixture",
            },
          },
          null,
          2,
        )}\n`,
      );

      const result = await runHarnessTarget(tempDir);

      expect(result.source).toBe("inline");
      if (!("cases" in result)) {
        throw new Error("expected inline harness suite");
      }
      expect(result.status).toBe("success");
      expect(result.assertionErrors).toEqual([]);
      expect(result.cases).toHaveLength(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("materializes a binding from a pinned upstream skill blob", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "runx-upstream-binding-"));
    try {
      const skill = `---
name: temp-upstream
description: Temporary upstream skill.
---

# Temp Upstream

Portable upstream skill fixture.
`;
      const binding = {
        schema: "runx.registry_binding.v1",
        state: "harness_verified",
        skill: {
          id: "fixture/temp-upstream",
          name: "temp-upstream",
          description: "Temporary upstream skill.",
        },
        upstream: {
          host: "github.com",
          owner: "fixture",
          repo: "temp",
          path: "SKILL.md",
          commit: "abc123",
          blob_sha: gitBlobSha(skill),
          source_of_truth: true,
        },
        registry: {
          owner: "fixture",
          trust_tier: "verified",
          version: "upstream-abc123",
          profile_path: "X.yaml",
          materialized_package_is_registry_artifact: true,
        },
        harness: {
          status: "harness_verified",
          case_count: 1,
        },
      };
      const profileDocument = `skill: temp-upstream
runners:
  default:
    default: true
    type: agent-step
    agent: tester
    task: temp-upstream
    outputs:
      summary:
        type: string
harness:
  cases:
    - name: temp-smoke
      runner: default
      inputs: {}
      caller:
        answers:
          agent_step.temp-upstream.output:
            summary: ok
      expect:
        status: success
`;
      const bindingDir = path.join(tempDir, "binding");
      const outputDir = path.join(tempDir, "out");
      await mkdir(bindingDir);
      await writeFile(path.join(bindingDir, "binding.json"), `${JSON.stringify(binding, null, 2)}\n`);
      await writeFile(path.join(bindingDir, "X.yaml"), profileDocument);
      await writeFile(path.join(tempDir, "SKILL.md"), skill);

      execFileSync("node", [
        "scripts/materialize-upstream-skill-binding.mjs",
        path.join(bindingDir, "binding.json"),
        "--skill-file",
        path.join(tempDir, "SKILL.md"),
        "--output-dir",
        outputDir,
      ], { encoding: "utf8" });

      await expect(readFile(path.join(outputDir, "SKILL.md"), "utf8")).resolves.toBe(skill);
      const profileState = JSON.parse(await readFile(path.join(outputDir, ".runx/profile.json"), "utf8")) as {
        schema_version: string;
        profile: {
          document: string;
        };
      };
      expect(profileState.schema_version).toBe("runx.skill-profile.v1");
      expect(profileState.profile.document).toBe(profileDocument);
      await expect(readFile(path.join(outputDir, "materialization.json"), "utf8")).resolves.toContain(gitBlobSha(skill));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function gitBlobSha(contents: string): string {
  const body = Buffer.from(contents);
  return createHash("sha1")
    .update(Buffer.from(`blob ${body.length}\0`))
    .update(body)
    .digest("hex");
}

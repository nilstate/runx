import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseToolManifestJson, validateToolManifest } from "@runxhq/core/parser";
import { parse as parseYaml } from "yaml";

import { isPlainRecord } from "../../authoring-utils.js";
import type { DevCommandArgs, DevCommandDependencies } from "../dev.js";
import { resolveToolDirFromRef } from "../tool.js";
import { assertFixtureExpectation } from "./fixture-assertions.js";
import { resolveFixtureExecutionRoots, runProcess } from "./fixture-execution.js";
import { recordReplayFixture, validateReplayFixture } from "./fixture-replay.js";
import { runSkillFixture } from "./skill-fixture.js";
import {
  materializeFixtureEnv,
  materializeFixtureValue,
  prepareFixtureWorkspace,
} from "./fixture-workspace.js";
import {
  failedFixture,
  parseJsonMaybe,
  type DevFixtureResult,
} from "./internal.js";

export { runSkillFixture };

export async function runDevFixture(
  root: string,
  fixturePath: string,
  selectedLane: string,
  parsed: DevCommandArgs,
  env: NodeJS.ProcessEnv,
  deps: DevCommandDependencies,
): Promise<DevFixtureResult> {
  const startedAt = Date.now();
  const fixture = parseYaml(await readFile(fixturePath, "utf8")) as unknown;
  if (!isPlainRecord(fixture)) {
    return failedFixture(path.basename(fixturePath), "unknown", {}, startedAt, [{
      path: "",
      kind: "exact_mismatch",
      message: "Fixture must parse to an object.",
    }]);
  }
  const name = typeof fixture.name === "string" ? fixture.name : path.basename(fixturePath, path.extname(fixturePath));
  const lane = typeof fixture.lane === "string" ? fixture.lane : "deterministic";
  const target = isPlainRecord(fixture.target) ? fixture.target : {};
  if (selectedLane !== "all" && lane !== selectedLane) {
    return {
      name,
      lane,
      target,
      status: "skipped",
      duration_ms: Date.now() - startedAt,
      assertions: [],
      skip_reason: `lane ${lane} excluded by --lane ${selectedLane}`,
    };
  }
  if (lane === "agent") {
    return parsed.devRecord
      ? recordReplayFixture(root, fixturePath, fixture, name, lane, target, startedAt, parsed, env, deps)
      : validateReplayFixture(root, fixturePath, fixture, startedAt);
  }
  if (lane !== "deterministic" && lane !== "repo-integration") {
    return {
      name,
      lane,
      target,
      status: "skipped",
      duration_ms: Date.now() - startedAt,
      assertions: [],
      skip_reason: `${lane} fixtures are parsed but not executed in dev v1`,
    };
  }
  const kind = typeof target.kind === "string" ? target.kind : undefined;
  if (kind === "tool") {
    return runToolFixture(root, fixturePath, fixture, name, lane, target, startedAt, env);
  }
  if (kind === "skill" || kind === "graph") {
    return runSkillFixture(root, fixturePath, fixture, name, lane, target, startedAt, parsed.devRealAgents, env, deps);
  }
  return failedFixture(name, lane, target, startedAt, [{
    path: "target.kind",
    expected: "tool | skill | graph",
    actual: target.kind,
    kind: "exact_mismatch",
    message: "Fixture target.kind must be tool, skill, or graph.",
  }]);
}

export async function runToolFixture(
  root: string,
  fixturePath: string,
  fixture: Readonly<Record<string, unknown>>,
  name: string,
  lane: string,
  target: Readonly<Record<string, unknown>>,
  startedAt: number,
  env: NodeJS.ProcessEnv,
): Promise<DevFixtureResult> {
  const ref = typeof target.ref === "string" ? target.ref : "";
  const toolDir = resolveToolDirFromRef(root, ref);
  if (!toolDir) {
    return failedFixture(name, lane, target, startedAt, [{
      path: "target.ref",
      expected: "existing tool",
      actual: ref,
      kind: "exact_mismatch",
      message: `Tool ${ref} was not found.`,
    }]);
  }
  const manifest = validateToolManifest(parseToolManifestJson(await readFile(path.join(toolDir, "manifest.json"), "utf8")));
  const command = manifest.source.command ?? "node";
  const args = manifest.source.args ?? ["./run.mjs"];
  const workspace = await prepareFixtureWorkspace(root, fixturePath, fixture, env);
  try {
    const executionRoots = resolveFixtureExecutionRoots(root, lane, workspace.root);
    if (!executionRoots) {
      return failedFixture(name, lane, target, startedAt, [{
        path: "repo",
        expected: "repo or workspace fixture",
        actual: "missing",
        kind: "exact_mismatch",
        message: "repo-integration fixtures must declare repo or workspace contents.",
      }]);
    }
    const fixtureEnv = materializeFixtureEnv(fixture.env, workspace.tokens);
    const inputs = materializeFixtureValue(isPlainRecord(fixture.inputs) ? fixture.inputs : {}, workspace.tokens);
    const execution = await runProcess(command, args, {
      cwd: toolDir,
      env: {
        ...env,
        ...fixtureEnv,
        RUNX_INPUTS_JSON: JSON.stringify(inputs),
        RUNX_CWD: executionRoots.cwd,
        RUNX_REPO_ROOT: executionRoots.repoRoot,
        ...(workspace.root ? { RUNX_FIXTURE_ROOT: workspace.root } : {}),
      },
    });
    const output = parseJsonMaybe(execution.stdout);
    const assertions = await assertFixtureExpectation(root, fixture.expect, execution.exitCode, output);
    return {
      name,
      lane,
      target,
      status: assertions.length === 0 ? "success" : "failure",
      duration_ms: Date.now() - startedAt,
      assertions,
      output,
    };
  } finally {
    await workspace.cleanup();
  }
}


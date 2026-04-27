import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  isPlainRecord,
  sha256Stable,
  toProjectPath,
  writeJsonFile,
} from "../../authoring-utils.js";
import type { DevCommandArgs, DevCommandDependencies } from "../dev.js";
import { assertFixtureExpectation, selectNamedOutput } from "./fixture-assertions.js";
import { runSkillFixture } from "./skill-fixture.js";
import { failedFixture, type DevFixtureResult } from "./internal.js";

export async function recordReplayFixture(
  root: string,
  fixturePath: string,
  fixture: Readonly<Record<string, unknown>>,
  name: string,
  lane: string,
  target: Readonly<Record<string, unknown>>,
  startedAt: number,
  parsed: DevCommandArgs,
  env: NodeJS.ProcessEnv,
  deps: DevCommandDependencies,
): Promise<DevFixtureResult> {
  if (!parsed.devRealAgents && !isPlainRecord(fixture.caller)) {
    return failedFixture(name, lane, target, startedAt, [{
      path: "agent.mode",
      expected: "--real-agents or fixture.caller.answers",
      actual: "record",
      kind: "exact_mismatch",
      message: "Recording an agent fixture requires --real-agents or fixture caller answers.",
    }]);
  }
  const kind = typeof target.kind === "string" ? target.kind : undefined;
  const result = kind === "skill" || kind === "graph"
    ? await runSkillFixture(root, fixturePath, fixture, name, lane, target, startedAt, parsed.devRealAgents, env, deps)
    : failedFixture(name, lane, target, startedAt, [{
        path: "target.kind",
        expected: "skill | graph",
        actual: target.kind,
        kind: "exact_mismatch",
        message: "Agent replay recording requires a skill or graph target.",
      }]);
  const replayPath = fixturePath.replace(/\.ya?ml$/i, ".replay.json");
  const cassette = {
    schema: "runx.replay.v1",
    fixture: name,
    prompt_fingerprint: fixtureFingerprint(fixture),
    recorded_at: new Date().toISOString(),
    target,
    status: result.status,
    outputs: extractReplayOutputs(fixture, result.output),
    assertions: result.assertions,
    usage: {
      mode: parsed.devRealAgents ? "real" : "fixture_answers",
    },
  };
  await writeJsonFile(replayPath, cassette);
  return {
    ...result,
    replay_path: toProjectPath(root, replayPath),
  };
}

export async function validateReplayFixture(
  root: string,
  fixturePath: string,
  fixture: Readonly<Record<string, unknown>>,
  startedAt: number,
): Promise<DevFixtureResult> {
  const target = isPlainRecord(fixture.target) ? fixture.target : {};
  const name = typeof fixture.name === "string" ? fixture.name : path.basename(fixturePath, path.extname(fixturePath));
  const replayPath = fixturePath.replace(/\.ya?ml$/i, ".replay.json");
  if (!existsSync(replayPath)) {
    return failedFixture(name, "agent", target, startedAt, [{
      path: "agent.mode",
      expected: "replay cassette",
      actual: "missing",
      kind: "exact_mismatch",
      message: `Missing replay cassette ${toProjectPath(root, replayPath)}.`,
    }]);
  }
  const replay = JSON.parse(readFileSync(replayPath, "utf8")) as unknown;
  const fingerprint = fixtureFingerprint(fixture);
  if (isPlainRecord(replay) && replay.prompt_fingerprint && replay.prompt_fingerprint !== fingerprint) {
    return failedFixture(name, "agent", target, startedAt, [{
      path: "replay.prompt_fingerprint",
      expected: fingerprint,
      actual: replay.prompt_fingerprint,
      kind: "exact_mismatch",
      message: "Replay cassette is stale for this fixture.",
    }]);
  }
  if (!isPlainRecord(replay)) {
    return failedFixture(name, "agent", target, startedAt, [{
      path: "replay",
      expected: "object",
      actual: replay,
      kind: "type_mismatch",
      message: "Replay cassette must be a JSON object.",
    }]);
  }
  const replayStatus = replay.status === "failure" ? 1 : 0;
  const replayOutput = isPlainRecord(replay.outputs) ? replay.outputs : replay.output;
  const assertions = await assertFixtureExpectation(root, fixture.expect, replayStatus, replayOutput);
  return {
    name,
    lane: "agent",
    target,
    status: assertions.length === 0 ? "success" : "failure",
    duration_ms: Date.now() - startedAt,
    assertions,
    output: replayOutput,
    replay_path: toProjectPath(root, replayPath),
  };
}

export function fixtureFingerprint(fixture: Readonly<Record<string, unknown>>): string {
  return sha256Stable({
    target: fixture.target,
    inputs: fixture.inputs,
    agent: fixture.agent,
    expect: fixture.expect,
  });
}

export function extractReplayOutputs(fixture: Readonly<Record<string, unknown>>, output: unknown): unknown {
  const expectRecord = isPlainRecord(fixture.expect) ? fixture.expect : {};
  const outputsExpectation = isPlainRecord(expectRecord.outputs) ? expectRecord.outputs : undefined;
  if (!outputsExpectation || !isPlainRecord(output)) {
    return output;
  }
  return Object.fromEntries(
    Object.keys(outputsExpectation).map((name) => [name, selectNamedOutput(output, name)]),
  );
}

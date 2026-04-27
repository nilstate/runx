import { createDefaultSkillAdapters, resolveDefaultSkillAdapters } from "@runxhq/adapters";
import { resolveRunxHomeDir } from "@runxhq/core/config";
import { runLocalSkill } from "@runxhq/runtime-local";
import { resolveEnvToolCatalogAdapters } from "@runxhq/runtime-local/tool-catalogs";

import { isPlainRecord } from "../../authoring-utils.js";
import type { DevCommandDependencies } from "../dev.js";
import { resolveBundledCliVoiceProfilePath } from "../../runtime-assets.js";
import { assertFixtureExpectation } from "./fixture-assertions.js";
import { createFixtureCaller, resolveFixtureExecutionRoots } from "./fixture-execution.js";
import {
  materializeFixtureEnv,
  materializeFixtureValue,
  prepareFixtureWorkspace,
} from "./fixture-workspace.js";
import {
  failedFixture,
  parseJsonMaybe,
  resolveSkillDirFromRef,
  type DevFixtureResult,
} from "./internal.js";

export async function runSkillFixture(
  root: string,
  fixturePath: string,
  fixture: Readonly<Record<string, unknown>>,
  name: string,
  lane: string,
  target: Readonly<Record<string, unknown>>,
  startedAt: number,
  useRealAgents: boolean,
  env: NodeJS.ProcessEnv,
  deps: DevCommandDependencies,
): Promise<DevFixtureResult> {
  const ref = typeof target.ref === "string" ? target.ref : "";
  const skillPath = resolveSkillDirFromRef(root, ref);
  if (!skillPath) {
    return failedFixture(name, lane, target, startedAt, [{
      path: "target.ref",
      expected: "existing skill",
      actual: ref,
      kind: "exact_mismatch",
      message: `Skill or graph ${ref} was not found.`,
    }]);
  }
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
    const result = await runLocalSkill({
      skillPath,
      inputs: isPlainRecord(inputs) ? inputs : {},
      caller: createFixtureCaller(fixture, env, deps),
      env: {
        ...env,
        ...fixtureEnv,
        RUNX_CWD: executionRoots.cwd,
        RUNX_REPO_ROOT: executionRoots.repoRoot,
        ...(workspace.root ? { RUNX_FIXTURE_ROOT: workspace.root } : {}),
      },
      receiptDir: deps.resolveDefaultReceiptDir(env),
      runxHome: resolveRunxHomeDir(env),
      registryStore: await deps.resolveRegistryStoreForGraphs(env),
      adapters: useRealAgents
        ? await resolveDefaultSkillAdapters(env)
        : createDefaultSkillAdapters(),
      toolCatalogAdapters: resolveEnvToolCatalogAdapters(env),
      voiceProfilePath: await resolveBundledCliVoiceProfilePath(),
    });
    const success = result.status === "success";
    const output = success ? parseJsonMaybe(result.execution.stdout) : result;
    const assertions = await assertFixtureExpectation(root, fixture.expect, success ? 0 : 1, output);
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

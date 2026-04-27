import type {
  DevFixtureResultContract,
  DevReportContract,
} from "@runxhq/contracts";
import { resolvePathFromUserInput, resolveRunxHomeDir, resolveRunxWorkspaceBase } from "@runxhq/core/config";
import { writeLocalReceipt } from "@runxhq/core/receipts";
import { type RegistryStore } from "@runxhq/core/registry";
import { type Caller } from "@runxhq/runtime-local";

import type { CliAgentRuntime } from "../agent-runtime.js";
import { statusIcon, theme } from "../ui.js";
import { type DoctorCommandArgs, handleDoctorCommand } from "./doctor.js";
import { createDoctorDiagnostic, type DoctorReport } from "./doctor-types.js";
import { handleToolBuildCommand, type ToolBuildReport } from "./tool.js";
import { discoverFixturePaths } from "./dev/fixture-discovery.js";
import { runDevFixture } from "./dev/fixture-runner.js";

export type DevReport = DevReportContract;

export interface DevCommandArgs {
  readonly devPath?: string;
  readonly devLane?: string;
  readonly devRecord: boolean;
  readonly devRealAgents: boolean;
  readonly receiptDir?: string;
}

export interface DevCommandDependencies {
  readonly resolveRegistryStoreForGraphs: (env: NodeJS.ProcessEnv) => Promise<RegistryStore | undefined>;
  readonly resolveDefaultReceiptDir: (env: NodeJS.ProcessEnv) => string;
  readonly createNonInteractiveCaller: (
    answers?: Readonly<Record<string, unknown>>,
    approvals?: boolean | Readonly<Record<string, boolean>>,
    loadAgentRuntime?: () => Promise<CliAgentRuntime | undefined>,
  ) => Caller;
  readonly createAgentRuntimeLoader: (env: NodeJS.ProcessEnv) => () => Promise<CliAgentRuntime | undefined>;
}

export async function handleDevCommand(
  parsed: DevCommandArgs,
  env: NodeJS.ProcessEnv,
  deps: DevCommandDependencies,
): Promise<DevReport> {
  const root = resolveRunxWorkspaceBase(env);
  const unitPath = parsed.devPath ? resolvePathFromUserInput(parsed.devPath, env) : root;
  const build = await handleToolBuildCommand({ ...parsed, toolAction: "build", toolAll: true }, env);
  if (build.status === "failure") {
    return {
      schema: "runx.dev.v1",
      status: "failure",
      doctor: failedBuildDoctorReport(build),
      fixtures: [],
    };
  }
  const doctor = await handleDoctorCommand({ ...parsed, doctorPath: root, doctorFix: false } satisfies DoctorCommandArgs, env);
  if (doctor.status === "failure") {
    return { schema: "runx.dev.v1", status: "failure", doctor, fixtures: [] };
  }
  const fixturePaths = await discoverFixturePaths(unitPath, root);
  const selectedLane = parsed.devLane ?? "deterministic";
  const startedAt = Date.now();
  const fixtures: DevFixtureResultContract[] = [];
  for (const fixturePath of fixturePaths) {
    fixtures.push(await runDevFixture(root, fixturePath, selectedLane, parsed, env, deps));
  }
  const status = fixtures.some((fixture) => fixture.status === "failure")
    ? "failure"
    : fixtures.some((fixture) => fixture.status === "success")
      ? "success"
      : "skipped";
  const receipt = await writeLocalReceipt({
    receiptDir: parsed.receiptDir ? resolvePathFromUserInput(parsed.receiptDir, env) : deps.resolveDefaultReceiptDir(env),
    runxHome: resolveRunxHomeDir(env),
    skillName: "runx.dev",
    sourceType: "dev",
    inputs: { path: parsed.devPath, lane: selectedLane },
    stdout: JSON.stringify({ fixtures: fixtures.map((fixture) => ({ name: fixture.name, status: fixture.status })) }),
    stderr: "",
    execution: {
      status: status === "failure" ? "failure" : "success",
      exitCode: status === "failure" ? 1 : 0,
      signal: null,
      durationMs: Date.now() - startedAt,
      metadata: {
        dev: {
          fixture_count: fixtures.length,
          selected_lane: selectedLane,
        },
      },
    },
  });
  return {
    schema: "runx.dev.v1",
    status,
    doctor,
    fixtures,
    receipt_id: receipt.id,
  };
}

export function renderDevResult(result: DevReport, env: NodeJS.ProcessEnv = process.env): string {
  const t = theme(process.stdout, env);
  const lines = [
    "",
    `  ${statusIcon(result.status, t)}  ${t.bold}dev${t.reset}  ${t.dim}${result.fixtures.length} fixture(s)${t.reset}`,
  ];
  for (const fixture of result.fixtures) {
    lines.push(`  ${statusIcon(fixture.status, t)}  ${fixture.lane.padEnd(14)} ${fixture.name}  ${t.dim}${fixture.duration_ms}ms${t.reset}`);
    for (const assertion of fixture.assertions.slice(0, 3)) {
      lines.push(`     ${assertion.path}: ${assertion.message}`);
    }
  }
  if (result.receipt_id) {
    lines.push(`  ${t.dim}receipt${t.reset}  ${result.receipt_id}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function failedBuildDoctorReport(build: ToolBuildReport): DoctorReport {
  return {
    schema: "runx.doctor.v1",
    status: "failure",
    summary: { errors: build.errors.length, warnings: 0, infos: 0 },
    diagnostics: build.errors.map((error, index) => createDoctorDiagnostic({
      id: "runx.tool.manifest.build_failed",
      severity: "error",
      title: "Tool build failed",
      message: error,
      target: { kind: "tool" },
      location: { path: "." },
      evidence: { index },
      repairs: [{
        id: "repair_tool_build",
        kind: "manual",
        confidence: "medium",
        risk: "low",
        requires_human_review: false,
      }],
    })),
  };
}

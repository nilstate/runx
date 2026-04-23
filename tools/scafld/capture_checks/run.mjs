import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  defineTool,
  firstNonEmptyString,
  stringInput,
} from "../../_lib/harness.mjs";

const tool = defineTool({
  name: "scafld.capture_checks",
  inputs: {
    task_id: stringInput({ optional: true }),
    taskId: stringInput({ optional: true }),
    fixture: stringInput({ optional: true }),
    cwd: stringInput({ optional: true }),
    scafld_bin: stringInput({ optional: true }),
  },
  run: runCaptureChecks,
});

await tool.main();

function runCaptureChecks({ inputs, env }) {
  const scafld = firstNonEmptyString(
    inputs.scafld_bin,
    env.SCAFLD_BIN,
    "scafld",
  );
  const cwd = path.resolve(
    firstNonEmptyString(
      inputs.fixture,
      inputs.cwd,
      env.RUNX_CWD,
      process.cwd(),
    ),
  );
  const taskId = firstNonEmptyString(inputs.task_id, inputs.taskId);

  if (!taskId) {
    throw new Error("task_id is required.");
  }

  const cleanEnv = { ...env };
  delete cleanEnv.RUNX_INPUTS_JSON;
  for (const key of Object.keys(cleanEnv)) {
    if (key.startsWith("RUNX_INPUT_")) {
      delete cleanEnv[key];
    }
  }
  if (path.isAbsolute(scafld) || scafld.includes(path.sep)) {
    cleanEnv.PATH = `${path.dirname(scafld)}${path.delimiter}${cleanEnv.PATH || "/usr/local/bin:/usr/bin:/bin"}`;
  }

  const result = spawnSync(scafld, ["checks", taskId, "--json"], {
    cwd,
    env: cleanEnv,
    encoding: "utf8",
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const payload = parseJsonPayload(stdout);

  const output = {
    ...payload,
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    native_exit_code: result.status ?? 1,
  };
  if (stderr) {
    output.native_stderr = stderr;
  }

  return output;
}

function parseJsonPayload(rawStdout) {
  const trimmed = rawStdout.trim();
  if (!trimmed) {
    throw new Error("scafld checks produced no JSON output");
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("scafld checks JSON payload must be an object");
    }
    return parsed;
  } catch (error) {
    const preview =
      trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `scafld checks did not emit a usable JSON payload. ${message}. Output preview: ${preview}`,
    );
  }
}

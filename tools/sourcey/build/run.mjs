import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const inputs = JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");

function requiredString(name) {
  const value = inputs[name];
  if (value === undefined || value === null || value === "") {
    throw new Error(`${name} is required.`);
  }
  return String(value);
}

function parseDocsInputs(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return { mode: "config", description: value };
    }
  }
  return { mode: "config" };
}

function sourceyEnv() {
  const env = { ...process.env };
  delete env.RUNX_INPUTS_JSON;
  for (const key of Object.keys(env)) {
    if (key.startsWith("RUNX_INPUT_")) {
      delete env[key];
    }
  }
  return env;
}

const inputBase = process.env.RUNX_CWD || process.env.INIT_CWD || process.cwd();
const project = path.resolve(inputBase, requiredString("project"));
const homepageUrl = requiredString("homepage_url");
const brandName = requiredString("brand_name");
const docsInputs = parseDocsInputs(inputs.docs_inputs);
const sourcey = String(inputs.sourcey_bin || process.env.SOURCEY_BIN || "sourcey");
const outputDir = path.resolve(project, String(inputs.output_dir || ".sourcey/runx-docs"));
const command = /\.(mjs|cjs|js)$/.test(sourcey) ? process.execPath : sourcey;
const sourceyArgs = /\.(mjs|cjs|js)$/.test(sourcey) ? [sourcey] : [];
const mode = String(docsInputs.mode || "config");
let buildCwd = project;

sourceyArgs.push("build");
if (mode === "openapi") {
  const spec = docsInputs.spec || docsInputs.openapi;
  if (!spec) {
    throw new Error("docs_inputs.spec or docs_inputs.openapi is required when docs_inputs.mode is 'openapi'.");
  }
  sourceyArgs.push(path.resolve(project, String(spec)));
} else if (mode === "config") {
  const configPath = path.resolve(project, String(docsInputs.config || "sourcey.config.ts"));
  if (!existsSync(configPath)) {
    throw new Error(`Sourcey config not found: ${configPath}`);
  }
  buildCwd = path.dirname(configPath);
  const configFile = path.basename(configPath);
  if (configFile !== "sourcey.config.ts") {
    sourceyArgs.push("--config", configFile);
  }
} else {
  throw new Error(`Unsupported docs_inputs.mode: ${mode}`);
}
sourceyArgs.push("-o", outputDir, "--quiet");

function failureReport(extra = {}) {
  return {
    project,
    brand_name: brandName,
    homepage_url: homepageUrl,
    docs_inputs: docsInputs,
    output_dir: outputDir,
    command: "sourcey build",
    sourcey_bin: sourcey,
    sourcey_args: sourceyArgs,
    cwd: buildCwd,
    generated: false,
    index_path: path.join(outputDir, "index.html"),
    ...extra,
  };
}

const result = spawnSync(command, sourceyArgs, {
  cwd: buildCwd,
  env: sourceyEnv(),
  encoding: "utf8",
  shell: false,
});

if (result.error) {
  process.stdout.write(
    JSON.stringify(
      failureReport({
        error: result.error.message,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      }),
    ),
  );
  if (result.error.message) {
    process.stderr.write(`${result.error.message}\n`);
  }
  process.exit(1);
}
if (result.status !== 0) {
  process.stdout.write(
    JSON.stringify(
      failureReport({
        exit_code: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      }),
    ),
  );
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const indexPath = path.join(outputDir, "index.html");
process.stdout.write(
  JSON.stringify({
    project,
    brand_name: brandName,
    homepage_url: homepageUrl,
    docs_inputs: docsInputs,
    output_dir: outputDir,
    command: "sourcey build",
    cwd: buildCwd,
    generated: existsSync(indexPath),
    index_path: indexPath,
  }),
);

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

function collectGeneratedFiles(rootDir, currentDir = rootDir, files = [], maxFiles = 64) {
  if (!existsSync(currentDir) || files.length >= maxFiles) {
    return files;
  }

  const entries = readdirSync(currentDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (files.length >= maxFiles) {
      break;
    }

    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      collectGeneratedFiles(rootDir, absolutePath, files, maxFiles);
      continue;
    }

    if (entry.isFile()) {
      files.push(path.relative(rootDir, absolutePath));
    }
  }

  return files;
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripHtml(html) {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function extractTagText(html, tagName) {
  const match = html.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  if (!match) {
    return undefined;
  }
  const text = stripHtml(match[1]);
  return text || undefined;
}

function extractHeadingTexts(html, maxHeadings = 4) {
  const headings = [];
  const matcher = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi;
  let match = matcher.exec(html);
  while (match && headings.length < maxHeadings) {
    const text = stripHtml(match[1]);
    if (text) {
      headings.push(text);
    }
    match = matcher.exec(html);
  }
  return headings;
}

function buildIndexEvidence(indexPath) {
  if (!existsSync(indexPath)) {
    return {};
  }

  const stats = statSync(indexPath);
  if (!stats.isFile()) {
    return {};
  }

  const html = readFileSync(indexPath, "utf8");
  const excerpt = stripHtml(html).slice(0, 1200);
  return {
    index_title: extractTagText(html, "title") ?? null,
    index_headings: extractHeadingTexts(html),
    index_excerpt: excerpt || null,
  };
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
    generated_files: [],
    index_title: null,
    index_headings: [],
    index_excerpt: null,
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
const generated = existsSync(indexPath);
process.stdout.write(
  JSON.stringify({
    project,
    brand_name: brandName,
    homepage_url: homepageUrl,
    docs_inputs: docsInputs,
    output_dir: outputDir,
    command: "sourcey build",
    cwd: buildCwd,
    generated,
    index_path: indexPath,
    generated_files: collectGeneratedFiles(outputDir),
    ...buildIndexEvidence(indexPath),
  }),
);

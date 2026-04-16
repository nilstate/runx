import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const options = parseArgs(process.argv.slice(2));
const profilePath = path.resolve(options.profilePath);
const profileDir = path.dirname(profilePath);
const binding = JSON.parse(await readFile(profilePath, "utf8"));
const profileDocumentPath = path.resolve(profileDir, options.profileDocumentPath ?? path.basename(binding.registry?.profile_path ?? "X.yaml"));
const outputDir = path.resolve(options.outputDir ?? path.join("dist/upstream-bindings", binding.skill?.id ?? "upstream-skill"));
const markdown = options.skillFile
  ? await readFile(path.resolve(options.skillFile), "utf8")
  : await fetchUpstreamSkill(binding);
const profileDocument = await readFile(profileDocumentPath, "utf8");
const skillFrontmatter = parseSkillFrontmatter(markdown);
const observedBlobSha = gitBlobSha(markdown);
const markdownDigest = sha256(markdown);
const profileDigest = sha256(profileDocument);
const runnerNames = extractRunnerNames(profileDocument);

validateBinding(binding, skillFrontmatter, observedBlobSha, profileDocumentPath);

await mkdir(outputDir, { recursive: true });
await mkdir(path.join(outputDir, ".runx"), { recursive: true });
await writeFile(path.join(outputDir, "SKILL.md"), markdown);
await writeFile(path.join(outputDir, ".runx/profile.json"), `${JSON.stringify({
  schema_version: "runx.skill-profile.v1",
  skill: {
    name: binding.skill.name,
    path: "SKILL.md",
    digest: markdownDigest,
  },
  profile: {
    document: profileDocument,
    digest: profileDigest,
    runner_names: runnerNames,
  },
  origin: {
    source: "runx-registry",
    source_label: "runx registry",
    ref: binding.skill.id,
    skill_id: binding.skill.id,
    version: binding.registry.version,
    digest: markdownDigest,
    profile_digest: profileDigest,
    runner_names: runnerNames,
    trust_tier: binding.registry.trust_tier,
  },
}, null, 2)}\n`);
await writeFile(path.join(outputDir, "registry-binding.json"), `${JSON.stringify(binding, null, 2)}\n`);
await writeFile(path.join(outputDir, "materialization.json"), `${JSON.stringify({
  schema: "runx.registry_binding_materialization.v1",
  materialized_at: new Date().toISOString(),
  profile_path: path.relative(process.cwd(), profilePath),
  output_dir: path.relative(process.cwd(), outputDir),
  skill: binding.skill,
  upstream: binding.upstream,
  registry: binding.registry,
  digests: {
    markdown_sha256: markdownDigest,
    profile_sha256: profileDigest,
    upstream_blob_sha: observedBlobSha,
  },
}, null, 2)}\n`);

let publish;
if (options.registryDir) {
  publish = publishMaterializedPackage({
    outputDir,
    owner: binding.registry.owner,
    version: binding.registry.version,
    registryDir: path.resolve(options.registryDir),
  });
  await writeFile(path.join(outputDir, "publish.json"), `${publish}\n`);
}

process.stdout.write(`${JSON.stringify({
  status: "materialized",
  skill_id: binding.skill.id,
  output_dir: path.relative(process.cwd(), outputDir),
  upstream_commit: binding.upstream.commit,
  upstream_blob_sha: observedBlobSha,
  markdown_sha256: markdownDigest,
  profile_sha256: profileDigest,
  publish: publish ? JSON.parse(publish).publish : undefined,
}, null, 2)}\n`);

async function fetchUpstreamSkill(binding) {
  if (typeof binding.upstream?.raw_url === "string" && binding.upstream.raw_url.length > 0) {
    const response = await fetch(binding.upstream.raw_url);
    if (!response.ok) {
      throw new Error(`Failed to fetch upstream SKILL.md from ${binding.upstream.raw_url}: ${response.status}`);
    }
    return await response.text();
  }

  if (binding.upstream?.host !== "github.com") {
    throw new Error("Only github.com upstream bindings are fetchable without raw_url.");
  }
  const content = JSON.parse(execFileSync("gh", [
    "api",
    `repos/${binding.upstream.owner}/${binding.upstream.repo}/contents/${encodePath(binding.upstream.path)}?ref=${encodeURIComponent(binding.upstream.commit)}`,
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }));
  if (typeof content.content !== "string") {
    throw new Error("GitHub contents API did not return base64 content.");
  }
  return Buffer.from(content.content.replace(/\n/g, ""), "base64").toString("utf8");
}

function validateBinding(binding, skillFrontmatter, observedBlobSha, profileDocumentPath) {
  if (binding.schema !== "runx.registry_binding.v1") {
    throw new Error("registry binding schema must be runx.registry_binding.v1");
  }
  if (!binding.skill?.id || !binding.skill?.name) {
    throw new Error("registry binding skill.id and skill.name are required");
  }
  if (skillFrontmatter.name !== binding.skill.name) {
    throw new Error(`upstream SKILL.md name '${skillFrontmatter.name}' does not match binding skill '${binding.skill.name}'`);
  }
  if (binding.upstream?.source_of_truth !== true) {
    throw new Error("registry binding must mark upstream.source_of_truth=true");
  }
  if (binding.upstream?.blob_sha && observedBlobSha !== binding.upstream.blob_sha) {
    throw new Error(`upstream SKILL.md blob mismatch: expected ${binding.upstream.blob_sha}, observed ${observedBlobSha}`);
  }
  if (!binding.registry?.owner || !binding.registry?.version) {
    throw new Error("registry.owner and registry.version are required");
  }
  if (binding.registry?.materialized_package_is_registry_artifact !== true) {
    throw new Error("binding must mark materialized_package_is_registry_artifact=true");
  }
  if (path.basename(profileDocumentPath) !== "X.yaml") {
    throw new Error("registry profile artifact must be named X.yaml");
  }
}

function publishMaterializedPackage({ outputDir, owner, version, registryDir }) {
  return execFileSync("pnpm", [
    "exec",
    "tsx",
    "packages/cli/src/index.ts",
    "skill",
    "publish",
    outputDir,
    "--owner",
    owner,
    "--version",
    version,
    "--registry",
    registryDir,
    "--json",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      RUNX_CWD: process.cwd(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parseSkillFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    throw new Error("Upstream SKILL.md must start with YAML frontmatter.");
  }
  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) {
      continue;
    }
    frontmatter[field[1]] = field[2].replace(/^['"]|['"]$/g, "").trim();
  }
  if (!frontmatter.name) {
    throw new Error("Upstream SKILL.md frontmatter is missing name.");
  }
  return frontmatter;
}

function gitBlobSha(contents) {
  const body = Buffer.from(contents);
  return createHash("sha1")
    .update(Buffer.from(`blob ${body.length}\0`))
    .update(body)
    .digest("hex");
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function encodePath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function extractRunnerNames(profileDocument) {
  const names = [];
  let inRunners = false;

  for (const line of profileDocument.split(/\r?\n/)) {
    if (!inRunners) {
      if (/^runners:\s*$/.test(line)) {
        inRunners = true;
      }
      continue;
    }

    if (!line.startsWith("  ")) {
      break;
    }

    const match = line.match(/^  ([A-Za-z0-9_.-]+):\s*$/);
    if (match?.[1]) {
      names.push(match[1]);
    }
  }

  return names;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!parsed.profilePath && !token.startsWith("--")) {
      parsed.profilePath = token;
      continue;
    }
    if (token === "--output-dir") {
      parsed.outputDir = requireValue(argv, ++index, token);
      continue;
    }
    if (token === "--skill-file") {
      parsed.skillFile = requireValue(argv, ++index, token);
      continue;
    }
    if (token === "--profiled") {
      parsed.profileDocumentPath = requireValue(argv, ++index, token);
      continue;
    }
    if (token === "--registry-dir") {
      parsed.registryDir = requireValue(argv, ++index, token);
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!parsed.profilePath) {
    throw new Error("Usage: node scripts/materialize-upstream-skill-binding.mjs <registry-binding.json> [--output-dir dist/path] [--skill-file SKILL.md] [--registry-dir .tmp/registry]");
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

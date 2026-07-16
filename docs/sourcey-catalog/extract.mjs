import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const EXPECTED_PAGE_COUNT = 24;
const MAX_CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_RATE_LIMIT_WAIT_MS = 30 * 1000;
const MAINTAINED_PAGE_FILES = new Set(["introduction.md"]);
const SOURCE_COMMIT = "5afc25a83edf1c1320df7ac0d78c36f1523b5677";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SOURCE_REPOSITORY = "https://github.com/runxhq/runx";
const CANONICAL_GROUPS = [
  { name: "Operate", names: ["agency", "business-ops", "operator-inbox", "ops-desk", "work-plan"] },
  { name: "Research and data", names: ["deep-research", "research", "data-store", "knowledge-router", "web-fetch"] },
  { name: "GitHub and delivery", names: ["github-sync", "issue-intake", "issue-triage", "issue-to-pr", "release"] },
  { name: "Safety and review", names: ["audit-receipt", "cve-audit", "least-privilege", "policy-author", "review-receipt", "sandbox-harden"] },
  { name: "Outbound and tooling", names: ["governed-outbound", "run-history", "sourcey"] }
];

export async function extractCatalog({ catalogPath, outputDir, fetchImpl = globalThis.fetch, concurrency = MAX_CONCURRENCY }) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const { sourceRepository, sourceCommit, pages } = validateCatalog(catalog);
  const authentication = githubAuthentication();
  const limit = normalizeConcurrency(concurrency);
  const extractedPages = await mapWithConcurrency(pages, limit, async (page) => {
    const sourceUrl = `${sourceRepository}/blob/${sourceCommit}/${page.path}`;
    const contentUrl = toContentsUrl(sourceRepository, page.path, sourceCommit);
    const source = await fetchContents(contentUrl, fetchImpl, authentication);
    const content = decodeSource(source, page.path);
    const blobSha = gitBlobSha(content);

    if (blobSha !== source.sha) {
      throw new Error(`blob SHA mismatch for ${page.path}`);
    }

    const body = renderPage({ ...page, sourceUrl, sourceCommit, sourceRepository, content });
    const outputPath = path.join(outputDir, `${page.slug}.md`);
    return {
      ...page,
      source_url: sourceUrl,
      output_path: outputPath,
      blob_sha: blobSha,
      content_digest: `sha256:${sha256(body)}`,
      body
    };
  });

  await writePages(outputDir, extractedPages);
  return { source_commit: sourceCommit, pages: extractedPages };
}

function validateCatalog(catalog) {
  if (!catalog || typeof catalog !== "object") throw new TypeError("catalog must be an object");
  if (catalog.source_repository !== SOURCE_REPOSITORY) {
    throw new Error(`source_repository must be ${SOURCE_REPOSITORY}`);
  }
  if (!COMMIT_PATTERN.test(catalog.source_commit ?? "") || catalog.source_commit !== SOURCE_COMMIT) {
    throw new Error(`source_commit must equal the pinned source commit ${SOURCE_COMMIT}`);
  }
  if (!Array.isArray(catalog.groups)) throw new TypeError("groups must be an array");

  const pages = [];
  for (const group of catalog.groups) {
    if (!group || typeof group !== "object" || typeof group.name !== "string" || !Array.isArray(group.entries)) {
      throw new Error("groups must have a name and entries array");
    }
    for (const entry of group.entries) {
      if (!entry || typeof entry !== "object") throw new TypeError("catalog entry must be an object");
      if (!isSlug(entry.name) || !isSlug(entry.slug)) throw new Error("entry names and slugs must be lowercase kebab-case");
      if (entry.path !== `skills/${entry.name}/SKILL.md`) {
        throw new Error(`invalid source path for ${entry.name}`);
      }
      pages.push({ name: entry.name, slug: entry.slug, group: entry.group, path: entry.path });
    }
  }

  if (pages.length !== EXPECTED_PAGE_COUNT) {
    throw new Error(`catalog must contain exactly ${EXPECTED_PAGE_COUNT} pages`);
  }
  ensureUnique(pages, "name");
  ensureUnique(pages, "slug");
  validateCanonicalGroups(catalog.groups);
  return { sourceRepository: catalog.source_repository, sourceCommit: catalog.source_commit, pages };
}

function validateCanonicalGroups(groups) {
  if (groups.length !== CANONICAL_GROUPS.length) {
    throw new Error("catalog must use the exact canonical groups and memberships");
  }

  for (const [groupIndex, expectedGroup] of CANONICAL_GROUPS.entries()) {
    const group = groups[groupIndex];
    if (group.name !== expectedGroup.name || group.entries.length !== expectedGroup.names.length) {
      throw new Error("catalog must use the exact canonical groups and memberships");
    }
    for (const [entryIndex, expectedName] of expectedGroup.names.entries()) {
      const entry = group.entries[entryIndex];
      if (entry.name !== expectedName) {
        throw new Error(`catalog entry must use canonical name ${expectedName}`);
      }
      if (entry.group !== expectedGroup.name) {
        throw new Error("catalog must use the exact canonical groups and memberships");
      }
      if (entry.slug !== entry.name) throw new Error(`slug must equal name for ${entry.name}`);
    }
  }
}

function ensureUnique(pages, key) {
  const values = new Set();
  for (const page of pages) {
    if (values.has(page[key])) throw new Error(`duplicate ${key}: ${page[key]}`);
    values.add(page[key]);
  }
}

function isSlug(value) {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function normalizeConcurrency(concurrency) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }
  return Math.min(concurrency, MAX_CONCURRENCY);
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function toContentsUrl(sourceRepository, sourcePath, sourceCommit) {
  const repositoryPath = new URL(sourceRepository).pathname.slice(1);
  const encodedPath = sourcePath.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${repositoryPath}/contents/${encodedPath}?ref=${sourceCommit}`;
}

async function fetchContents(url, fetchImpl, authentication) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: "application/vnd.github+json",
          ...(authentication.token ? { Authorization: `Bearer ${authentication.token}` } : {})
        }
      });
    } catch (error) {
      lastError = new Error(redactError(error, authentication.secrets));
      continue;
    }

    if (response.ok) {
      try {
        return await response.json();
      } catch (error) {
        throw new Error(redactError(error, authentication.secrets));
      }
    }
    if (isRateLimited(response)) {
      const resetSeconds = Number.parseInt(response.headers.get("x-ratelimit-reset") ?? "", 10);
      const waitMs = Number.isSafeInteger(resetSeconds) ? Math.max(0, resetSeconds * 1000 - Date.now()) : Infinity;
      const message = rateLimitMessage(resetSeconds, waitMs);
      if (waitMs > MAX_RATE_LIMIT_WAIT_MS) throw new Error(message);
      lastError = new Error(message);
      if (attempt < MAX_ATTEMPTS) await delay(waitMs);
      continue;
    }
    const secondaryLimit = await secondaryRateLimit(response, authentication.secrets);
    if (secondaryLimit) {
      const message = secondaryRateLimitMessage(secondaryLimit.waitMs);
      if (secondaryLimit.waitMs > MAX_RATE_LIMIT_WAIT_MS) throw new Error(message);
      lastError = new Error(message);
      if (attempt < MAX_ATTEMPTS) await delay(secondaryLimit.waitMs);
      continue;
    }
    if (!isTransientStatus(response.status)) {
      throw new Error(`GitHub Contents API returned status ${response.status}`);
    }
    lastError = new Error(`GitHub Contents API returned transient status ${response.status}`);
  }
  throw new Error(`GitHub Contents API failed after ${MAX_ATTEMPTS} attempts: ${lastError.message}`);
}

function githubAuthentication() {
  const secrets = [process.env.GITHUB_TOKEN, process.env.GH_TOKEN].filter(Boolean);
  return { token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN, secrets };
}

function redactError(error, secrets) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) message = message.replaceAll(secret, "[REDACTED]");
  return message;
}

function isRateLimited(response) {
  return response.status === 403 && response.headers?.get?.("x-ratelimit-remaining") === "0";
}

function rateLimitMessage(resetSeconds, waitMs) {
  const reset = Number.isSafeInteger(resetSeconds)
    ? new Date(resetSeconds * 1000).toISOString()
    : "an unavailable reset time";
  const waitGuidance = waitMs > MAX_RATE_LIMIT_WAIT_MS
    ? "The extractor cannot wait more than 30 seconds. "
    : "";
  return `GitHub API rate limit exhausted; reset at ${reset}. ${waitGuidance}Rerun after reset or set GITHUB_TOKEN or GH_TOKEN.`;
}

async function secondaryRateLimit(response, secrets) {
  if (response.status !== 403) return undefined;
  const retryAfter = response.headers?.get?.("retry-after");
  const waitMs = parseRetryAfter(retryAfter);
  let responseMessage = "";
  if (typeof response.json === "function") {
    try {
      const body = await response.json();
      responseMessage = redactError(body?.message ?? "", secrets);
    } catch {
      responseMessage = "";
    }
  }
  if (waitMs === undefined && !/secondary rate limit|abuse detection/i.test(responseMessage)) return undefined;
  return { waitMs: waitMs ?? Infinity };
}

function parseRetryAfter(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function secondaryRateLimitMessage(waitMs) {
  const retryGuidance = Number.isFinite(waitMs)
    ? `retry after ${Math.ceil(waitMs / 1000)} seconds. `
    : "retry later; wait time is unavailable. ";
  const waitGuidance = waitMs > MAX_RATE_LIMIT_WAIT_MS
    ? "The extractor cannot wait more than 30 seconds. "
    : "";
  return `GitHub API secondary rate limit triggered; ${retryGuidance}${waitGuidance}Rerun after waiting or set GITHUB_TOKEN or GH_TOKEN.`;
}

function isTransientStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function decodeSource(source, sourcePath) {
  if (!source || source.type !== "file") throw new Error(`Contents API did not return a file for ${sourcePath}`);
  if (source.encoding !== "base64" || typeof source.content !== "string") {
    throw new Error(`Contents API did not return base64 content for ${sourcePath}`);
  }
  if (!SHA_PATTERN.test(source.sha ?? "")) throw new Error(`invalid blob SHA for ${sourcePath}`);

  const compactBase64 = source.content.replace(/\r?\n/g, "");
  if (!BASE64_PATTERN.test(compactBase64)) throw new Error(`invalid base64 content for ${sourcePath}`);

  const content = Buffer.from(compactBase64, "base64");
  if (content.toString("base64") !== compactBase64) {
    throw new Error(`source is not canonical base64 for ${sourcePath}`);
  }
  if (content.length > MAX_CONTENT_BYTES) throw new Error(`source exceeds 1 MiB for ${sourcePath}`);
  if (!Buffer.from(content.toString("utf8"), "utf8").equals(content)) {
    throw new Error(`source is not valid UTF-8 for ${sourcePath}`);
  }
  return content;
}

function gitBlobSha(content) {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

function renderPage({ name, group, path: sourcePath, sourceUrl, sourceCommit, sourceRepository, content }) {
  const authoredContent = rewriteSourceRelativeLinks(
    stripYamlFrontmatter(content.toString("utf8"), name).replace(/\r\n?/g, "\n"),
    sourcePath,
    sourceRepository,
    sourceCommit,
  );
  const header = [
    `# ${name}`,
    "",
    `- Group: ${group}`,
    `- Source: [${sourcePath}](${sourceUrl})`,
    `- Commit: \`${sourceCommit}\``,
    `- Path: \`${sourcePath}\``,
    ""
  ].join("\n");
  return `${header}${authoredContent}`.replace(/\n*$/, "\n");
}

function rewriteSourceRelativeLinks(markdown, sourcePath, sourceRepository, sourceCommit) {
  const lines = markdown.split("\n");
  let fence;
  return lines.map((line) => {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (fenceMatch
        && fenceMatch[1][0] === fence.marker
        && fenceMatch[1].length >= fence.length
        && fenceMatch[2].trim() === "") {
        fence = undefined;
      }
      return line;
    }
    if (fenceMatch && (fenceMatch[1][0] === "~" || !fenceMatch[2].includes("`"))) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      return line;
    }
    return rewriteMarkdownLine(line, sourcePath, sourceRepository, sourceCommit);
  }).join("\n");
}

function rewriteMarkdownLine(line, sourcePath, sourceRepository, sourceCommit) {
  let output = "";
  let cursor = 0;
  while (cursor < line.length) {
    const opening = line.indexOf("](", cursor);
    if (opening === -1) return output + line.slice(cursor);
    output += line.slice(cursor, opening + 2);
    const destination = readMarkdownDestination(line, opening + 2);
    if (!destination) {
      output += line.slice(opening + 2);
      return output;
    }
    const rewritten = pinnedRelativeUrl(
      destination.value,
      sourcePath,
      sourceRepository,
      sourceCommit,
    );
    output += destination.angle ? `<${rewritten}>` : rewritten;
    cursor = destination.end;
  }
  return output;
}

function readMarkdownDestination(line, start) {
  const angle = line[start] === "<";
  let cursor = angle ? start + 1 : start;
  const valueStart = cursor;
  let nested = 0;
  let escaped = false;
  while (cursor < line.length) {
    const character = line[cursor];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (angle && character === ">") {
      return { value: line.slice(valueStart, cursor), end: cursor + 1, angle: true };
    } else if (!angle && character === "(") {
      nested += 1;
    } else if (!angle && character === ")") {
      if (nested === 0) return { value: line.slice(valueStart, cursor), end: cursor, angle: false };
      nested -= 1;
    } else if (!angle && /\s/.test(character) && nested === 0) {
      return { value: line.slice(valueStart, cursor), end: cursor, angle: false };
    }
    cursor += 1;
  }
  return undefined;
}

function pinnedRelativeUrl(target, sourcePath, sourceRepository, sourceCommit) {
  if (!target.startsWith("./") && !target.startsWith("../")) return target;
  const suffixIndex = [...[target.indexOf("?"), target.indexOf("#")]
    .filter((index) => index >= 0)].sort((left, right) => left - right)[0] ?? target.length;
  const relativePath = target.slice(0, suffixIndex);
  const suffix = target.slice(suffixIndex);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), relativePath));
  if (resolved === ".." || resolved.startsWith("../") || path.posix.isAbsolute(resolved)) {
    throw new Error(`relative Markdown link escapes the source repository: ${target}`);
  }
  const encoded = resolved.split("/").map(encodeURIComponent).join("/");
  return `${sourceRepository}/blob/${sourceCommit}/${encoded}${suffix}`;
}

function stripYamlFrontmatter(content, expectedName) {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") return content;

  if (!/^name\s*:/.test(lines[1] ?? "")) return content;

  const closingIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closingIndex === -1) {
    throw new Error(`malformed YAML frontmatter for ${expectedName}: missing closing delimiter`);
  }
  validateYamlFrontmatter(lines.slice(1, closingIndex).join("\n"), expectedName);
  return lines.slice(closingIndex + 1).join("\n");
}

function validateYamlFrontmatter(frontmatter, expectedName) {
  const document = parseDocument(frontmatter, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`malformed YAML frontmatter for ${expectedName}: invalid YAML`);
  }
  let parsed;
  try {
    parsed = document.toJS();
  } catch {
    throw new Error(`malformed YAML frontmatter for ${expectedName}: invalid YAML`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.name !== expectedName) {
    throw new Error(`malformed YAML frontmatter for ${expectedName}: expected matching name mapping`);
  }
}

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function writePages(outputDir, pages) {
  await mkdir(outputDir, { recursive: true });
  const outputStats = await lstat(outputDir);
  if (outputStats.isSymbolicLink()) throw new Error("output directory must not be a symbolic link");
  if (!outputStats.isDirectory()) throw new Error("output directory must be a directory");
  const expectedFiles = new Set([
    ...MAINTAINED_PAGE_FILES,
    ...pages.map((page) => `${page.slug}.md`),
  ]);
  const existingEntries = await readdir(outputDir, { withFileTypes: true });
  await Promise.all(existingEntries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink())
      && entry.name.endsWith(".md")
      && !expectedFiles.has(entry.name))
    .map((entry) => rm(path.join(outputDir, entry.name))));
  for (const page of pages) await writePageAtomically(outputDir, page);
}

async function writePageAtomically(outputDir, page) {
  const temporaryPath = path.join(outputDir, `.${path.basename(page.output_path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, page.body, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, page.output_path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  const directory = path.dirname(modulePath);
  const result = await extractCatalog({
    catalogPath: path.join(directory, "catalog.json"),
    outputDir: path.join(directory, "pages")
  });
  process.stdout.write(`extracted ${result.pages.length} pages from ${result.source_commit}\n`);
}

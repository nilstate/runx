import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_PAGE_COUNT = 24;
const BASE_PATH = "/runxhq/runx/";
const SOURCE_COMMIT = "5afc25a83edf1c1320df7ac0d78c36f1523b5677";
const CREDENTIAL_MARKERS = [
  "ghp_",
  "github_pat_",
  "Bearer ",
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "-----BEGIN OPENSSH PRIVATE KEY-----",
];

export async function verifyCatalog({ catalogDir } = {}) {
  const root = path.resolve(catalogDir ?? path.dirname(fileURLToPath(import.meta.url)));
  const pagesDir = path.join(root, "pages");
  const siteDir = path.join(root, "site");
  const catalog = JSON.parse(await readRequiredFile(path.join(root, "catalog.json"), "catalog"));
  const pages = flattenCatalog(catalog);
  const markdownNames = (await readdir(pagesDir))
    .filter((name) => name.endsWith(".md") && name !== "introduction.md")
    .sort();
  const expectedNames = pages.map(({ slug }) => `${slug}.md`).sort();
  if (JSON.stringify(markdownNames) !== JSON.stringify(expectedNames)) {
    throw new Error("missing generated page or unexpected generated page");
  }

  await readRequiredFile(path.join(pagesDir, "introduction.md"), "introduction page");
  const indexPath = path.join(siteDir, "index.html");
  const indexHtml = await readRequiredFile(indexPath, "site index");
  const indexTags = parseHtmlTags(indexHtml);
  const navigationTargets = new Set(indexTags
    .filter(({ name }) => name === "a")
    .map(({ attributes }) => normalizeSiteTarget(attributes.href))
    .filter(Boolean));
  const searchRecords = JSON.parse(await readRequiredFile(
    path.join(siteDir, "search-index.json"),
    "search index",
  ));
  if (!Array.isArray(searchRecords)) throw new Error("search index must be an array");
  const searchTargets = new Set(searchRecords
    .filter((record) => record?.category === "Pages" && typeof record.url === "string")
    .map((record) => normalizeSiteTarget(record.url))
    .filter(Boolean));

  const pageChecks = [];
  const markdownBySlug = new Map();
  for (const page of pages) {
    const markdownPath = path.join(pagesDir, `${page.slug}.md`);
    const markdown = await readRequiredFile(markdownPath, `generated page ${page.slug}`);
    const sourceUrl = `${catalog.source_repository}/blob/${catalog.source_commit}/${page.path}`;
    if (!markdown.includes(sourceUrl) || !markdown.includes(`Commit: \`${catalog.source_commit}\``)) {
      throw new Error(`immutable source link missing for ${page.slug}`);
    }
    markdownBySlug.set(page.slug, markdown);

    const htmlPath = path.join(siteDir, "pages", `${page.slug}.html`);
    const html = await readRequiredFile(htmlPath, `HTML page ${page.slug}`);
    const htmlLinks = parseHtmlTags(html)
      .filter(({ name }) => name === "a")
      .map(({ attributes }) => attributes.href);
    if (!htmlLinks.includes(sourceUrl)) {
      throw new Error(`immutable source link missing from HTML page ${page.slug}`);
    }
    const siteTarget = `pages/${page.slug}.html`;
    const navigation = navigationTargets.has(siteTarget);
    const search = searchTargets.has(siteTarget);
    pageChecks.push({
      slug: page.slug,
      source_path: page.path,
      source_url: sourceUrl,
      markdown_bytes: Buffer.byteLength(markdown),
      html_bytes: Buffer.byteLength(html),
      navigation,
      search,
    });
  }

  const navigationPages = pageChecks.filter(({ navigation }) => navigation).length;
  if (navigationPages !== EXPECTED_PAGE_COUNT) {
    throw new Error(`navigation coverage is ${navigationPages}/${EXPECTED_PAGE_COUNT}`);
  }
  const searchPages = pageChecks.filter(({ search }) => search).length;
  if (searchPages !== EXPECTED_PAGE_COUNT) {
    throw new Error(`search coverage is ${searchPages}/${EXPECTED_PAGE_COUNT}`);
  }

  const llmsText = await readLlmsArtifact(siteDir, "llms.txt");
  const llmsFullText = await readLlmsArtifact(siteDir, "llms-full.txt");
  const htmlFiles = (await walkFiles(siteDir)).filter((file) => file.endsWith(".html")).sort();
  const brokenLinks = await findBrokenLocalLinks(siteDir, htmlFiles);
  if (brokenLinks.length > 0) {
    throw new Error(`broken local link: ${brokenLinks[0].source} -> ${brokenLinks[0].target}`);
  }

  const credentialFindings = await findCredentialMarkers([
    ...(await walkFiles(pagesDir)),
    ...(await walkFiles(siteDir)),
  ]);
  if (credentialFindings.length > 0) {
    throw new Error(`credential-like string found in ${credentialFindings[0].path}`);
  }

  const gaps = deriveGaps(pages, markdownBySlug);
  return {
    ok: true,
    source_repository: catalog.source_repository,
    source_commit: catalog.source_commit,
    coverage: {
      manifest_pages: pages.length,
      markdown_pages: pageChecks.length,
      html_pages: pageChecks.length,
      navigation_pages: navigationPages,
      search_pages: searchPages,
      source_links: pageChecks.length,
      introduction_pages: 1,
    },
    artifacts: {
      html_files: htmlFiles.length,
      search_records: searchRecords.length,
      llms_txt_bytes: Buffer.byteLength(llmsText),
      llms_full_txt_bytes: Buffer.byteLength(llmsFullText),
    },
    page_checks: pageChecks,
    broken_links: brokenLinks,
    credential_findings: credentialFindings,
    gaps,
  };
}

function flattenCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.groups)) throw new Error("catalog groups must be an array");
  if (catalog.source_repository !== "https://github.com/runxhq/runx") {
    throw new Error("catalog must use the pinned Runx source repository");
  }
  if (catalog.source_commit !== SOURCE_COMMIT) {
    throw new Error(`catalog must use the pinned source commit ${SOURCE_COMMIT}`);
  }
  const pages = catalog.groups.flatMap((group) => group.entries ?? []);
  if (pages.length !== EXPECTED_PAGE_COUNT) {
    throw new Error(`catalog must contain exactly ${EXPECTED_PAGE_COUNT} pages`);
  }
  const slugs = new Set();
  for (const page of pages) {
    if (!page || typeof page.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(page.slug)
      || page.path !== `skills/${page.name}/SKILL.md` || slugs.has(page.slug)) {
      throw new Error("catalog contains an invalid or duplicate page");
    }
    slugs.add(page.slug);
  }
  return pages;
}

async function readRequiredFile(file, label) {
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) throw new Error();
    return await readFile(file, "utf8");
  } catch {
    throw new Error(`missing or empty ${label}`);
  }
}

async function readLlmsArtifact(siteDir, name) {
  try {
    return await readRequiredFile(path.join(siteDir, name), `llms artifact ${name}`);
  } catch {
    throw new Error(`missing or empty llms artifact: ${name}`);
  }
}

function parseHtmlTags(html) {
  const tags = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) break;
    let end = start + 1;
    let quote = "";
    while (end < html.length) {
      const character = html[end];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === "\"" || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
      end += 1;
    }
    if (end >= html.length) throw new Error("malformed HTML tag");
    const token = html.slice(start + 1, end).trim();
    cursor = end + 1;
    if (!token || token.startsWith("!") || token.startsWith("?") || token.startsWith("/")) continue;
    tags.push(parseTagToken(token));
  }
  return tags;
}

function parseTagToken(token) {
  let cursor = 0;
  while (cursor < token.length && !/\s|\//.test(token[cursor])) cursor += 1;
  const name = token.slice(0, cursor).toLowerCase();
  const attributes = {};
  while (cursor < token.length) {
    while (cursor < token.length && /\s|\//.test(token[cursor])) cursor += 1;
    const keyStart = cursor;
    while (cursor < token.length && !/[\s=]/.test(token[cursor])) cursor += 1;
    if (keyStart === cursor) break;
    const key = token.slice(keyStart, cursor).toLowerCase();
    while (cursor < token.length && /\s/.test(token[cursor])) cursor += 1;
    let value = "";
    if (token[cursor] === "=") {
      cursor += 1;
      while (cursor < token.length && /\s/.test(token[cursor])) cursor += 1;
      if (token[cursor] === "\"" || token[cursor] === "'") {
        const quote = token[cursor];
        cursor += 1;
        const valueStart = cursor;
        while (cursor < token.length && token[cursor] !== quote) cursor += 1;
        value = token.slice(valueStart, cursor);
        cursor += 1;
      } else {
        const valueStart = cursor;
        while (cursor < token.length && !/\s/.test(token[cursor])) cursor += 1;
        value = token.slice(valueStart, cursor);
      }
    }
    attributes[key] = decodeHtmlEntities(value);
  }
  return { name, attributes };
}

function decodeHtmlEntities(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function normalizeSiteTarget(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const withoutFragment = value.split("#", 1)[0].split("?", 1)[0];
  if (withoutFragment.startsWith(BASE_PATH)) return withoutFragment.slice(BASE_PATH.length);
  return withoutFragment.replace(/^\.\//, "").replace(/^\.\.\//, "");
}

async function walkFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink is not allowed in generated output: ${target}`);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  await visit(root);
  return files;
}

async function findBrokenLocalLinks(siteDir, htmlFiles) {
  const broken = [];
  const anchorCache = new Map();
  for (const file of htmlFiles) {
    const html = await readFile(file, "utf8");
    const tags = parseHtmlTags(html);
    anchorCache.set(file, new Set(tags.map(({ attributes }) => attributes.id).filter(Boolean)));
    for (const tag of tags) {
      for (const attribute of ["href", "src"]) {
        const value = tag.attributes[attribute];
        if (!value || isExternalTarget(value)) continue;
        const [rawTarget, fragment] = value.split("#", 2);
        let target;
        if (rawTarget === "") {
          target = file;
        } else if (rawTarget.startsWith(BASE_PATH)) {
          target = path.resolve(siteDir, decodeURIComponent(rawTarget.slice(BASE_PATH.length)));
        } else if (rawTarget.startsWith("/")) {
          broken.push(linkFinding(siteDir, file, value));
          continue;
        } else {
          target = path.resolve(path.dirname(file), decodeURIComponent(rawTarget.split("?", 1)[0]));
        }
        if (!isInside(siteDir, target) || !(await isRegularFile(target))) {
          broken.push(linkFinding(siteDir, file, value));
          continue;
        }
        if (fragment) {
          if (!anchorCache.has(target)) {
            const targetHtml = await readFile(target, "utf8");
            anchorCache.set(target, new Set(parseHtmlTags(targetHtml)
              .map(({ attributes }) => attributes.id)
              .filter(Boolean)));
          }
          if (!anchorCache.get(target).has(decodeURIComponent(fragment))) {
            broken.push(linkFinding(siteDir, file, value));
          }
        }
      }
    }
  }
  return broken.sort((left, right) => `${left.source}\0${left.target}`.localeCompare(
    `${right.source}\0${right.target}`,
    "en",
  ));
}

function isExternalTarget(value) {
  return value.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function isRegularFile(file) {
  try {
    const metadata = await lstat(file);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function linkFinding(siteDir, source, target) {
  return { source: path.relative(siteDir, source), target };
}

async function findCredentialMarkers(files) {
  const findings = [];
  for (const file of files.sort()) {
    const content = await readFile(file);
    for (const marker of CREDENTIAL_MARKERS) {
      if (content.includes(Buffer.from(marker))) {
        findings.push({ path: file, marker });
      }
    }
  }
  return findings;
}

function deriveGaps(pages, markdownBySlug) {
  const definitions = [
    {
      id: "missing-worked-examples",
      title: "Selected skills lack a worked example section",
      pattern: /^## (?:Worked )?Example\b/im,
      impact: "Operators cannot validate the expected input-to-output flow from the reference page alone.",
    },
    {
      id: "missing-output-contracts",
      title: "Selected skills lack a dedicated output contract section",
      pattern: /^## [^\n]*\bOutputs?\b/im,
      impact: "Integrators must infer result shapes instead of comparing them against an explicit contract.",
    },
    {
      id: "missing-edge-case-guidance",
      title: "Selected skills lack a dedicated edge-case or stop-condition section",
      pattern: /^## .*?(?:Edge cases|Stop conditions)\b/im,
      impact: "Operators have no single place to check refusal, escalation, and terminal behavior.",
    },
    {
      id: "missing-non-use-guidance",
      title: "Selected skills lack a dedicated when-not-to-use section",
      pattern: /^## When not to use\b/im,
      impact: "Operators must infer when a different skill or workflow is the safer choice.",
    },
  ];
  return definitions.map((definition) => {
    const affected = pages
      .filter(({ slug }) => !definition.pattern.test(markdownBySlug.get(slug)))
      .map(({ path: sourcePath }) => sourcePath);
    return {
      id: definition.id,
      title: definition.title,
      affected_paths: affected,
      measured_fact: `${affected.length} of ${pages.length} selected skills do not contain the measured heading.`,
      impact: definition.impact,
    };
  }).filter(({ affected_paths: affectedPaths }) => affectedPaths.length > 0);
}

export function renderGapReport(packet) {
  const lines = [
    "# Sourcey Catalog Documentation Gaps",
    "",
    `Measured from ${packet.coverage.markdown_pages} generated skill pages at commit \`${packet.source_commit}\`.`,
    "",
  ];
  for (const gap of packet.gaps) {
    lines.push(
      `## ${gap.title}`,
      "",
      `- Affected source paths: ${gap.affected_paths.map((sourcePath) => `\`${sourcePath}\``).join(", ") || "none"}`,
      `- Measured fact: ${gap.measured_fact}`,
      `- Why it matters: ${gap.impact}`,
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyCatalog().then(async (packet) => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    await writeFile(path.join(root, "verification.json"), `${JSON.stringify(packet, null, 2)}\n`, "utf8");
    await writeFile(path.join(root, "gaps.md"), renderGapReport(packet), "utf8");
    process.stdout.write(`${JSON.stringify({ ok: packet.ok, coverage: packet.coverage })}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

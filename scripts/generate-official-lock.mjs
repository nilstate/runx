#!/usr/bin/env node

import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, "..");
const skillsRoot = path.join(workspaceRoot, "skills");
const outputPath = path.join(skillsRoot, "official.lock.json");
const rustOutputPath = path.join(workspaceRoot, "crates", "runx-cli", "src", "official_skills.rs");

const entries = [];
for (const entry of (await readdir(skillsRoot, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
  if (!entry.isDirectory()) continue;
  const skillDir = path.join(skillsRoot, entry.name);
  const profilePath = path.join(skillDir, "X.yaml");
  try {
    await access(path.join(skillDir, "SKILL.md"));
    await access(profilePath);
  } catch {
    continue;
  }
  const markdown = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
  const profileDocument = await readFile(profilePath, "utf8");
  const record = buildOfficialSkillLockRecord(markdown, profileDocument);
  entries.push({
    skill_id: record.skill_id,
    version: record.version,
    digest: record.digest,
    catalog_visibility: record.catalog_visibility,
    catalog_role: record.catalog_role,
  });
}

await writeFile(outputPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
await writeFile(rustOutputPath, rustOfficialLock(entries), "utf8");

function buildOfficialSkillLockRecord(markdown, profileDocument) {
  const skill = parseSkillFrontmatter(markdown);
  const manifest = parseRunnerManifest(profileDocument);
  if (manifest.skill && manifest.skill !== skill.name) {
    throw new Error(`Runner manifest skill '${manifest.skill}' does not match skill '${skill.name}'.`);
  }

  const digest = createHash("sha256").update(markdown).digest("hex");
  const profileDigest = createHash("sha256").update(profileDocument).digest("hex");
  const versionSeed = createHash("sha256")
    .update(JSON.stringify({
      markdown_digest: digest,
      profile_digest: profileDigest,
    }))
    .digest("hex");
  return {
    skill_id: `runx/${slugifyOfficialSkillName(skill.name)}`,
    version: `sha-${versionSeed.slice(0, 12)}`,
    digest,
    catalog_visibility: manifest.catalog.visibility,
    catalog_role: manifest.catalog.role,
  };
}

function parseSkillFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error("Official SKILL.md is missing YAML frontmatter.");
  }
  const frontmatter = YAML.parse(match[1]);
  if (!frontmatter || typeof frontmatter !== "object" || typeof frontmatter.name !== "string" || frontmatter.name.trim() === "") {
    throw new Error("Official SKILL.md frontmatter must declare a non-empty name.");
  }
  return { name: frontmatter.name.trim() };
}

function parseRunnerManifest(profileDocument) {
  assertExecutionProfileYamlSubset("runner_manifest", profileDocument);
  const manifest = YAML.parse(profileDocument);
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Official X.yaml must parse to an object.");
  }
  const catalog = manifest.catalog;
  if (!catalog || typeof catalog !== "object") {
    throw new Error("Official X.yaml must declare catalog metadata.");
  }
  const visibility = catalog.visibility ?? "internal";
  const role = catalog.role;
  if (visibility !== "public" && visibility !== "internal") {
    throw new Error("Official X.yaml catalog.visibility must be public or internal.");
  }
  if (![
    "canonical",
    "branded",
    "context",
    "graph-stage",
    "runtime-path",
    "harness-fixture",
  ].includes(role)) {
    throw new Error("Official X.yaml catalog.role is missing or invalid.");
  }
  if (visibility === "public" && ["graph-stage", "runtime-path", "harness-fixture"].includes(role)) {
    throw new Error("Official X.yaml public catalog entries cannot be graph stages, runtime paths, or harness fixtures.");
  }
  if (role === "branded" && (!catalog.canonical_skill || !catalog.provider)) {
    throw new Error("Official X.yaml branded catalog entries must declare canonical_skill and provider.");
  }
  if (
    ["graph-stage", "runtime-path", "harness-fixture"].includes(role) &&
    (!Array.isArray(catalog.part_of) || catalog.part_of.length === 0)
  ) {
    throw new Error("Official X.yaml internal graph-stage, runtime-path, and harness-fixture entries must declare part_of.");
  }
  return {
    skill: typeof manifest.skill === "string" ? manifest.skill : undefined,
    catalog: { visibility, role },
  };
}

function slugifyOfficialSkillName(value) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Error("Official skill names cannot produce an empty registry slug.");
  }
  return slug;
}

function rustOfficialLock(entries) {
  const lines = [
    "// Generated by scripts/generate-official-lock.mjs; do not edit.",
    "// rust-style-allow: large-file - generated official-skill lock table is kept",
    "// contiguous so digest/version updates remain mechanical and reviewable.",
    "",
    "#[derive(Clone, Copy, Debug, Eq, PartialEq)]",
    "pub(crate) struct OfficialSkillLockEntry {",
    "    pub(crate) skill_id: &'static str,",
    "    pub(crate) version: &'static str,",
    "    pub(crate) digest: &'static str,",
    "}",
    "",
    "pub(crate) const OFFICIAL_SKILLS: &[OfficialSkillLockEntry] = &[",
  ];
  for (const entry of entries) {
    lines.push(
      "    OfficialSkillLockEntry {",
      `        skill_id: ${JSON.stringify(entry.skill_id)},`,
      `        version: ${JSON.stringify(entry.version)},`,
      `        digest: ${JSON.stringify(entry.digest)},`,
      "    },",
    );
  }
  lines.push(
    "];",
    "",
    "pub(crate) fn official_skill_entry_by_name(name: &str) -> Option<&'static OfficialSkillLockEntry> {",
    "    let normalized = name.trim();",
    "    OFFICIAL_SKILLS.iter().find(|entry| {",
    "        entry.skill_id == normalized",
    "            || entry",
    "                .skill_id",
    "                .strip_prefix(\"runx/\")",
    "                .is_some_and(|skill_name| skill_name == normalized)",
    "    })",
    "}",
    "",
  );
  return lines.join("\n");
}

function assertExecutionProfileYamlSubset(field, source) {
  const stack = [];
  let blockScalarIndent;
  for (const [lineIndex, line] of source.split(/\r?\n/).entries()) {
    const lineNumber = lineIndex + 1;
    const content = stripYamlComment(line);
    if (content === undefined) continue;
    const trimmed = content.trim();
    if (blockScalarIndent !== undefined) {
      if (trimmed === "" || leadingSpaces(content) > blockScalarIndent) continue;
      blockScalarIndent = undefined;
    }
    if (trimmed === "") continue;
    if (trimmed === "---" || trimmed === "..." || trimmed.startsWith("--- ") || trimmed.startsWith("... ")) {
      throw new Error(`${field}: YAML document markers are not supported in X.yaml at line ${lineNumber}; use one plain profile document.`);
    }
    for (const token of [": &", ": *", ": !", "- &", "- *", "- !"]) {
      if (containsPlainToken(content, token)) {
        throw new Error(`${field}: YAML anchors, aliases, and tags are not supported in X.yaml at line ${lineNumber}; write the profile explicitly.`);
      }
    }
    const trimmedStart = content.trimStart();
    if (trimmedStart.startsWith("&") || trimmedStart.startsWith("*") || trimmedStart.startsWith("!")) {
      throw new Error(`${field}: YAML anchors, aliases, and tags are not supported in X.yaml at line ${lineNumber}; write the profile explicitly.`);
    }
    rejectDuplicateMappingKey(field, lineNumber, content, stack);
    blockScalarIndent = blockScalarIndentAfter(content) ?? blockScalarIndent;
  }
}

function stripYamlComment(line) {
  const scanner = createQuoteScanner();
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (scanner.isPlainAt(char) && char === "#" && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
    scanner.consume(char);
  }
  return line;
}

function containsPlainToken(content, token) {
  const scanner = createQuoteScanner();
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (scanner.isPlainAt(char) && content.startsWith(token, index)) {
      return true;
    }
    scanner.consume(char);
  }
  return false;
}

function createQuoteScanner() {
  let state = "plain";
  return {
    isPlainAt(char) {
      if (state === "plain") return true;
      if (state === "in-single-pending-apostrophe") return char !== "'";
      return false;
    },
    consume(char) {
      if (state === "plain") {
        state = plainStateAfter(char);
      } else if (state === "in-double") {
        state = char === "\\" ? "in-double-escape" : char === "\"" ? "plain" : "in-double";
      } else if (state === "in-double-escape") {
        state = "in-double";
      } else if (state === "in-single") {
        state = char === "'" ? "in-single-pending-apostrophe" : "in-single";
      } else {
        state = char === "'" ? "in-single" : plainStateAfter(char);
      }
    },
  };

  function plainStateAfter(char) {
    if (char === "'") return "in-single";
    if (char === "\"") return "in-double";
    return "plain";
  }
}

function rejectDuplicateMappingKey(field, lineNumber, content, stack) {
  const indent = leadingSpaces(content);
  const trimmed = content.trimStart();
  const sequence = sequenceItemKey(trimmed, indent);
  const plain = sequence ?? topLevelPlainKey(trimmed)?.map((value, index) => index === 0 ? value : indent);
  if (!plain) return;
  const keyIndent = sequence ? sequence[0] : indent;
  const key = sequence ? sequence[1] : plain[0];
  const sequenceItem = Boolean(sequence);
  if (key === "<<") {
    throw new Error(`${field}: YAML merge keys are not supported in X.yaml at line ${lineNumber}; write the profile explicitly.`);
  }
  while (stack.at(-1) && (sequenceItem ? stack.at(-1).indent >= keyIndent : stack.at(-1).indent > keyIndent)) {
    stack.pop();
  }
  if (!stack.at(-1) || stack.at(-1).indent !== keyIndent) {
    stack.push({ indent: keyIndent, keys: new Set() });
  }
  const frame = stack.at(-1);
  if (frame.keys.has(key)) {
    throw new Error(`${field}: duplicate mapping key ${JSON.stringify(key)} in X.yaml at line ${lineNumber}; keep profile keys unique.`);
  }
  frame.keys.add(key);
}

function blockScalarIndentAfter(content) {
  return blockScalarValueCandidates(content).some(isBlockScalarHeader) ? leadingSpaces(content) : undefined;
}

function blockScalarValueCandidates(content) {
  const candidates = [];
  const mapping = splitPlainMappingValue(content);
  if (mapping) candidates.push(mapping[1]);
  const trimmed = content.trimStart();
  if (trimmed.startsWith("- ")) {
    const item = trimmed.slice(2).trimStart();
    candidates.push(item);
    const itemMapping = splitPlainMappingValue(item);
    if (itemMapping) candidates.push(itemMapping[1]);
  }
  return candidates;
}

function isBlockScalarHeader(value) {
  return /^[|>](?:[+-]?\d?|\d?[+-]?)$/.test(value.trim());
}

function splitPlainMappingValue(content) {
  const trimmed = content.trimStart();
  const split = topLevelPlainKey(trimmed);
  return split ? [split[0], trimmed.slice(split[1] + 1)] : undefined;
}

function leadingSpaces(content) {
  return content.length - content.trimStart().length;
}

function sequenceItemKey(trimmed, indent) {
  if (!trimmed.startsWith("- ")) return undefined;
  const rest = trimmed.slice(2);
  const item = rest.trimStart();
  const key = topLevelPlainKey(item)?.[0];
  return key === undefined ? undefined : [indent + 2 + rest.length - item.length, key];
}

function topLevelPlainKey(trimmed) {
  const first = trimmed[0];
  if (!first || ["-", "?", "{", "[", "\"", "'"].includes(first)) return undefined;
  const scanner = createQuoteScanner();
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (scanner.isPlainAt(char) && char === ":" && isMappingDelimiter(trimmed, index)) {
      return [trimmed.slice(0, index).trim(), index];
    }
    scanner.consume(char);
  }
  return undefined;
}

function isMappingDelimiter(value, index) {
  return value[index + 1] === undefined || /\s/.test(value[index + 1]);
}

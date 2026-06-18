import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const rustRoots = [
  "crates/runx-cli/src",
  "crates/runx-contracts/src",
  "crates/runx-core/src",
  "crates/runx-pay/src",
  "crates/runx-parser/src",
  "crates/runx-receipts/src",
  "crates/runx-runtime/src",
  "crates/runx-sdk/src",
];

const disallowedPatterns = [
  {
    pattern: /\bpub\s+use\s+[^;]*\*/u,
    reason: "wildcard re-exports hide the public API surface",
  },
  {
    pattern: /\bserde_json::Value\b/u,
    reason: "public Rust code should use typed structs/enums, not JSON values",
    // Wire-boundary adapters legitimately parse/build untyped JSON with
    // serde_json::Value and convert to/from the runx JsonValue only at the
    // domain boundary (the documented convention; see agent_anthropic.rs).
    allowlist: [
      "crates/runx-cli/src/verify.rs",
      "crates/runx-runtime/src/adapters/agent_anthropic.rs",
      "crates/runx-runtime/src/adapters/http.rs",
    ],
  },
  {
    pattern: /\bserde_(?:norway|yml)::Value\b/u,
    reason: "public Rust code should parse YAML into typed structs or runx JSON carriers",
  },
  {
    pattern: /\bHashMap\b/u,
    reason: "serialized maps must use deterministic key order; prefer BTreeMap",
    allowlist: ["crates/runx-runtime/src/execution/graph_index.rs"],
  },
  {
    pattern: /\b(?:anyhow|eyre)::/u,
    reason: "public Rust APIs must not erase errors behind app-level error crates",
  },
  {
    pattern: /\bBox\s*<\s*dyn\s+(?:std::)?error::Error/u,
    reason: "public Rust APIs must use concrete error or decision types",
  },
  {
    pattern: /\b(?:macro_rules!|proc_macro)\b/u,
    reason: "model-shaping macros require spec-level justification",
  },
  {
    pattern: /\b(?:panic|todo|unimplemented|dbg)!\s*\(/u,
    reason: "production Rust code must not contain panic/todo/debug macros",
  },
  {
    pattern: /\.(?:unwrap|expect)\s*\(/u,
    reason: "production Rust code should return decisions/errors instead of panicking",
  },
];

const findings = [];

for (const root of rustRoots) {
  const absoluteRoot = path.join(workspaceRoot, root);
  if (!(await exists(absoluteRoot))) {
    continue;
  }
  for (const filePath of await listRustFiles(absoluteRoot)) {
    const source = await readFile(filePath, "utf8");
    const relativePath = path.relative(workspaceRoot, filePath);
    const production = productionSource(relativePath, source);
    checkPatterns(relativePath, production);
    checkFileSize(relativePath, production);
    checkFunctionSize(relativePath, production);
  }
}

await checkStateMachineFixtureCoverage();
await checkPolicyFixtureCoverage();
await checkContractFixtureCoverage();
await checkParserFixtureCoverage();

if (findings.length > 0) {
  console.error("Rust style check failed:");
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exit(1);
}

console.log("Rust style check passed.");

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function listRustFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listRustFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".rs")) {
      files.push(entryPath);
    }
  }
  return files;
}

function checkPatterns(relativePath, source) {
  if (relativePath.endsWith("_tests.rs")) {
    return;
  }
  for (const { pattern, reason, allowlist = [] } of disallowedPatterns) {
    if (allowlist.includes(relativePath)) {
      continue;
    }
    const match = pattern.exec(source);
    if (match) {
      const line = lineNumberForIndex(source, match.index);
      findings.push(`${relativePath}:${line} ${reason}`);
    }
  }
}

function productionSource(relativePath, source) {
  if (relativePath.endsWith("_tests.rs")) {
    return "";
  }
  return stripCfgTestModules(source);
}

function stripCfgTestModules(source) {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const cfgIndex = source.indexOf("#[cfg(test)]", index);
    if (cfgIndex === -1) {
      output += source.slice(index);
      break;
    }
    output += source.slice(index, cfgIndex);
    const moduleMatch = /\s*(?:#[^\n]*\n\s*)*mod\s+\w+\s*\{/u.exec(source.slice(cfgIndex + "#[cfg(test)]".length));
    if (!moduleMatch) {
      index = cfgIndex + "#[cfg(test)]".length;
      continue;
    }
    const moduleStart = cfgIndex + "#[cfg(test)]".length + moduleMatch.index;
    const bodyStart = cfgIndex + "#[cfg(test)]".length + moduleMatch.index + moduleMatch[0].lastIndexOf("{");
    const moduleEnd = matchingBraceEnd(source, bodyStart);
    if (moduleEnd === -1) {
      index = cfgIndex + "#[cfg(test)]".length;
      continue;
    }
    output += "\n";
    index = moduleEnd + 1;
  }
  return output;
}

function matchingBraceEnd(source, openBraceIndex) {
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function checkFileSize(relativePath, source) {
  if (source.includes("rust-style-allow: large-file")) {
    return;
  }
  const lineCount = source.split("\n").length;
  if (lineCount > 350) {
    findings.push(`${relativePath}:1 file has ${lineCount} lines; split it or add rust-style-allow: large-file with a reason`);
  }
}

function checkFunctionSize(relativePath, source) {
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+|async\s+)?fn\s+\w/u.test(lines[index])) {
      continue;
    }
    const preceding = lines.slice(Math.max(0, index - 3), index + 1).join("\n");
    if (preceding.includes("rust-style-allow: long-function")) {
      continue;
    }
    const length = functionLength(lines, index);
    if (length > 60) {
      findings.push(`${relativePath}:${index + 1} function has ${length} lines; split it or add rust-style-allow: long-function with a reason`);
    }
  }
}

async function checkStateMachineFixtureCoverage() {
  await checkFixtureCoverage({
    fixtureDirectory: path.join(workspaceRoot, "fixtures/kernel/state-machine"),
    testFile: path.join(workspaceRoot, "crates/runx-core/tests/state_machine_fixtures.rs"),
    includePattern: /fixtures\/kernel\/state-machine\/([^"]+\.json)/gu,
    fixturePath: "fixtures/kernel/state-machine",
  });
}

async function checkPolicyFixtureCoverage() {
  await checkFixtureCoverage({
    fixtureDirectory: path.join(workspaceRoot, "fixtures/kernel/policy"),
    testFile: path.join(workspaceRoot, "crates/runx-core/tests/policy_fixtures.rs"),
    includePattern: /fixtures\/kernel\/policy\/([^"]+\.json)/gu,
    fixturePath: "fixtures/kernel/policy",
  });
}

async function checkContractFixtureCoverage() {
  await checkFixtureCoverage({
    fixtureDirectory: path.join(workspaceRoot, "fixtures/contracts/act-assignment"),
    testFile: path.join(workspaceRoot, "crates/runx-contracts/tests/act_assignment_fixtures.rs"),
    includePattern: /fixtures\/contracts\/act-assignment\/([^"]+\.json)/gu,
    fixturePath: "fixtures/contracts/act-assignment",
  });
  await checkFixtureCoverage({
    fixtureDirectory: path.join(workspaceRoot, "fixtures/contracts/execution"),
    testFile: path.join(workspaceRoot, "crates/runx-contracts/tests/execution_fixtures.rs"),
    includePattern: /fixtures\/contracts\/execution\/([^"]+\.json)/gu,
    fixturePath: "fixtures/contracts/execution",
  });
  await checkFixtureCoverage({
    fixtureDirectory: path.join(workspaceRoot, "fixtures/contracts/host-protocol"),
    testFile: path.join(workspaceRoot, "crates/runx-contracts/tests/host_protocol_fixtures.rs"),
    includePattern: /fixtures\/contracts\/host-protocol\/([^"]+\.json)/gu,
    fixturePath: "fixtures/contracts/host-protocol",
  });
}

async function checkParserFixtureCoverage() {
  await checkFixtureCoverage({
    fixtureDirectory: path.join(workspaceRoot, "fixtures/parser/graphs"),
    testFile: path.join(workspaceRoot, "crates/runx-parser/tests/parser_fixtures.rs"),
    includePattern: /fixtures\/parser\/graphs\/([^"]+\.json)/gu,
    fixturePath: "fixtures/parser/graphs",
  });
  await checkFixtureCoverage({
    fixtureDirectory: path.join(workspaceRoot, "fixtures/parser/skills"),
    testFile: path.join(workspaceRoot, "crates/runx-parser/tests/parser_fixtures.rs"),
    includePattern: /fixtures\/parser\/skills\/([^"]+\.json)/gu,
    fixturePath: "fixtures/parser/skills",
  });
  await checkFixtureCoverage({
    fixtureDirectory: path.join(workspaceRoot, "fixtures/parser/runner-manifests"),
    testFile: path.join(workspaceRoot, "crates/runx-parser/tests/parser_fixtures.rs"),
    includePattern: /fixtures\/parser\/runner-manifests\/([^"]+\.json)/gu,
    fixturePath: "fixtures/parser/runner-manifests",
  });
  await checkFixtureCoverage({
    fixtureDirectory: path.join(workspaceRoot, "fixtures/parser/tool-manifests"),
    testFile: path.join(workspaceRoot, "crates/runx-parser/tests/parser_fixtures.rs"),
    includePattern: /fixtures\/parser\/tool-manifests\/([^"]+\.json)/gu,
    fixturePath: "fixtures/parser/tool-manifests",
  });
  await checkFixtureCoverage({
    fixtureDirectory: path.join(workspaceRoot, "fixtures/parser/installs"),
    testFile: path.join(workspaceRoot, "crates/runx-parser/tests/parser_fixtures.rs"),
    includePattern: /fixtures\/parser\/installs\/([^"]+\.json)/gu,
    fixturePath: "fixtures/parser/installs",
  });
}

async function checkFixtureCoverage({ fixtureDirectory, testFile, includePattern, fixturePath }) {
  if (!(await exists(fixtureDirectory)) || !(await exists(testFile))) {
    return;
  }

  const fixtureNames = (await readdir(fixtureDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const source = await readFile(testFile, "utf8");
  const testPath = path.relative(workspaceRoot, testFile);
  const includedNames = new Set([...source.matchAll(includePattern)].map((match) => match[1]));

  for (const fixtureName of fixtureNames) {
    if (!includedNames.has(fixtureName)) {
      findings.push(`${testPath}:1 missing include_str! coverage for ${fixturePath}/${fixtureName}`);
    }
  }

  for (const includedName of includedNames) {
    if (!fixtureNames.includes(includedName)) {
      findings.push(`${testPath}:1 stale include_str! for missing ${fixturePath}/${includedName}`);
    }
  }
}

function functionLength(lines, startIndex) {
  let depth = 0;
  let seenBody = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    const code = stripLineComment(lines[index]);
    if (!seenBody && depth === 0 && code.includes(";")) {
      return 1;
    }
    for (const char of code) {
      if (char === "{") {
        depth += 1;
        seenBody = true;
      } else if (char === "}") {
        depth -= 1;
      }
    }
    if (seenBody && depth === 0) {
      return index - startIndex + 1;
    }
  }
  return lines.length - startIndex;
}

function stripLineComment(line) {
  const commentIndex = line.indexOf("//");
  return commentIndex === -1 ? line : line.slice(0, commentIndex);
}

function lineNumberForIndex(source, index) {
  return source.slice(0, index).split("\n").length;
}

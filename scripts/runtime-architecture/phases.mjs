import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  countMatches,
  productionRustSource,
  relative,
  rustFiles,
  workspaceRoot,
} from "./context.mjs";

export function checkServiceBoundary(findings) {
  const roots = [
    "crates/runx-runtime/src/adapters",
    "crates/runx-runtime/src/execution",
  ];
  const forbidden = [
    /\bRuntimeReceiptSignatureConfig::from_env\b/u,
    /\bLocalReceiptStore::new\b/u,
    /\bresolve_receipt_path\s*\(/u,
    /\bstd::env::(?:var|vars)\s*\(/u,
  ];
  for (const root of roots) {
    for (const filePath of rustFiles(root)) {
      const source = productionRustSource(readFileSync(filePath, "utf8"));
      for (const pattern of forbidden) {
        if (pattern.test(source)) {
          findings.push(`${relative(filePath)} still constructs environment or receipt state outside runtime services`);
        }
      }
    }
  }
}

export function checkExecutionSplit(findings) {
  const stepsPath = path.join(workspaceRoot, "crates/runx-runtime/src/execution/runner/steps.rs");
  if (!existsSync(stepsPath)) {
    return;
  }
  const source = readFileSync(stepsPath, "utf8");
  const forbidden = [
    /\bstep_receipt_with\b/u,
    /\brequest_approval\b/u,
    /\bSkillAdapter::invoke\b/u,
    /\bresolve_inputs\b/u,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(source)) {
      findings.push(`${relative(stepsPath)} still contains mixed runner responsibility token ${pattern}`);
    }
  }
}

export function checkProjectionHotPaths(findings) {
  const runtimeRoot = path.join(workspaceRoot, "crates/runx-runtime/src");
  const compactIndexFound = rustFiles("crates/runx-runtime/src").some((filePath) => {
    const source = readFileSync(filePath, "utf8");
    return /\bstruct\s+\w*(?:Id)?Interner\b/u.test(source)
      || /\bstruct\s+\w*(?:Step)?PositionIndex\b[\s\S]*?\bpositions:\s*BTreeMap<String,\s*usize>/u.test(source);
  });
  if (!compactIndexFound) {
    findings.push(`${relative(runtimeRoot)} has no runtime-local id interner or compact position index for hot execution/projection paths`);
  }

  const cloneBudget = new Map([
    ["crates/runx-runtime/src/execution/graph_index.rs", 8],
    ["crates/runx-runtime/src/execution/output_projection.rs", 8],
  ]);
  for (const [relPath, maxClones] of cloneBudget) {
    const filePath = path.join(workspaceRoot, relPath);
    if (!existsSync(filePath)) {
      continue;
    }
    const count = countMatches(readFileSync(filePath, "utf8"), /\.clone\s*\(/gu);
    if (count > maxClones) {
      findings.push(`${relPath} has ${count} .clone() calls, above budget ${maxClones}`);
    }
  }
}

export function checkSessionPooling(findings) {
  for (const filePath of rustFiles("crates/runx-runtime/src")) {
    const source = readFileSync(filePath, "utf8");
    if (/\b(?:cli.*pool|pool.*cli|user command pool|pooled.*Command|CommandPool)\b/iu.test(source)) {
      findings.push(`${relative(filePath)} appears to pool arbitrary CLI/user commands`);
    }
  }
  const mcpTransportPath = path.join(workspaceRoot, "crates/runx-runtime/src/adapters/mcp/transport.rs");
  const mcpTransport = existsSync(mcpTransportPath) ? readFileSync(mcpTransportPath, "utf8") : "";
  for (const pattern of [
    /\bstruct\s+McpSessionManager\b/u,
    /\bstruct\s+McpSessionKey\b/u,
    /\breset_session_pool\b/u,
    /\bspawned_process_count\b/u,
  ]) {
    if (!pattern.test(mcpTransport)) {
      findings.push(`${relative(mcpTransportPath)} lacks required MCP session-pooling token ${pattern}`);
    }
  }
  const perfHarnessPath = path.join(workspaceRoot, "scripts/runtime-throughput.mjs");
  const perfHarness = existsSync(perfHarnessPath) ? readFileSync(perfHarnessPath, "utf8") : "";
  if (!/\brunx-mcp-session-probe\b/u.test(perfHarness) || /mcp_session_reuse[\s\S]{0,400}source:\s*"node"/u.test(perfHarness)) {
    findings.push(`${relative(perfHarnessPath)} must measure MCP session workloads through the Rust MCP session probe`);
  }
}

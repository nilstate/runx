import fs from "node:fs";
import path from "node:path";

import {
  defineTool,
  resolveRepoRoot,
  stringInput,
} from "@runxhq/authoring";

export default defineTool({
  name: "spec.read_declared_files",
  description: "Read the current contents of files declared in a scafld spec before bounded fix authoring.",
  inputs: {
    spec_contents: stringInput({ description: "Raw scafld spec contents to inspect for declared file paths." }),
    repo_root: stringInput({ optional: true, description: "Repository root used to resolve declared file paths." }),
    fixture: stringInput({ optional: true, description: "Optional fixture workspace root used during dev and harness execution." }),
  },
  output: {
    packet: "runx.spec.declared_file_context.v1",
    wrap_as: "declared_file_context",
  },
  scopes: ["spec.read_declared_files"],
  run: runReadDeclaredFiles,
});

function runReadDeclaredFiles({ inputs, env }) {
  const specContents = inputs.spec_contents;
  const repoRoot = resolveRepoRoot(inputs, env);
  const declared = new Map();

  function rememberPath(relativePath, declaredIn) {
    const normalized = stripQuotes(relativePath);
    if (!normalized) {
      return;
    }
    const current = declared.get(normalized) || new Set();
    current.add(declaredIn);
    declared.set(normalized, current);
  }

  const lines = specContents.split(/\r?\n/);
  let filesImpactedIndent = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (filesImpactedIndent !== null) {
      if (trimmed.length === 0) {
        continue;
      }
      const currentIndent = indentation(line);
      if (currentIndent <= filesImpactedIndent) {
        filesImpactedIndent = null;
      } else {
        const listMatch = line.match(/^\s*-\s*(.+?)\s*$/);
        if (listMatch) {
          rememberPath(listMatch[1], "task.context.files_impacted");
        }
        continue;
      }
    }

    const filesImpactedMatch = line.match(/^(\s*)files_impacted:\s*$/);
    if (filesImpactedMatch) {
      filesImpactedIndent = filesImpactedMatch[1].length;
      continue;
    }

    const phaseChangeMatch = line.match(/^\s*-\s*file:\s*(.+?)\s*$/);
    if (phaseChangeMatch) {
      rememberPath(phaseChangeMatch[1], "phases[].changes[].file");
    }
  }

  const files = [...declared.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, declaredIn]) => {
      const resolvedPath = path.resolve(repoRoot, relativePath);
      const exists = fs.existsSync(resolvedPath);
      return {
        path: relativePath,
        exists,
        kind:
          relativePath.startsWith(".ai/specs/") ||
          relativePath.startsWith(".ai/reviews/")
            ? "governance_artifact"
            : "repo_file",
        declared_in: [...declaredIn].sort(),
        contents: exists ? fs.readFileSync(resolvedPath, "utf8") : null,
      };
    });

  return {
    repo_root: repoRoot,
    declared_count: files.length,
    files,
  };
}

function stripQuotes(value) {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function indentation(line) {
  const match = String(line).match(/^(\s*)/);
  return match ? match[1].length : 0;
}

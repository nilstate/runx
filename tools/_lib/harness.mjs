import path from "node:path";

const failureMarker = Symbol("runx.tool.failure");

export function defineTool(definition) {
  return {
    ...definition,
    async runWith(rawInputs = {}) {
      const inputs = materializeInputs(
        definition.inputs ?? {},
        rawInputs,
        definition.name,
      );
      const output = await definition.run({
        inputs,
        rawInputs,
        env: process.env,
        cwd: process.cwd(),
      });
      return finalizeOutput(output, definition);
    },
    async main() {
      try {
        const rawInputs = parseInputs(process.env.RUNX_INPUTS_JSON);
        const output = await this.runWith(rawInputs);
        if (isToolFailure(output)) {
          process.stdout.write(JSON.stringify(output.output));
          if (output.stderr) {
            process.stderr.write(
              output.stderr.endsWith("\n")
                ? output.stderr
                : `${output.stderr}\n`,
            );
          }
          process.exitCode = output.exitCode;
          return;
        }
        process.stdout.write(JSON.stringify(output));
      } catch (error) {
        process.stderr.write(
          `${JSON.stringify({
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          })}\n`,
        );
        process.exitCode = 1;
      }
    },
  };
}

export function failure(output, options = {}) {
  return {
    [failureMarker]: true,
    output,
    exitCode:
      Number.isInteger(options.exitCode) && options.exitCode > 0
        ? options.exitCode
        : 1,
    stderr: typeof options.stderr === "string" ? options.stderr : undefined,
  };
}

export function artifact(options = {}) {
  return {
    optional: options.optional === true,
    parse(value, label) {
      if (value === undefined || value === null) {
        if (options.optional === true) {
          return undefined;
        }
        throw new Error(`${label} is required.`);
      }
      return unwrapArtifactData(value, label);
    },
  };
}

export function optionalArtifact() {
  return artifact({ optional: true });
}

export function stringInput(options = {}) {
  return {
    optional: options.optional === true || options.default !== undefined,
    parse(value, label) {
      const resolved = value ?? options.default;
      if (resolved === undefined || resolved === null || resolved === "") {
        if (options.optional === true || options.default !== undefined) {
          return undefined;
        }
        throw new Error(`${label} is required.`);
      }
      return String(resolved);
    },
  };
}

export function numberInput(options = {}) {
  return {
    optional: options.optional === true || options.default !== undefined,
    parse(value, label) {
      const resolved = value ?? options.default;
      if (resolved === undefined || resolved === null || resolved === "") {
        if (options.optional === true || options.default !== undefined) {
          return undefined;
        }
        throw new Error(`${label} is required.`);
      }
      const parsed = typeof resolved === "number" ? resolved : Number(resolved);
      if (!Number.isFinite(parsed)) {
        throw new Error(`${label} must be a finite number.`);
      }
      return parsed;
    },
  };
}

export function booleanInput(options = {}) {
  return {
    optional: options.optional === true || options.default !== undefined,
    parse(value, label) {
      const resolved = value ?? options.default;
      if (resolved === undefined || resolved === null || resolved === "") {
        if (options.optional === true || options.default !== undefined) {
          return undefined;
        }
        throw new Error(`${label} is required.`);
      }
      if (typeof resolved === "boolean") {
        return resolved;
      }
      if (typeof resolved === "number") {
        if (resolved === 1) {
          return true;
        }
        if (resolved === 0) {
          return false;
        }
      }
      if (typeof resolved === "string") {
        const normalized = resolved.trim().toLowerCase();
        if (["true", "1", "yes"].includes(normalized)) {
          return true;
        }
        if (["false", "0", "no"].includes(normalized)) {
          return false;
        }
      }
      throw new Error(`${label} must be a boolean.`);
    },
  };
}

export function jsonInput(options = {}) {
  return {
    optional: options.optional === true || options.default !== undefined,
    parse(value, label) {
      const resolved = value ?? options.default;
      if (resolved === undefined || resolved === null || resolved === "") {
        if (options.optional === true || options.default !== undefined) {
          return undefined;
        }
        throw new Error(`${label} is required.`);
      }
      if (typeof resolved !== "string") {
        return resolved;
      }
      try {
        return JSON.parse(resolved);
      } catch {
        throw new Error(`${label} must be valid JSON.`);
      }
    },
  };
}

export function recordInput(options = {}) {
  return {
    optional: options.optional === true || options.default !== undefined,
    parse(value, label) {
      const parsed = jsonInput(options).parse(value, label);
      if (parsed === undefined) {
        return undefined;
      }
      if (!isRecord(parsed)) {
        throw new Error(`${label} must be an object.`);
      }
      return parsed;
    },
  };
}

export function arrayInput(options = {}) {
  return {
    optional: options.optional === true || options.default !== undefined,
    parse(value, label) {
      const parsed = jsonInput(options).parse(value, label);
      if (parsed === undefined) {
        return undefined;
      }
      if (!Array.isArray(parsed)) {
        throw new Error(`${label} must be an array.`);
      }
      return parsed;
    },
  };
}

export function rawInput(options = {}) {
  return {
    optional: options.optional === true,
    parse(value, label) {
      if (value === undefined && options.optional !== true) {
        throw new Error(`${label} is required.`);
      }
      return value;
    },
  };
}

export function unwrapArtifactData(value, label) {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return isRecord(value.data) ? value.data : value;
}

export function prune(value) {
  if (Array.isArray(value)) {
    const items = value
      .map((entry) => prune(entry))
      .filter((entry) => entry !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (!isRecord(value)) {
    return value === undefined ? undefined : value;
  }
  const entries = Object.entries(value)
    .map(([key, nested]) => [key, prune(nested)])
    .filter(([, nested]) => nested !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

export function parseJsonObject(value, fallback = {}) {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = JSON.parse(value);
    if (isRecord(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

export function resolveRepoRoot(inputs = {}, env = process.env) {
  return path.resolve(
    String(
      inputs.repo_root ||
        inputs.project ||
        inputs.fixture ||
        env.RUNX_CWD ||
        process.cwd(),
    ),
  );
}

export function resolveInsideRepo(repoRoot, targetPath) {
  const resolvedPath = path.resolve(repoRoot, targetPath);
  if (
    !resolvedPath.startsWith(`${repoRoot}${path.sep}`) &&
    resolvedPath !== repoRoot
  ) {
    throw new Error(`path escapes repo_root: ${targetPath}`);
  }
  return resolvedPath;
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInputs(raw) {
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("RUNX_INPUTS_JSON must be a JSON object.");
  }
  return parsed;
}

function materializeInputs(spec, rawInputs, toolName) {
  const resolved = {};
  for (const [key, parser] of Object.entries(spec)) {
    if (!parser || typeof parser.parse !== "function") {
      throw new Error(
        `${formatInputLabel(toolName, key)} is missing a parser.`,
      );
    }
    const value = parser.parse(rawInputs[key], formatInputLabel(toolName, key));
    if (value !== undefined) {
      resolved[key] = value;
    }
  }
  for (const [key, value] of Object.entries(rawInputs)) {
    if (!(key in resolved) && !(key in spec)) {
      resolved[key] = value;
    }
  }
  return resolved;
}

function formatInputLabel(toolName, key) {
  return toolName ? `Tool '${toolName}' input '${key}'` : `Tool input '${key}'`;
}

function finalizeOutput(output, definition) {
  if (isToolFailure(output)) {
    return {
      ...output,
      output: finalizeOutput(output.output, definition),
    };
  }
  const envelope =
    definition.schema && isRecord(output) && output.schema === undefined
      ? { schema: definition.schema, ...output }
      : output;
  return definition.prune === false ? envelope : prune(envelope);
}

function isToolFailure(value) {
  return isRecord(value) && value[failureMarker] === true;
}

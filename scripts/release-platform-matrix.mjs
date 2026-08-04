import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const topology = JSON.parse(
  readFileSync(path.join(workspaceRoot, "packages", "cli", "native", "supported-platforms.json"), "utf8"),
);
if (topology.schema !== "runx.rust_cli_selector_topology.v1") {
  throw new Error("release platform topology has an unsupported schema");
}

const include = Object.entries(topology.nativePackages).map(([platform, entry]) => {
  for (const field of ["runner", "rustTarget", "archiveExtension", "binary", "worker"]) {
    if (typeof entry[field] !== "string" || entry[field].trim() === "") {
      throw new Error(`release platform ${platform} is missing ${field}`);
    }
  }
  return {
    platform,
    runner: entry.runner,
    target: entry.rustTarget,
    ext: entry.archiveExtension,
    binary: path.posix.basename(entry.binary),
    worker: path.posix.basename(entry.worker),
  };
});

process.stdout.write(`${JSON.stringify({ include })}\n`);

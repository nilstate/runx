#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const command = argv[0] || "";
const taskId = argv[1] || "";
const cwd = process.cwd();
const draftPath = path.join(cwd, ".scafld", "specs", "drafts", `${taskId}.md`);

switch (command) {
  case "plan":
    requireTask();
    mkdirSync(path.dirname(draftPath), { recursive: true });
    writeFileSync(draftPath, `---\nspec_version: "2.0"\ntask_id: ${taskId}\nstatus: draft\n---\n# ${taskId}\n`, "utf8");
    emit({
      ok: true,
      command,
      result: {
        task_id: taskId,
        path: relativeToCwd(draftPath),
        status: "draft",
      },
    });
    break;
  case "status":
    requireTask();
    emit({
      ok: true,
      command,
      result: {
        task_id: taskId,
        status: "draft",
        title: taskId,
        next: `scafld approve ${taskId}`,
        session_ok: false,
      },
    });
    break;
  default:
    process.stderr.write(`unsupported command: ${command}\n`);
    process.exit(1);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function requireTask() {
  if (!taskId) {
    throw new Error("task_id is required");
  }
}

function relativeToCwd(targetPath) {
  return path.relative(cwd, targetPath);
}

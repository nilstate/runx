#!/usr/bin/env node
import { checkRunxGhcrAnonymousAccess } from "./lib/runx-cli-release-evidence.mjs";

const version = process.env.RUNX_RELEASE_VERSION?.trim();
const deadline = Date.now() + (version ? 60_000 : 0);
let result;
do {
  result = await checkRunxGhcrAnonymousAccess({ version });
  if (result.status === "passed" || Date.now() >= deadline) break;
  await new Promise((resolve) => setTimeout(resolve, 5_000));
} while (true);

process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status !== "passed") {
  process.exitCode = 1;
}

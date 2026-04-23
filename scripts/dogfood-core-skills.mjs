#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const steps = [
  {
    label: "build workspace packages",
    command: "pnpm",
    args: ["build"],
  },
  {
    label: "run workspace doctor",
    command: "pnpm",
    args: ["exec", "tsx", "packages/cli/src/index.ts", "doctor", "--json"],
  },
  {
    label: "prove official skills with a fresh caller",
    command: "pnpm",
    args: ["exec", "vitest", "run", "tests/external-skill-proving-ground.test.ts"],
  },
];

for (const step of steps) {
  process.stdout.write(`\n[dogfood] ${step.label}\n`);
  const result = spawnSync(step.command, step.args, {
    stdio: "inherit",
    shell: false,
    env: process.env,
  });
  if (result.status === 0) {
    continue;
  }
  process.exit(result.status ?? 1);
}

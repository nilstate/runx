import fs from "node:fs";

import { planTransition } from "../state.mjs";

const inputs = readInputs();
const transition = planTransition({
  operation: inputs.operation,
  expectedVersion: inputs.expected_version,
  observedAt: inputs.observed_at,
  scan: inputs.scan,
  messages: inputs.messages,
  currentAction: inputs.current_action,
  message: inputs.message,
  triage: inputs.triage,
  disposition: inputs.disposition,
  action: inputs.action,
});

process.stdout.write(`${JSON.stringify({ transition }, null, 2)}\n`);

function readInputs() {
  const raw = process.env.RUNX_INPUTS_PATH
    ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
    : process.env.RUNX_INPUTS_JSON || "{}";
  return JSON.parse(raw);
}

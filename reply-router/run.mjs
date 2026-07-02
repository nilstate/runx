import { readFileSync } from "node:fs";
import { classify } from "./classify.mjs";

const raw = process.env.RUNX_INPUTS_PATH
  ? readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
  : process.env.RUNX_INPUTS_JSON || "{}";

const inputs = JSON.parse(raw);

const result = await classify(
  inputs.inbound_reply,
  inputs.original_send_receipt,
  inputs.suppression_policy,
);

console.log(JSON.stringify({ decision: result }));

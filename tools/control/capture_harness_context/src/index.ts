import { defineTool, isRecord, prune, recordInput } from "@runxhq/authoring";

export default defineTool({
  name: "control.capture_harness_context",
  description: "Capture the current harness context as explicit graph context values.",
  inputs: {
    harness: recordInput({ optional: true, description: "Optional runx.harness.v1 packet for the current governed run." }),
    signal: recordInput({ optional: true, description: "Optional runx.signal.v1 packet that opened or informed the harness." }),
    decision: recordInput({ optional: true, description: "Optional runx.decision.v1 packet that selected the next harness action." }),
  },
  scopes: ["runx:control:read"],
  output: {
    named_emits: {
      harness_context: "runx.control.harness_context.v1",
    },
  },
  run({ inputs }) {
    const harness = isRecord(inputs.harness) ? inputs.harness : undefined;
    const signal = isRecord(inputs.signal) ? inputs.signal : undefined;
    const decision = isRecord(inputs.decision) ? inputs.decision : undefined;
    const harnessContext = prune({
      captured: Boolean(harness || signal || decision),
      harness,
      signal,
      decision,
    });
    return {
      present: Boolean(harness || signal || decision),
      harness,
      signal,
      decision,
      harness_context: harnessContext,
    };
  },
});

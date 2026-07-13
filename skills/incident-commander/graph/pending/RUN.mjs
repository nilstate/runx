import fs from "node:fs";

const raw = process.env.RUNX_INPUTS_PATH
  ? fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8")
  : process.env.RUNX_INPUTS_JSON || "{}";
const inputs = JSON.parse(raw);
const state = inputs.case_state ?? {};

if (inputs.incident_objective !== "send") {
  process.stdout.write(
    `${JSON.stringify({
      incident_turn: {
        schema: "runx.incident.turn.v1",
        status: "not_applicable",
        case_id: inputs.case_id,
        turn: Number.isInteger(state.turn) ? state.turn : 0,
        dispatch: null,
        escalation: null,
        named_run: null,
        reason: "no pending communications phase for this objective",
      },
    })}\n`,
  );
  process.exit(0);
}

const pending = state.pending_escalation ?? {};
const handoff = pending.proposed_handoff ?? {};
const valid =
  state.declared === true &&
  pending.status === "awaiting_approval" &&
  pending.lane === "human:incident-reviewer" &&
  ["send-as", "slack-notify"].includes(handoff.skill) &&
  (handoff.runner ?? "plan") === "plan" &&
  handoff.principal &&
  handoff.channel &&
  handoff.audience &&
  /^sha256:[0-9a-f]{64}$/i.test(handoff.content_digest ?? "");

const incidentTurn = valid
  ? {
      schema: "runx.incident.turn.v1",
      status: "awaiting_approval",
      case_id: inputs.case_id,
      turn: Number.isInteger(state.turn) ? state.turn : 0,
      dispatch: null,
      escalation: {
        lane: "human:incident-reviewer",
        reason: pending.reason ?? "communications handoff requires roster-matched approval",
      },
      named_run: {
        skill: handoff.skill,
        runner: "plan",
        executable: false,
        data: {
          principal: handoff.principal,
          channel: handoff.channel,
          audience: handoff.audience,
          content_digest: handoff.content_digest,
        },
      },
      reason: "proposed communications handoff is bound but has no execution authority",
    }
  : {
      schema: "runx.incident.turn.v1",
      status: "refused",
      case_id: inputs.case_id,
      turn: Number.isInteger(state.turn) ? state.turn : 0,
      dispatch: null,
      escalation: { lane: "human:incident-reviewer", reason: "invalid pending communications state" },
      named_run: null,
      reason: "send requires a declared, digest-bound pending handoff in the incident-reviewer lane",
    };

process.stdout.write(`${JSON.stringify({ incident_turn: incidentTurn }, null, 2)}\n`);

const inputs = JSON.parse(process.env.RUNX_INPUTS_JSON || "{}");
const explicitProjections = Array.isArray(inputs.explicit_reflect_projections)
  ? inputs.explicit_reflect_projections
  : undefined;
const skillFilter = typeof inputs.skill_filter === "string" && inputs.skill_filter.trim()
  ? inputs.skill_filter.trim()
  : undefined;
const sinceMs = typeof inputs.since === "string" && inputs.since.trim()
  ? Date.parse(inputs.since)
  : undefined;

const storedRows = Array.isArray(inputs.stored_reflect_projections?.rows)
  ? inputs.stored_reflect_projections.rows
  : [];
const projections = explicitProjections ?? storedRows.map((row) =>
  row?.event?.projection
  ?? row?.event?.payload?.projection
  ?? row?.event,
).filter(Boolean);

const filteredProjections = projections
  .filter((entry) => entry && entry.entry_kind === "projection" && entry.scope === "reflect")
  .filter((entry) => !skillFilter || entry?.value?.skill_ref === skillFilter)
  .filter((entry) => {
    if (sinceMs === undefined) {
      return true;
    }
    const createdAt = typeof entry.created_at === "string" ? Date.parse(entry.created_at) : NaN;
    return Number.isFinite(createdAt) && createdAt >= sinceMs;
  });

process.stdout.write(JSON.stringify({
  reflect_projections_packet: {
    items: filteredProjections,
  },
}));

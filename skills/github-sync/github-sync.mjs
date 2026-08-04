export default function planSync(inputs) {
  const { repo, direction, scope, resources } = inputs;
  const blockers = [];
  const filters = { ...(resources.filters ?? {}), limit: resources.filters?.limit ?? 30 };
  const refs = resources.refs ?? [];
  const mutations = resources.mutations ?? [];

  let mutation = null;
  if (direction === "push") {
    if (mutations.length === 1) mutation = mutations[0];
    else blockers.push("push requires exactly one typed mutation");
  } else if (mutations.length > 0) {
    blockers.push("pull does not accept mutations");
  }

  let decision = blockers.length === 0 ? "ready" : "blocked";
  if (direction === "push" && scope !== "write") {
    blockers.push("push requires requested write scope");
    decision = "refused";
  } else if (direction === "pull" && scope !== "read") {
    blockers.push("pull requires requested read scope");
    decision = "refused";
  } else if (blockers.length === 0 && direction === "push") {
    decision = "ready_for_approval";
  }

  const providerOperation = {
    issues: direction === "push" ? "issues.write" : "issues.read",
    prs: direction === "push" ? "pullrequests.write" : "pullrequests.read",
    threads: direction === "push" ? "threads.write" : "threads.read",
  }[resources.kind];

  return {
    sync_plan: {
      decision,
      repo,
      direction,
      resource_selector: { kind: resources.kind, filters, refs },
      resources_touched: [],
      mutation,
      diff_summary: mutation
        ? [{ ref: mutation.ref, op: mutation.op, fields: Object.keys(mutation.payload).sort() }]
        : [],
      provider_operation: providerOperation,
      scope_used: direction === "push" ? "repo.write" : "repo.read",
      gates: { approval_required: direction === "push", approval_ref: "" },
      provider_status: "not_called",
      blockers,
    },
  };
}

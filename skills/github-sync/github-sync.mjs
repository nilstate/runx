export default function planSync(inputs) {
  const { repo, direction, scope, resources } = inputs;
  const blockers = [];
  const filters = { ...(resources.filters ?? {}), limit: resources.filters?.limit ?? 30 };
  const refs = resources.refs ?? [];
  const mutations = resources.mutations ?? [];

  let mutation = null;
  if (direction === "push") {
    if (mutations.length >= 1 && mutations.length <= 8) mutation = mutations[0];
    else blockers.push("push requires 1 to 8 typed mutations");
    if (resources.kind === "batch" && mutations.length === 0) blockers.push("batch push requires at least one mutation");
  } else if (mutations.length > 0) {
    blockers.push("pull does not accept mutations");
  } else if (resources.kind === "batch") {
    blockers.push("batch resources are only valid for push");
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

  const providerOperation = direction === "push"
    ? (resources.kind === "batch" || mutations.length > 1
      ? "sync.write_batch"
      : {
        issues: "issues.write",
        prs: "pullrequests.write",
        threads: "threads.write",
      }[resources.kind])
    : {
      issues: "issues.read",
      prs: "pullrequests.read",
      threads: "threads.read",
      batch: "sync.read",
    }[resources.kind];

  return {
    sync_plan: {
      decision,
      repo,
      direction,
      resource_selector: {
        kind: resources.kind,
        filters,
        refs,
        include_body: resources.include_body === true,
      },
      resources_touched: [],
      mutation,
      mutations,
      diff_summary: mutations.map((entry) => ({
        ref: entry.ref,
        op: entry.op,
        fields: Object.keys(entry.payload).sort(),
      })),
      provider_operation: providerOperation,
      scope_used: direction === "push" ? "repo.write" : "repo.read",
      gates: { approval_required: direction === "push", approval_ref: "" },
      provider_status: "not_called",
      blockers,
    },
  };
}

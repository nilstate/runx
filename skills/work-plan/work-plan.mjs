export default function validateWorkPlan(inputs) {
  const catalogNames = new Set(records(inputs.catalog_skills).map((entry) => optionalString(entry.name)).filter(Boolean));
  const findings = [];
  const draft = record(inputs.work_plan_draft);
  let normalized = emptyPlan();

  try {
    normalized = validateDraft(draft, { inputs, findings, catalogNames });
  } catch (error) {
    findings.push({
      code: "draft.invalid_shape",
      path: "work_plan_draft",
      message: boundedMessage(error),
    });
  }

  if (normalized.open_questions.length > 0) {
    findings.push({
      code: "plan.open_questions",
      path: "open_questions",
      message: "Blocking questions must be resolved before a plan is ready.",
    });
  }

  const ready = draft.decision === "ready" && findings.length === 0;
  return {
    decision: ready ? "ready" : "blocked",
    plan_kind: normalized.plan_kind,
    change_set: normalized.change_set,
    harness_context: isRecord(inputs.harness_context) ? inputs.harness_context : {},
    objective_summary: normalized.objective_summary,
    workspace_change_plan: ready ? normalized.workspace_change_plan : {},
    orchestration_steps: ready ? normalized.orchestration_steps : [],
    required_skills: normalized.required_skills,
    open_questions: normalized.open_questions,
    evidence: {
      source_change_set_preserved: normalized.source_change_set_preserved,
      source_thread_locator_preserved: normalized.source_thread_locator_preserved,
      catalog_skills: normalized.catalog_skills,
    },
    validation: {
      status: ready ? "pass" : "hold",
      findings,
    },
  };
}

function validateDraft(value, state) {
  const { inputs, findings, catalogNames } = state;
  const objective = requiredString(inputs.objective, "objective");
  const decision = enumValue(value.decision, ["ready", "blocked"], "decision");
  const planKind = enumValue(value.plan_kind, ["workspace_change", "skill_package"], "plan_kind");
  const changeSet = requiredRecord(value.change_set, "change_set");
  const suppliedChangeSet = isRecord(inputs.change_set) ? inputs.change_set : null;
  const sourceChangeSetPreserved = suppliedChangeSet ? equalJson(changeSet, suppliedChangeSet) : false;
  if (suppliedChangeSet && !sourceChangeSetPreserved) {
    findings.push({ code: "change_set.drift", path: "change_set", message: "A supplied issue-intake change set must be preserved exactly." });
  }
  if (suppliedChangeSet && suppliedChangeSet.action_decision !== "proceed_to_plan") {
    findings.push({ code: "change_set.not_plannable", path: "change_set.action_decision", message: "The supplied change set does not authorize a planning lane." });
  }
  if (suppliedChangeSet && suppliedChangeSet.commence_decision !== "approve") {
    findings.push({ code: "change_set.not_commenced", path: "change_set.commence_decision", message: "The supplied change set has not approved commencement." });
  }

  const inputThread = optionalString(inputs.thread_locator);
  const changeSetThread = optionalString(changeSet.thread_locator);
  const sourceThreadLocatorPreserved = !inputThread || inputThread === changeSetThread;
  if (!sourceThreadLocatorPreserved) {
    findings.push({ code: "thread_locator.drift", path: "change_set.thread_locator", message: "The source thread locator changed during planning." });
  }

  const objectiveSummary = requiredString(value.objective_summary, "objective_summary");
  const plan = validateWorkspacePlan(value.workspace_change_plan, changeSet, objectiveSummary, findings);
  const requiredSkills = validateRequiredSkills(value.required_skills, catalogNames, findings);
  const steps = validateOrchestration(value.orchestration_steps, requiredSkills, catalogNames, findings);
  if (planKind === "skill_package" && !steps.some((step) => normalizedSkillName(step.skill) === "skill-lab")) {
    findings.push({ code: "skill_package.skill_lab_required", path: "orchestration_steps", message: "Runx skill-package authoring must use the canonical skill-lab lane." });
  }

  const openQuestions = strings(value.open_questions, "open_questions");
  if (!equalJson(openQuestions, plan.open_questions)) {
    findings.push({ code: "open_questions.drift", path: "open_questions", message: "Top-level and workspace-plan open questions must match." });
  }
  if (decision === "blocked" && openQuestions.length === 0) {
    findings.push({ code: "blocked.reason_missing", path: "open_questions", message: "A blocked plan must name the question that prevents readiness." });
  }

  return {
    plan_kind: planKind,
    change_set: changeSet,
    objective_summary: objectiveSummary,
    workspace_change_plan: plan,
    orchestration_steps: steps,
    required_skills: requiredSkills,
    open_questions: openQuestions,
    source_change_set_preserved: suppliedChangeSet ? sourceChangeSetPreserved : false,
    source_thread_locator_preserved: sourceThreadLocatorPreserved,
    catalog_skills: [...new Set(steps.map((step) => normalizedSkillName(step.skill)).filter((name) => name && name !== "approval"))].sort(),
    objective,
  };
}

function validateWorkspacePlan(value, changeSet, objectiveSummary, findings) {
  const plan = requiredRecord(value, "workspace_change_plan");
  requiredString(plan.plan_id, "workspace_change_plan.plan_id");
  const changeSetId = requiredString(changeSet.change_set_id, "change_set.change_set_id");
  if (requiredString(plan.change_set_id, "workspace_change_plan.change_set_id") !== changeSetId) {
    findings.push({ code: "plan.change_set_mismatch", path: "workspace_change_plan.change_set_id", message: "The workspace plan must bind to the parent change set." });
  }
  if (requiredString(plan.objective_summary, "workspace_change_plan.objective_summary") !== objectiveSummary) {
    findings.push({ code: "plan.objective_mismatch", path: "workspace_change_plan.objective_summary", message: "The workspace plan objective must match the top-level summary." });
  }
  const invariants = strings(plan.shared_invariants, "workspace_change_plan.shared_invariants");
  const criteria = strings(plan.success_criteria, "workspace_change_plan.success_criteria");
  if (!equalJson(invariants, strings(changeSet.shared_invariants, "change_set.shared_invariants"))) {
    findings.push({ code: "plan.invariants_drift", path: "workspace_change_plan.shared_invariants", message: "The plan changed the parent invariants." });
  }
  if (!equalJson(criteria, strings(changeSet.success_criteria, "change_set.success_criteria"))) {
    findings.push({ code: "plan.criteria_drift", path: "workspace_change_plan.success_criteria", message: "The plan changed the parent success criteria." });
  }

  const phases = records(plan.phases, "workspace_change_plan.phases");
  const phaseIds = new Set();
  const requestIds = new Set();
  for (const [phaseIndex, phase] of phases.entries()) {
    const phasePath = `workspace_change_plan.phases[${phaseIndex}]`;
    const id = identifier(phase.id, `${phasePath}.id`);
    if (phaseIds.has(id)) findings.push({ code: "phase.duplicate_id", path: `${phasePath}.id`, message: "Phase ids must be unique." });
    for (const [dependencyIndex, dependency] of strings(phase.depends_on, `${phasePath}.depends_on`).entries()) {
      if (!phaseIds.has(dependency)) findings.push({ code: "phase.unknown_dependency", path: `${phasePath}.depends_on[${dependencyIndex}]`, message: "A phase may depend only on an earlier phase." });
    }
    phaseIds.add(id);
    requiredString(phase.name, `${phasePath}.name`);
    requiredBoolean(phase.parallelizable, `${phasePath}.parallelizable`);
    const repos = new Set();
    for (const [requestIndex, request] of records(phase.repo_change_requests, `${phasePath}.repo_change_requests`).entries()) {
      const requestPath = `${phasePath}.repo_change_requests[${requestIndex}]`;
      const requestId = identifier(request.id, `${requestPath}.id`);
      if (requestIds.has(requestId)) findings.push({ code: "repo_request.duplicate_id", path: `${requestPath}.id`, message: "Repo request ids must be unique across the plan." });
      for (const [dependencyIndex, dependency] of strings(request.depends_on, `${requestPath}.depends_on`).entries()) {
        if (!requestIds.has(dependency)) findings.push({ code: "repo_request.unknown_dependency", path: `${requestPath}.depends_on[${dependencyIndex}]`, message: "A repo request may depend only on an earlier request." });
      }
      const repo = requiredString(request.repo, `${requestPath}.repo`);
      requiredString(request.task_id, `${requestPath}.task_id`);
      requiredString(request.objective, `${requestPath}.objective`);
      strings(request.shared_context_refs, `${requestPath}.shared_context_refs`);
      strings(request.validation_commands, `${requestPath}.validation_commands`);
      const mutating = requiredBoolean(request.mutating, `${requestPath}.mutating`);
      if (phase.parallelizable === true && mutating && repos.has(repo)) {
        findings.push({ code: "phase.shared_mutation_target", path: requestPath, message: "Parallel requests may not mutate the same repo." });
      }
      if (mutating) repos.add(repo);
      requestIds.add(requestId);
    }
  }
  if (phases.length === 0) findings.push({ code: "plan.phases_empty", path: "workspace_change_plan.phases", message: "A ready plan needs at least one phase." });

  const integrationChecks = strings(plan.integration_checks, "workspace_change_plan.integration_checks");
  if (integrationChecks.length === 0) findings.push({ code: "plan.integration_checks_empty", path: "workspace_change_plan.integration_checks", message: "A ready plan needs at least one integration check." });
  return {
    ...plan,
    shared_invariants: invariants,
    success_criteria: criteria,
    phases,
    integration_checks: integrationChecks,
    open_questions: strings(plan.open_questions, "workspace_change_plan.open_questions"),
  };
}

function validateRequiredSkills(value, catalogNames, findings) {
  return records(value, "required_skills").map((entry, index) => {
    const name = normalizedSkillName(requiredString(entry.name, `required_skills[${index}].name`));
    const exists = requiredBoolean(entry.exists, `required_skills[${index}].exists`);
    const actual = catalogNames.has(name);
    if (exists !== actual) findings.push({ code: "catalog.existence_mismatch", path: `required_skills[${index}].exists`, message: "The declared skill existence does not match the local catalog." });
    return { name, exists };
  });
}

function validateOrchestration(value, requiredSkills, catalogNames, findings) {
  const requiredNames = new Set(requiredSkills.map((entry) => entry.name));
  const seen = new Set();
  return records(value, "orchestration_steps").map((step, index) => {
    const stepPath = `orchestration_steps[${index}]`;
    const id = identifier(step.id, `${stepPath}.id`);
    if (seen.has(id)) findings.push({ code: "step.duplicate_id", path: `${stepPath}.id`, message: "Orchestration step ids must be unique." });
    const skill = requiredString(step.skill, `${stepPath}.skill`);
    const skillName = normalizedSkillName(skill);
    if (skillName !== "approval" && !catalogNames.has(skillName)) findings.push({ code: "catalog.unknown_skill", path: `${stepPath}.skill`, message: "The referenced skill is absent from the local catalog." });
    if (skillName !== "approval" && !requiredNames.has(skillName)) findings.push({ code: "catalog.undeclared_skill", path: `${stepPath}.skill`, message: "Every referenced skill must appear in required_skills." });
    const scopes = strings(step.scopes, `${stepPath}.scopes`);
    const mutating = requiredBoolean(step.mutating, `${stepPath}.mutating`);
    if (mutating && scopes.length === 0) findings.push({ code: "step.mutation_scope_missing", path: `${stepPath}.scopes`, message: "A future mutating step must declare its required scopes." });
    for (const [referenceIndex, reference] of strings(step.context_from, `${stepPath}.context_from`).entries()) {
      const source = reference.split(".", 1)[0];
      if (!new Set(["change_set", "thread", "input"]).has(source) && !seen.has(source)) {
        findings.push({ code: "step.unknown_context_source", path: `${stepPath}.context_from[${referenceIndex}]`, message: "Context may reference only inputs or an earlier step." });
      }
    }
    seen.add(id);
    return {
      id,
      skill,
      scopes,
      mutating,
      inputs: record(step.inputs),
      context_from: strings(step.context_from, `${stepPath}.context_from`),
      description: requiredString(step.description, `${stepPath}.description`),
    };
  });
}

function emptyPlan() {
  return {
    plan_kind: "workspace_change",
    change_set: {},
    objective_summary: "",
    workspace_change_plan: {},
    orchestration_steps: [],
    required_skills: [],
    open_questions: [],
    source_change_set_preserved: false,
    source_thread_locator_preserved: false,
    catalog_skills: [],
  };
}

function normalizedSkillName(value) {
  return String(value || "").trim().replace(/^\.\.\//u, "").replace(/^skills\//u, "").split("/").at(-1);
}

function identifier(value, field) {
  const parsed = requiredString(value, field);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(parsed)) throw new Error(`${field} must be kebab-case`);
  return parsed;
}

function strings(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => requiredString(entry, `${field}[${index}]`));
}

function records(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => requiredRecord(entry, `${field}[${index}]`));
}

function requiredBoolean(value, field) {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}

function enumValue(value, allowed, field) {
  if (!allowed.includes(value)) throw new Error(`${field} must be one of ${allowed.join(", ")}`);
  return value;
}

function requiredString(value, field) {
  const parsed = optionalString(value);
  if (!parsed) throw new Error(`${field} must be a non-empty string`);
  return parsed;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function record(value) {
  return isRecord(value) ? value : {};
}

function requiredRecord(value, field) {
  const parsed = record(value);
  if (Object.keys(parsed).length === 0) throw new Error(`${field} must be a non-empty object`);
  return parsed;
}

function boundedMessage(error) {
  return (error instanceof Error ? error.message : "Invalid work plan").replace(/\s+/gu, " ").slice(0, 180);
}

function equalJson(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => equalJson(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && equalJson(left[key], right[key]));
}

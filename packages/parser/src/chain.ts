import { parseDocument } from "yaml";

export interface RawChainIR {
  readonly document: Record<string, unknown>;
}

export interface ChainContextEdge {
  readonly input: string;
  readonly fromStep: string;
  readonly output: string;
}

export interface ChainRetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs?: number;
}

export type FanoutSyncStrategy = "all" | "any" | "quorum";
export type FanoutBranchFailurePolicy = "halt" | "continue";
export type FanoutThresholdAction = "pause" | "escalate";

export interface FanoutThresholdGate {
  readonly step: string;
  readonly field: string;
  readonly above: number;
  readonly action: FanoutThresholdAction;
}

export type FanoutConflictAction = "pause" | "escalate";

export interface FanoutConflictGate {
  readonly field: string;
  readonly steps: readonly string[];
  readonly action: FanoutConflictAction;
}

export interface FanoutGroupPolicy {
  readonly groupId: string;
  readonly strategy: FanoutSyncStrategy;
  readonly minSuccess?: number;
  readonly onBranchFailure: FanoutBranchFailurePolicy;
  readonly thresholdGates: readonly FanoutThresholdGate[];
  readonly conflictGates: readonly FanoutConflictGate[];
}

export interface ChainTransitionGate {
  readonly to: string;
  readonly field: string;
  readonly equals?: unknown;
  readonly notEquals?: unknown;
}

export interface ChainPolicy {
  readonly transitions: readonly ChainTransitionGate[];
}

export interface ChainStep {
  readonly id: string;
  readonly label?: string;
  readonly skill?: string;
  readonly tool?: string;
  readonly run?: Readonly<Record<string, unknown>>;
  readonly instructions?: string;
  readonly artifacts?: Readonly<Record<string, unknown>>;
  readonly runner?: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly context: Readonly<Record<string, string>>;
  readonly contextEdges: readonly ChainContextEdge[];
  readonly scopes: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly retry?: ChainRetryPolicy;
  readonly policy?: Readonly<Record<string, unknown>>;
  readonly fanoutGroup?: string;
  readonly mutating: boolean;
  readonly idempotencyKey?: string;
}

export interface ChainDefinition {
  readonly name: string;
  readonly owner?: string;
  readonly steps: readonly ChainStep[];
  readonly fanoutGroups: Readonly<Record<string, FanoutGroupPolicy>>;
  readonly policy?: ChainPolicy;
  readonly raw: RawChainIR;
}

export class ChainParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainParseError";
  }
}

export class ChainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainValidationError";
  }
}

export function parseChainYaml(source: string): RawChainIR {
  const document = parseDocument(source, { prettyErrors: false });
  if (document.errors.length > 0) {
    throw new ChainParseError(document.errors.map((error) => error.message).join("; "));
  }

  const parsed = document.toJS() as unknown;
  if (!isRecord(parsed)) {
    throw new ChainParseError("Chain YAML must parse to an object.");
  }

  return {
    document: parsed,
  };
}

export function validateChain(raw: RawChainIR): ChainDefinition {
  return validateChainDocument(raw.document, raw);
}

export function validateChainDocument(document: Record<string, unknown>, raw?: RawChainIR): ChainDefinition {
  rejectUnsupportedTopLevel(document);

  const name = requiredString(document.name, "name");
  const owner = optionalString(document.owner, "owner");
  const rawSteps = requiredArray(document.steps, "steps");
  const fanoutGroups = validateFanoutGroups(document.fanout, "fanout");
  const policy = validateChainPolicy(document.policy, "policy");
  const seenStepIds = new Set<string>();
  const steps: ChainStep[] = [];

  for (let index = 0; index < rawSteps.length; index += 1) {
    const field = `steps.${index}`;
    const rawStep = requiredRecord(rawSteps[index], field);
    const step = validateStep(rawStep, field, seenStepIds);
    seenStepIds.add(step.id);
    steps.push(step);
  }

  validateFanoutStepBindings(steps, fanoutGroups);

  return {
    name,
    owner,
    steps,
    fanoutGroups,
    policy,
    raw: raw ?? { document },
  };
}

function validateStep(
  rawStep: Record<string, unknown>,
  field: string,
  previousStepIds: ReadonlySet<string>,
): ChainStep {
  rejectUnsupportedStepFields(rawStep, field);

  const id = requiredString(rawStep.id, `${field}.id`);
  if (previousStepIds.has(id)) {
    throw new ChainValidationError(`${field}.id '${id}' must be unique.`);
  }
  const label = optionalNonEmptyString(rawStep.label, `${field}.label`);

  const skill = optionalNonEmptyString(rawStep.skill, `${field}.skill`);
  const tool = optionalNonEmptyString(rawStep.tool, `${field}.tool`);
  const run = optionalRecord(rawStep.run, `${field}.run`);
  if ((skill ? 1 : 0) + (tool ? 1 : 0) + (run ? 1 : 0) !== 1) {
    throw new ChainValidationError(`${field} must declare exactly one of skill, tool, or run.`);
  }
  if (run && typeof run.type !== "string") {
    throw new ChainValidationError(`${field}.run.type is required.`);
  }
  const runner = optionalNonEmptyString(rawStep.runner, `${field}.runner`);
  if ((run || tool) && runner) {
    throw new ChainValidationError(`${field}.runner is only valid for nested skill steps.`);
  }
  const inputs = optionalRecord(rawStep.inputs, `${field}.inputs`) ?? {};
  const context = optionalStringRecord(rawStep.context, `${field}.context`) ?? {};
  const scopes = optionalStringArray(rawStep.scopes, `${field}.scopes`) ?? [];
  const allowedTools = optionalStringArray(rawStep.allowed_tools, `${field}.allowed_tools`);
  const retry = validateRetry(rawStep.retry, `${field}.retry`);
  const policy = optionalRecord(rawStep.policy, `${field}.policy`);
  const fanoutGroup = optionalString(rawStep.fanout_group, `${field}.fanout_group`);
  const mutating = validateMutation(rawStep.mutation, `${field}.mutation`);
  const instructions = optionalString(rawStep.instructions, `${field}.instructions`);
  const artifacts = optionalRecord(rawStep.artifacts, `${field}.artifacts`);
  const idempotencyKey = optionalNonEmptyString(rawStep.idempotency_key, `${field}.idempotency_key`);
  const contextEdges = Object.entries(context).map(([input, reference]) =>
    parseContextReference(input, reference, previousStepIds, `${field}.context.${input}`),
  );

  return {
    id,
    label,
    skill,
    tool,
    run,
    instructions,
    artifacts,
    runner,
    inputs,
    context,
    contextEdges,
    scopes,
    allowedTools,
    retry,
    policy,
    fanoutGroup,
    mutating,
    idempotencyKey,
  };
}

function rejectUnsupportedTopLevel(document: Readonly<Record<string, unknown>>): void {
  for (const field of ["sync", "schedule", "schedules"]) {
    if (document[field] !== undefined) {
      throw new ChainValidationError(`${field} is not supported by the local sequential chain runner.`);
    }
  }
}

function rejectUnsupportedStepFields(rawStep: Readonly<Record<string, unknown>>, field: string): void {
  for (const unsupported of ["sync"]) {
    if (rawStep[unsupported] !== undefined) {
      throw new ChainValidationError(`${field}.${unsupported} is not supported by the local sequential chain runner.`);
    }
  }

  const mode = rawStep.mode;
  if (mode !== undefined && mode !== "sequential" && mode !== "fanout") {
    throw new ChainValidationError(`${field}.mode '${String(mode)}' is not supported by the local chain runner.`);
  }
  if (mode === "fanout" && typeof rawStep.fanout_group !== "string") {
    throw new ChainValidationError(`${field}.fanout_group is required when mode is fanout.`);
  }
  const declaredTargets = [rawStep.run, rawStep.skill, rawStep.tool].filter((value) => value !== undefined).length;
  if (declaredTargets > 1) {
    throw new ChainValidationError(`${field} must not declare more than one of run, skill, or tool.`);
  }
}

function validateFanoutGroups(value: unknown, field: string): Readonly<Record<string, FanoutGroupPolicy>> {
  const fanout = optionalRecord(value, field);
  if (!fanout) {
    return {};
  }
  const groups = requiredRecord(fanout.groups, `${field}.groups`);
  const validated: Record<string, FanoutGroupPolicy> = {};

  for (const [groupId, rawGroup] of Object.entries(groups)) {
    const group = requiredRecord(rawGroup, `${field}.groups.${groupId}`);
    const strategy = optionalSyncStrategy(group.strategy, `${field}.groups.${groupId}.strategy`) ?? "all";
    const minSuccess = optionalNumber(group.min_success, `${field}.groups.${groupId}.min_success`);
    const onBranchFailure =
      optionalBranchFailurePolicy(group.on_branch_failure, `${field}.groups.${groupId}.on_branch_failure`)
      ?? (strategy === "all" ? "halt" : "continue");
    const thresholdGates = validateThresholdGates(group.threshold_gates, `${field}.groups.${groupId}.threshold_gates`);
    const conflictGates = validateConflictGates(group.conflict_gates, `${field}.groups.${groupId}.conflict_gates`);
    if (strategy === "quorum" && (!Number.isInteger(minSuccess) || minSuccess === undefined || minSuccess < 1)) {
      throw new ChainValidationError(`${field}.groups.${groupId}.min_success must be a positive integer for quorum sync.`);
    }
    validated[groupId] = {
      groupId,
      strategy,
      minSuccess,
      onBranchFailure,
      thresholdGates,
      conflictGates,
    };
  }

  return validated;
}

function validateChainPolicy(value: unknown, field: string): ChainPolicy | undefined {
  const policy = optionalRecord(value, field);
  if (!policy) {
    return undefined;
  }
  const transitionsValue = policy.transitions;
  if (transitionsValue === undefined || transitionsValue === null) {
    return undefined;
  }
  const transitions = requiredArray(transitionsValue, `${field}.transitions`).map((rawGate, index) => {
    const gateField = `${field}.transitions.${index}`;
    const gate = requiredRecord(rawGate, gateField);
    const equals = gate.equals;
    const notEquals = gate.not_equals;
    if (equals !== undefined && notEquals !== undefined) {
      throw new ChainValidationError(`${gateField} must not declare both equals and not_equals.`);
    }
    if (equals === undefined && notEquals === undefined) {
      throw new ChainValidationError(`${gateField} must declare equals or not_equals.`);
    }
    return {
      to: requiredString(gate.to, `${gateField}.to`),
      field: requiredString(gate.field, `${gateField}.field`),
      equals,
      notEquals,
    };
  });
  return { transitions };
}

function validateThresholdGates(value: unknown, field: string): readonly FanoutThresholdGate[] {
  if (value === undefined || value === null) {
    return [];
  }
  const gates = requiredArray(value, field);
  return gates.map((rawGate, index) => {
    const gateField = `${field}.${index}`;
    const gate = requiredRecord(rawGate, gateField);
    for (const unsupported of ["contains", "matches", "semantic", "prompt", "sentiment"]) {
      if (gate[unsupported] !== undefined) {
        throw new ChainValidationError(`${gateField}.${unsupported} is not supported; chain policy must evaluate structured fields.`);
      }
    }
    return {
      step: requiredString(gate.step, `${gateField}.step`),
      field: requiredString(gate.field, `${gateField}.field`),
      above: requiredNumber(gate.above, `${gateField}.above`),
      action: requiredThresholdAction(gate.action, `${gateField}.action`),
    };
  });
}

function validateConflictGates(value: unknown, field: string): readonly FanoutConflictGate[] {
  if (value === undefined || value === null) {
    return [];
  }
  const gates = requiredArray(value, field);
  return gates.map((rawGate, index) => {
    const gateField = `${field}.${index}`;
    const gate = requiredRecord(rawGate, gateField);
    for (const unsupported of ["contains", "matches", "semantic", "prompt", "sentiment"]) {
      if (gate[unsupported] !== undefined) {
        throw new ChainValidationError(`${gateField}.${unsupported} is not supported; chain policy must evaluate structured fields.`);
      }
    }
    return {
      field: requiredString(gate.field, `${gateField}.field`),
      steps: optionalStringArray(gate.steps, `${gateField}.steps`) ?? [],
      action: requiredConflictAction(gate.action, `${gateField}.action`),
    };
  });
}

function validateFanoutStepBindings(
  steps: readonly ChainStep[],
  groups: Readonly<Record<string, FanoutGroupPolicy>>,
): void {
  const usedGroups = new Map<string, ChainStep[]>();
  const stepToGroup = new Map<string, string>();

  for (const step of steps) {
    if (!step.fanoutGroup) {
      continue;
    }
    if (!groups[step.fanoutGroup]) {
      throw new ChainValidationError(`steps.${step.id}.fanout_group references unknown fanout group '${step.fanoutGroup}'.`);
    }
    usedGroups.set(step.fanoutGroup, [...(usedGroups.get(step.fanoutGroup) ?? []), step]);
    stepToGroup.set(step.id, step.fanoutGroup);
  }

  for (const groupId of Object.keys(groups)) {
    const groupSteps = usedGroups.get(groupId) ?? [];
    if (groupSteps.length === 0) {
      throw new ChainValidationError(`fanout.groups.${groupId} is not used by any chain step.`);
    }
    const indexes = groupSteps.map((groupStep) => steps.findIndex((step) => step.id === groupStep.id));
    const minIndex = Math.min(...indexes);
    const maxIndex = Math.max(...indexes);
    for (let index = minIndex; index <= maxIndex; index += 1) {
      if (steps[index]?.fanoutGroup !== groupId) {
        throw new ChainValidationError(`fanout group '${groupId}' steps must be contiguous.`);
      }
    }

    const groupPolicy = groups[groupId];
    if (groupPolicy.strategy === "quorum" && groupPolicy.minSuccess !== undefined && groupPolicy.minSuccess > groupSteps.length) {
      throw new ChainValidationError(`fanout.groups.${groupId}.min_success cannot exceed the number of branches.`);
    }

    const groupStepIds = new Set(groupSteps.map((step) => step.id));
    for (const gate of groupPolicy.thresholdGates) {
      if (!groupStepIds.has(gate.step)) {
        throw new ChainValidationError(`fanout.groups.${groupId}.threshold_gates step '${gate.step}' is not in the fanout group.`);
      }
    }
    for (const gate of groupPolicy.conflictGates) {
      for (const stepId of gate.steps) {
        if (!groupStepIds.has(stepId)) {
          throw new ChainValidationError(`fanout.groups.${groupId}.conflict_gates step '${stepId}' is not in the fanout group.`);
        }
      }
    }
  }

  for (const step of steps) {
    if (!step.fanoutGroup) {
      continue;
    }
    for (const edge of step.contextEdges) {
      if (stepToGroup.get(edge.fromStep) === step.fanoutGroup) {
        throw new ChainValidationError(`steps.${step.id}.context.${edge.input} cannot depend on another branch in the same fanout group.`);
      }
    }
  }
}

function parseContextReference(
  input: string,
  reference: string,
  previousStepIds: ReadonlySet<string>,
  field: string,
): ChainContextEdge {
  const dotIndex = reference.indexOf(".");
  if (dotIndex <= 0 || dotIndex === reference.length - 1) {
    throw new ChainValidationError(`${field} must use '<step-id>.<output-field>' syntax.`);
  }

  const fromStep = reference.slice(0, dotIndex);
  const output = reference.slice(dotIndex + 1);
  if (!previousStepIds.has(fromStep)) {
    throw new ChainValidationError(`${field} references unknown or later step '${fromStep}'.`);
  }

  return {
    input,
    fromStep,
    output,
  };
}

function validateRetry(value: unknown, field: string): ChainRetryPolicy | undefined {
  const retry = optionalRecord(value, field);
  if (!retry) {
    return undefined;
  }

  const maxAttempts = optionalNumber(retry.max_attempts, `${field}.max_attempts`) ?? 1;
  const backoffMs = optionalNumber(retry.backoff_ms, `${field}.backoff_ms`);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new ChainValidationError(`${field}.max_attempts must be a positive integer.`);
  }
  if (backoffMs !== undefined && (!Number.isInteger(backoffMs) || backoffMs < 0)) {
    throw new ChainValidationError(`${field}.backoff_ms must be a non-negative integer.`);
  }

  return {
    maxAttempts,
    backoffMs,
  };
}

function validateMutation(value: unknown, field: string): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  throw new ChainValidationError(`${field} must be a boolean.`);
}

function requiredString(value: unknown, field: string): string {
  const stringValue = optionalString(value, field);
  if (!stringValue) {
    throw new ChainValidationError(`${field} is required.`);
  }
  return stringValue;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ChainValidationError(`${field} must be a string.`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  const stringValue = optionalString(value, field);
  if (stringValue !== undefined && stringValue.trim() === "") {
    throw new ChainValidationError(`${field} must not be empty.`);
  }
  return stringValue;
}

function requiredArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ChainValidationError(`${field} must be an array.`);
  }
  if (value.length === 0) {
    throw new ChainValidationError(`${field} must contain at least one step.`);
  }
  return value;
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ChainValidationError(`${field} must be an object.`);
  }
  return value;
}

function optionalRecord(value: unknown, field: string): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ChainValidationError(`${field} must be an object.`);
  }
  return value;
}

function optionalStringRecord(value: unknown, field: string): Readonly<Record<string, string>> | undefined {
  const record = optionalRecord(value, field);
  if (!record) {
    return undefined;
  }

  for (const [key, entryValue] of Object.entries(record)) {
    if (typeof entryValue !== "string") {
      throw new ChainValidationError(`${field}.${key} must be a string.`);
    }
  }
  return record as Readonly<Record<string, string>>;
}

function optionalStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ChainValidationError(`${field} must be an array of strings.`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ChainValidationError(`${field} must be a finite number.`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  const numberValue = optionalNumber(value, field);
  if (numberValue === undefined) {
    throw new ChainValidationError(`${field} is required.`);
  }
  return numberValue;
}

function optionalSyncStrategy(value: unknown, field: string): FanoutSyncStrategy | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "all" || value === "any" || value === "quorum") {
    return value;
  }
  throw new ChainValidationError(`${field} must be all, any, or quorum.`);
}

function optionalBranchFailurePolicy(value: unknown, field: string): FanoutBranchFailurePolicy | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "halt" || value === "continue") {
    return value;
  }
  throw new ChainValidationError(`${field} must be halt or continue.`);
}

function requiredThresholdAction(value: unknown, field: string): FanoutThresholdAction {
  if (value === "pause" || value === "escalate") {
    return value;
  }
  throw new ChainValidationError(`${field} must be pause or escalate.`);
}

function requiredConflictAction(value: unknown, field: string): FanoutConflictAction {
  if (value === "pause" || value === "escalate") {
    return value;
  }
  throw new ChainValidationError(`${field} must be pause or escalate.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

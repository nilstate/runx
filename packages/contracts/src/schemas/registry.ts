import { Type, type Static } from "@sinclair/typebox";
import {
  JSON_SCHEMA_DRAFT_2020_12,
  RUNX_AUXILIARY_SCHEMA_IDS,
  type DeepReadonly,
  stringEnum,
  validateContractSchema,
} from "../internal.js";

const registryBindingStates = [
  "registry_binding_drafted",
  "registry_bound",
  "harness_verified",
  "published",
] as const;
const registryTrustTiers = ["first_party", "verified", "community"] as const;
const harnessStatuses = ["pending", "failed", "harness_verified"] as const;
const reviewReceiptVerdicts = ["pass", "needs_update", "blocked"] as const;

export const registryBindingSchema = Type.Object(
  {
    schema: Type.Literal("runx.registry_binding.v1"),
    state: stringEnum(registryBindingStates),
    skill: Type.Object(
      {
        id: Type.String(),
        name: Type.String(),
        description: Type.String(),
      },
      { additionalProperties: true },
    ),
    upstream: Type.Object(
      {
        host: Type.String(),
        owner: Type.String(),
        repo: Type.String(),
        path: Type.String(),
        branch: Type.Optional(Type.String()),
        commit: Type.String(),
        blob_sha: Type.String(),
        pr_url: Type.Optional(Type.String()),
        merged_at: Type.Optional(Type.String()),
        html_url: Type.Optional(Type.String()),
        raw_url: Type.Optional(Type.String()),
        source_of_truth: Type.Literal(true),
      },
      { additionalProperties: true },
    ),
    registry: Type.Object(
      {
        owner: Type.String(),
        trust_tier: stringEnum(registryTrustTiers),
        version: Type.String(),
        install_command: Type.Optional(Type.String()),
        run_command: Type.Optional(Type.String()),
        profile_path: Type.String(),
        materialized_package_is_registry_artifact: Type.Literal(true),
      },
      { additionalProperties: true },
    ),
    harness: Type.Object(
      {
        status: stringEnum(harnessStatuses),
        case_count: Type.Number(),
        assertion_count: Type.Optional(Type.Number()),
        case_names: Type.Optional(Type.Array(Type.String())),
      },
      { additionalProperties: true },
    ),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_AUXILIARY_SCHEMA_IDS.registryBinding,
    title: "runx upstream registry binding",
    additionalProperties: true,
  },
);

export type RegistryBindingContract = DeepReadonly<Static<typeof registryBindingSchema>>;

export const reviewReceiptOutputSchema = Type.Object(
  {
    verdict: stringEnum(reviewReceiptVerdicts, {
      description: "Overall diagnosis. `pass` means no change needed; `needs_update` means one or more bounded improvements apply; `blocked` means the evidence is insufficient to decide.",
    }),
    failure_summary: Type.String({
      description: "One to three sentences naming the failing step, the failure class, and the root cause. For `pass`, restates why no change is needed.",
    }),
    improvement_proposals: Type.Array(
      Type.Object(
        {
          target: Type.String({
            description: "What to change (e.g., SKILL.md, execution profile, graph step, input, fixture path).",
          }),
          change: Type.String({
            description: "What specifically to change.",
          }),
          rationale: Type.Optional(Type.String({
            description: "Why this fixes the root cause.",
          })),
          risk: Type.Optional(Type.String({
            description: "What could go wrong with the change.",
          })),
        },
        { additionalProperties: true },
      ),
      {
        description: "Bounded changes that would resolve the diagnosed failure. Empty when verdict is `pass`.",
      },
    ),
    next_harness_checks: Type.Array(Type.String(), {
      description: "Replayable checks that should pass after the improvement lands.",
    }),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: RUNX_AUXILIARY_SCHEMA_IDS.reviewReceiptOutput,
    title: "runx review-receipt output",
    description: "Output contract for the review-receipt skill. Produced by the agent-step reviewer and consumed by write-harness downstream of improve-skill.",
    additionalProperties: true,
  },
);

export type ReviewReceiptOutputContract = DeepReadonly<Static<typeof reviewReceiptOutputSchema>>;

export function validateRegistryBindingContract(value: unknown, label = "registry_binding"): RegistryBindingContract {
  return validateContractSchema(registryBindingSchema, value, label);
}

export function validateReviewReceiptOutputContract(
  value: unknown,
  label = "review_receipt_output",
): ReviewReceiptOutputContract {
  return validateContractSchema(reviewReceiptOutputSchema, value, label);
}

import { Type, type Static } from "@sinclair/typebox";

import { type DeepReadonly, validateContractSchema } from "../internal.js";

export const hostedReceiptIndexEntrySchema = Type.Object(
  {
    receipt_id: Type.String({ minLength: 1 }),
    run_id: Type.Optional(Type.String({ minLength: 1 })),
    kind: Type.String({ minLength: 1 }),
    status: Type.String({ minLength: 1 }),
    created_at: Type.String({ minLength: 1 }),
    body_ref: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type HostedReceiptIndexEntryContract = DeepReadonly<Static<typeof hostedReceiptIndexEntrySchema>>;

export const hostedArtifactIndexEntrySchema = Type.Object(
  {
    artifact_id: Type.String({ minLength: 1 }),
    receipt_id: Type.String({ minLength: 1 }),
    run_id: Type.Optional(Type.String({ minLength: 1 })),
    created_at: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type HostedArtifactIndexEntryContract = DeepReadonly<Static<typeof hostedArtifactIndexEntrySchema>>;

export const hostedReceiptManifestSchema = Type.Object(
  {
    receipts: Type.Array(hostedReceiptIndexEntrySchema),
    artifacts: Type.Array(hostedArtifactIndexEntrySchema),
  },
  { additionalProperties: false },
);

export type HostedReceiptManifestContract = DeepReadonly<Static<typeof hostedReceiptManifestSchema>>;

export function validateHostedReceiptManifestContract(
  value: unknown,
  label = "hosted_receipt_manifest",
): HostedReceiptManifestContract {
  return validateContractSchema(hostedReceiptManifestSchema, value, label);
}

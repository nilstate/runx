import {
  type UnknownRecord,
  generatedSchema,
  validateContractSchema,
} from "../internal.js";

// Rust owns both auxiliary wire contracts. This binding deliberately consumes
// generated schemas instead of maintaining a second TypeBox definition.
export type RegistryBindingContract = UnknownRecord;
export type ReviewReceiptOutputContract = UnknownRecord;

export const registryBindingSchema =
  generatedSchema<RegistryBindingContract>("registry-binding.schema.json");

export const reviewReceiptOutputSchema =
  generatedSchema<ReviewReceiptOutputContract>("review-receipt-output.schema.json");

export function validateRegistryBindingContract(value: unknown, label = "registry_binding"): RegistryBindingContract {
  return validateContractSchema(registryBindingSchema, value, label);
}

export function validateReviewReceiptOutputContract(
  value: unknown,
  label = "review_receipt_output",
): ReviewReceiptOutputContract {
  return validateContractSchema(reviewReceiptOutputSchema, value, label);
}

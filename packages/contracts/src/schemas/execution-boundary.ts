import { Type, type Static } from "../internal.js";
import { type DeepReadonly, stringEnum } from "../internal.js";

const executionBoundaryKinds = [
  "trusted_host_process",
  "deterministic_worker",
  "native_capability",
  "remote_provider",
] as const;

export const executionBoundaryObservationSchema = Type.Object(
  {
    kind: stringEnum(executionBoundaryKinds),
  },
  { additionalProperties: false },
);

export type ExecutionBoundaryObservationContract =
  DeepReadonly<Static<typeof executionBoundaryObservationSchema>>;

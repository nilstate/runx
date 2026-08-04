export const extensionSdkPackage = "@runxhq/extension-sdk";

export {
  defineExternalAdapter,
  materializeExternalAdapterInputs,
} from "./external-adapter.js";
export type {
  DefinedExternalAdapter,
  ExternalAdapterDefinition,
  ExternalAdapterHandlerResult,
  ExternalAdapterInvocation,
  ExternalAdapterResponse,
  ExternalAdapterResponseOptions,
  ExternalAdapterStatus,
} from "./external-adapter.js";
export { defineTool, failure } from "./tool.js";
export type {
  DefinedTool,
  ToolDefinition,
  ToolFailure,
  ToolRunContext,
} from "./tool.js";
export { firstNonEmptyString, isRecord, prune } from "./values.js";

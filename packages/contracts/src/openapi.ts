import { buildHostedOpenApiPublicSchemas } from "./openapi-public.js";
import { buildHostedOpenApiRuntimeSchemas } from "./openapi-runtime.js";

export function buildHostedOpenApiSchemas(): Readonly<Record<string, unknown>> {
  return {
    ...buildHostedOpenApiRuntimeSchemas(),
    ...buildHostedOpenApiPublicSchemas(),
  };
}

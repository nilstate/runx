import type { AdapterInvokeRequest, AdapterInvokeResult, SkillAdapter } from "@runxhq/core/executor";
import { errorMessage } from "@runxhq/core/util";
import { resolveCatalogTool } from "@runxhq/runtime-local/tool-catalogs";

export const catalogAdapterPackage = "@runxhq/adapters/catalog";

export interface CatalogAdapter extends SkillAdapter {
  readonly type: "catalog";
}

export function createCatalogAdapter(): CatalogAdapter {
  return {
    type: "catalog",
    invoke: invokeCatalog,
  };
}

export async function invokeCatalog(request: AdapterInvokeRequest): Promise<AdapterInvokeResult> {
  const started = performance.now();
  const catalogRef = request.source.catalogRef;

  if (!catalogRef) {
    return failure("Catalog source requires source.catalog_ref metadata.", started);
  }

  const resolved = await resolveCatalogTool(request.toolCatalogAdapters ?? [], catalogRef, {
    env: request.env,
    searchFromDirectory: request.skillDirectory,
  });
  if (!resolved) {
    return failure(`Imported tool '${catalogRef}' was not found in configured tool catalogs.`, started);
  }

  try {
    const result = await resolved.invoke({
      inputs: request.inputs,
      resolvedInputs: request.resolvedInputs,
      env: request.env,
      signal: request.signal,
      skillDirectory: request.skillDirectory,
      runId: request.runId,
      stepId: request.stepId,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status === "success" ? 0 : null,
      signal: null,
      durationMs: Math.round(performance.now() - started),
      errorMessage: result.status === "failure" ? result.errorMessage ?? result.stderr : undefined,
      metadata: result.metadata,
    };
  } catch (error) {
    return failure(errorMessage(error), started);
  }
}

function failure(message: string, started: number): AdapterInvokeResult {
  return {
    status: "failure",
    stdout: "",
    stderr: message,
    exitCode: null,
    signal: null,
    durationMs: Math.round(performance.now() - started),
    errorMessage: message,
  };
}

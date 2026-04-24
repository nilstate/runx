# @runxhq/langchain

Optional LangChain bridge for `runx`.

- Normalize LangChain JS tools into runx tool catalog entries.
- Wrap governed runx workflows as LangChain-callable tools.

`runx` remains the kernel for policy, receipts, and execution. This package is an ecosystem bridge, not a second runtime.

## APIs

- `createLangChainToolCatalogAdapter(...)`
  Normalize LangChain JS tools into the runx imported-tool catalog model so
  they can be searched, resolved, and executed through governed runx runtime
  paths.
- `createRunxLangChainTool(...)`
  Wrap a governed runx workflow as a LangChain tool without moving execution,
  approvals, or receipts into LangChain.

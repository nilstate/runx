import path from "node:path";

export function defaultReceiptDir(env: NodeJS.ProcessEnv | undefined): string {
  return path.resolve(env?.RUNX_RECEIPT_DIR ?? env?.INIT_CWD ?? process.cwd(), ".runx", "receipts");
}

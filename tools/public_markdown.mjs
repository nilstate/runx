export function sanitizePublicMarkdown(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value)
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|MATERIAL[_-]?REF)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, "$1=[secret]")
    .replace(/\b((?:bearer|authorization|token|secret|password|api[_-]?key|material[_-]?ref|materialRef)\s*[:=]\s*)(["']?)[^\s`),;]+/gi, "$1[secret]")
    .replace(/\b((?:bearer|authorization)\s+)[A-Za-z0-9._:-]{6,}\b/gi, "$1[secret]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, "[secret]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "[secret]")
    .replace(/\b[A-Za-z0-9]+(?:[-_](?:secret|token|password|api[-_]?key))+[A-Za-z0-9_-]*\b(?!\s*=)/gi, "[secret]")
    .replace(/\b([A-Z][A-Z0-9_]*=)(?:\/Users|\/home|\/var|\/private|\/tmp|[A-Za-z]:\\)[^\s`)]+/g, "$1[local-path]")
    .replace(/(^|[\s=("'`])(?:\/Users|\/home|\/var|\/private|\/tmp)\/[^\s`)]+/g, "$1[local-path]")
    .replace(/[A-Za-z]:\\[^\s`)]+/g, "[local-path]");
}

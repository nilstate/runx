export function sanitizePublicMarkdown(value) {
  if (value === undefined) {
    return undefined;
  }
  return String(value)
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, "$1=[secret]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, "[secret]")
    .replace(/\b([A-Z][A-Z0-9_]*=)(?:\/Users|\/home|\/var|\/private|\/tmp|[A-Za-z]:\\)[^\s`)]+/g, "$1[local-path]")
    .replace(/(?:\/Users|\/home|\/var|\/private|\/tmp)\/[^\s`)]+/g, "[local-path]")
    .replace(/[A-Za-z]:\\[^\s`)]+/g, "[local-path]");
}

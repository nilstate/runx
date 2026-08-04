const compiledSourceSuffixes = [
  [".d.ts", [".ts", ".tsx"]],
  [".js.map", [".ts", ".tsx"]],
  [".js", [".ts", ".tsx"]],
  [".d.mts", [".mts"]],
  [".mjs.map", [".mts"]],
  [".mjs", [".mts"]],
  [".d.cts", [".cts"]],
  [".cjs.map", [".cts"]],
  [".cjs", [".cts"]],
];

export function sourceCandidatesForCompiled(relativePath) {
  const normalized = relativePath.split("\\").join("/");
  for (const [suffix, sourceSuffixes] of compiledSourceSuffixes) {
    if (normalized.endsWith(suffix)) {
      const stem = normalized.slice(0, -suffix.length);
      return sourceSuffixes.map((sourceSuffix) => `${stem}${sourceSuffix}`);
    }
  }
  return undefined;
}

export interface UiTheme {
  readonly on: boolean;
  readonly reset: string;
  readonly bold: string;
  readonly dim: string;
  readonly cyan: string;
  readonly magenta: string;
  readonly green: string;
  readonly red: string;
  readonly yellow: string;
  readonly gray: string;
}

function isTtyStream(stream: unknown): boolean {
  return typeof stream === "object" && stream !== null && (stream as { isTTY?: boolean }).isTTY === true;
}

export function theme(stream: NodeJS.WritableStream | undefined = process.stdout, env: NodeJS.ProcessEnv = process.env): UiTheme {
  const on = isTtyStream(stream) && !env.NO_COLOR;
  const code = (seq: string) => (on ? seq : "");
  return {
    on,
    reset: code("\u001b[0m"),
    bold: code("\u001b[1m"),
    dim: code("\u001b[2m"),
    cyan: code("\u001b[38;5;117m"),
    magenta: code("\u001b[38;5;207m"),
    green: code("\u001b[38;5;42m"),
    red: code("\u001b[38;5;203m"),
    yellow: code("\u001b[38;5;221m"),
    gray: code("\u001b[38;5;244m"),
  };
}

export function statusIcon(status: string, t: UiTheme): string {
  if (status === "success" || status === "verified" || status === "installed") return `${t.green}✓${t.reset}`;
  if (status === "failure" || status === "invalid" || status === "denied") return `${t.red}✗${t.reset}`;
  if (status === "needs_resolution") return `${t.yellow}◇${t.reset}`;
  if (status === "unverified" || status === "unchanged") return `${t.dim}·${t.reset}`;
  return `${t.dim}·${t.reset}`;
}

export function renderRows(rows: readonly (readonly [string, string | undefined])[], t: UiTheme): string[] {
  const visible = rows.filter(([, value]) => value !== undefined && value !== "");
  if (visible.length === 0) return [];
  const width = Math.max(...visible.map(([label]) => label.length));
  return visible.map(([label, value]) => `  ${t.dim}${label.padEnd(width)}${t.reset}  ${value}`);
}

export function renderKeyValue(title: string, status: string, rows: readonly (readonly [string, string | undefined])[], t: UiTheme): string {
  const lines = ["", `  ${statusIcon(status, t)}  ${t.bold}${title}${t.reset}  ${t.dim}${status}${t.reset}`];
  lines.push(...renderRows(rows, t));
  lines.push("");
  return lines.join("\n");
}

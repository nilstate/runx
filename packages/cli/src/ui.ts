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

export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diffSec = Math.max(0, Math.round((now - then) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  return `${diffDay}d ago`;
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
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

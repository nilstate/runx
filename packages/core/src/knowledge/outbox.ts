import {
  asOptionalString,
  optionalEnum,
  optionalPlainRecord,
  optionalString,
  requireEnum,
  requireRecord,
  requireString,
} from "./internal-validators.js";

export type OutboxEntryKind = "pull_request" | "draft_change" | "patch_bundle" | "message" | "artifact";
export type OutboxEntryStatus = "proposed" | "draft" | "published" | "superseded" | "closed";

export interface OutboxEntry {
  readonly entry_id: string;
  readonly kind: OutboxEntryKind;
  readonly locator?: string;
  readonly title?: string;
  readonly status?: OutboxEntryStatus;
  readonly thread_locator?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface OutboxControlEntrySelector {
  readonly metadataKey?: string;
  readonly kinds?: readonly OutboxEntryKind[];
  readonly workflow?: string | readonly string[];
  readonly lanes?: readonly string[];
  readonly entryIdPattern?: RegExp;
  readonly control?: (metadata: Readonly<Record<string, unknown>>, entry: OutboxEntry) => boolean;
  readonly entry?: (entry: OutboxEntry) => boolean;
}

export interface MaterializedOutboxFile {
  readonly path: string;
  readonly contents: string;
}

export interface MaterializeOutboxEntryFilesOptions {
  readonly outboxEntry: OutboxEntry | Readonly<Record<string, unknown>>;
  readonly paths?: readonly string[];
  readonly metadataKey?: string;
  readonly readFile: (relativePath: string) => Promise<string>;
}

export function validateOutboxEntry(value: unknown, label = "outbox_entry"): OutboxEntry {
  const record = requireRecord(value, label);
  return {
    entry_id: requireString(record.entry_id, `${label}.entry_id`),
    kind: requireEnum(
      record.kind,
      ["pull_request", "draft_change", "patch_bundle", "message", "artifact"],
      `${label}.kind`,
    ),
    locator: optionalString(record.locator, `${label}.locator`),
    title: optionalString(record.title, `${label}.title`),
    status: optionalEnum(
      record.status,
      ["proposed", "draft", "published", "superseded", "closed"],
      `${label}.status`,
    ),
    thread_locator: optionalString(record.thread_locator, `${label}.thread_locator`),
    metadata: optionalPlainRecord(record.metadata, `${label}.metadata`),
  };
}

export function findOutboxEntry(
  state: { readonly outbox: readonly OutboxEntry[] },
  kind: OutboxEntryKind,
): OutboxEntry | undefined {
  return state.outbox.find((entry) => entry.kind === kind);
}

export function readOutboxEntryControl(
  entry: OutboxEntry | Readonly<Record<string, unknown>> | undefined,
  metadataKey = "control",
): Readonly<Record<string, unknown>> | undefined {
  const metadata = optionalPlainRecord(entry?.metadata, "outbox_entry.metadata");
  return optionalPlainRecord(metadata?.[metadataKey], `outbox_entry.metadata.${metadataKey}`);
}

export function findLatestOutboxEntry(
  state: { readonly outbox?: readonly unknown[] },
  options: {
    readonly kinds?: readonly OutboxEntryKind[];
    readonly entryIdPattern?: RegExp;
    readonly entry?: (entry: OutboxEntry) => boolean;
  } = {},
): OutboxEntry | undefined {
  return sortOutboxEntriesByRecency(normalizeOutboxEntries(state.outbox)
    .filter((entry) => matchesOutboxEntry(entry, options)))
    .at(0);
}

export function findLatestControlOutboxEntry(
  state: { readonly outbox?: readonly unknown[] },
  selector: OutboxControlEntrySelector = {},
): OutboxEntry | undefined {
  return sortOutboxEntriesByRecency(normalizeOutboxEntries(state.outbox)
    .filter((entry) => matchesOutboxEntry(entry, {
      kinds: selector.kinds,
      entry: selector.entry,
    }))
    .filter((entry) => matchesOutboxControlSelector(entry, selector)))
    .at(0);
}

export function sortOutboxEntriesByRecency(
  entries: readonly (OutboxEntry | Readonly<Record<string, unknown>>)[],
): readonly OutboxEntry[] {
  return entries
    .map((entry, index) => ({ entry: validateOutboxEntry(entry, `outbox[${index}]`), index }))
    .sort((left, right) => {
      const leftKey = outboxRecencyKey(left.entry);
      const rightKey = outboxRecencyKey(right.entry);
      const byKey = rightKey.localeCompare(leftKey);
      return byKey === 0 ? left.index - right.index : byKey;
    })
    .map(({ entry }) => entry);
}

export async function materializeOutboxEntryFiles(
  options: MaterializeOutboxEntryFilesOptions,
): Promise<readonly MaterializedOutboxFile[]> {
  const outboxEntry = requireRecord(options.outboxEntry, "outbox_entry");
  const paths = normalizeStringArray(
    options.paths ?? optionalPlainRecord(outboxEntry.metadata, "outbox_entry.metadata")?.[options.metadataKey ?? "changed_files"],
  )
    .map((entry) => normalizeRelativeOutboxPath(entry));
  const uniquePaths = [...new Set(paths)];
  const files = [];
  for (const relativePath of uniquePaths) {
    files.push({
      path: relativePath,
      contents: await options.readFile(relativePath),
    });
  }
  return files;
}

export function normalizeOutboxEntries(value: readonly unknown[] | undefined): readonly OutboxEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry, index) => {
      try {
        return validateOutboxEntry(entry, `outbox[${index}]`);
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is OutboxEntry => entry !== undefined);
}

function matchesOutboxEntry(
  entry: OutboxEntry,
  selector: {
    readonly kinds?: readonly OutboxEntryKind[];
    readonly entryIdPattern?: RegExp;
    readonly entry?: (entry: OutboxEntry) => boolean;
  },
): boolean {
  if (selector.kinds && !selector.kinds.includes(entry.kind)) {
    return false;
  }
  if (selector.entryIdPattern && !regexMatches(selector.entryIdPattern, entry.entry_id)) {
    return false;
  }
  return selector.entry?.(entry) ?? true;
}

function regexMatches(pattern: RegExp, value: string): boolean {
  const lastIndex = pattern.lastIndex;
  pattern.lastIndex = 0;
  const matches = pattern.test(value);
  pattern.lastIndex = lastIndex;
  return matches;
}

function matchesOutboxControlSelector(
  entry: OutboxEntry,
  selector: OutboxControlEntrySelector,
): boolean {
  const control = readOutboxEntryControl(entry, selector.metadataKey);
  const hasStructuredControlSelector =
    selector.workflow !== undefined
    || selector.lanes !== undefined
    || selector.control !== undefined;
  const entryIdMatches = selector.entryIdPattern
    ? regexMatches(selector.entryIdPattern, entry.entry_id)
    : false;

  if (!control) {
    return entryIdMatches;
  }
  if (!hasStructuredControlSelector) {
    return selector.entryIdPattern ? entryIdMatches : true;
  }

  const workflowMatches = matchesStringSelector(control.workflow, selector.workflow);
  const laneMatches = selector.lanes
    ? selector.lanes.includes(asOptionalString(control.lane) ?? "")
    : true;
  return workflowMatches && laneMatches && (selector.control?.(control, entry) ?? true);
}

function matchesStringSelector(
  value: unknown,
  selector: string | readonly string[] | undefined,
): boolean {
  if (selector === undefined) {
    return true;
  }
  const normalized = asOptionalString(value);
  return Array.isArray(selector)
    ? selector.includes(normalized ?? "")
    : normalized === selector;
}

function outboxRecencyKey(entry: OutboxEntry): string {
  const metadata = optionalPlainRecord(entry.metadata, "outbox_entry.metadata");
  return asOptionalString(metadata?.updated_at)
    ?? asOptionalString(metadata?.pushed_at)
    ?? asOptionalString(metadata?.recorded_at)
    ?? entry.locator
    ?? entry.entry_id;
}

function normalizeStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];
}

function normalizeRelativeOutboxPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (
    normalized.length === 0
    || normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split("/").some((segment) => segment === ".." || segment.length === 0)
  ) {
    throw new Error(`outbox changed file path must be a relative path inside the workspace: ${value}`);
  }
  return normalized;
}

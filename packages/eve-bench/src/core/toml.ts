/**
 * Minimal TOML reader for Terminal-Bench `task.toml` files. Supports tables,
 * array-of-tables headers, bare/quoted keys, strings, numbers, booleans, and
 * arrays. Anything else fails with the offending line so a dataset change
 * surfaces immediately instead of being silently misread.
 */
export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export function parseToml(source: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index++) {
    const line = stripComment(lines[index] ?? "").trim();
    if (line.length === 0) continue;
    const lineNumber = index + 1;
    if (line.startsWith("[[") && line.endsWith("]]")) {
      const path = parseKeyPath(line.slice(2, -2), lineNumber);
      const parent = descend(root, path.slice(0, -1));
      const last = path.at(-1)!;
      const existing = parent[last];
      const list = Array.isArray(existing) ? existing : [];
      parent[last] = list;
      current = {};
      list.push(current);
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      current = descend(root, parseKeyPath(line.slice(1, -1), lineNumber));
      continue;
    }
    const eq = findUnquoted(line, "=");
    if (eq === -1) throw new TomlError(`expected key = value`, lineNumber);
    const path = parseKeyPath(line.slice(0, eq), lineNumber);
    const raw = line.slice(eq + 1).trim();
    const target = descend(current, path.slice(0, -1));
    target[path.at(-1)!] = parseValue(raw, lineNumber);
  }
  return root;
}

export class TomlError extends Error {
  constructor(message: string, line: number) {
    super(`task.toml line ${line}: ${message}`);
  }
}

function descend(table: TomlTable, path: readonly string[]): TomlTable {
  let node = table;
  for (const segment of path) {
    const next = node[segment];
    if (next === undefined) {
      const created: TomlTable = {};
      node[segment] = created;
      node = created;
    } else if (Array.isArray(next)) {
      const last = next.at(-1);
      if (!isTable(last)) throw new Error(`cannot descend into array at ${segment}`);
      node = last;
    } else if (isTable(next)) {
      node = next;
    } else {
      throw new Error(`key ${segment} is not a table`);
    }
  }
  return node;
}

function isTable(value: unknown): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseKeyPath(text: string, line: number): string[] {
  const parts = text
    .split(".")
    .map((part) => part.trim())
    .map((part) => (part.startsWith('"') ? parseString(part, line) : part));
  if (parts.some((part) => part.length === 0)) throw new TomlError(`invalid key ${text}`, line);
  return parts;
}

function parseValue(raw: string, line: number): TomlValue {
  if (raw.length === 0) throw new TomlError("missing value", line);
  if (raw.startsWith('"') || raw.startsWith("'")) return parseString(raw, line);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith("[")) return parseArray(raw, line);
  if (raw.startsWith("{")) throw new TomlError("inline tables are not supported", line);
  const number = Number(raw.replaceAll("_", ""));
  if (Number.isFinite(number)) return number;
  throw new TomlError(`unsupported value ${raw}`, line);
}

function parseString(raw: string, line: number): string {
  const quote = raw[0];
  if (quote !== '"' && quote !== "'") throw new TomlError(`expected string`, line);
  if (raw.length < 2 || raw.at(-1) !== quote) throw new TomlError(`unterminated string`, line);
  const body = raw.slice(1, -1);
  if (quote === "'") return body;
  return body.replaceAll(/\\(["\\nrt])/gu, (_, code: string) =>
    code === "n" ? "\n" : code === "r" ? "\r" : code === "t" ? "\t" : code,
  );
}

function parseArray(raw: string, line: number): TomlValue[] {
  if (!raw.endsWith("]")) throw new TomlError("unterminated array", line);
  const inner = raw.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return splitTopLevel(inner, line).map((item) => parseValue(item.trim(), line));
}

function splitTopLevel(text: string, line: number): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote !== null) {
      if (char === "\\" && quote === '"') index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[") depth++;
    else if (char === "]") depth--;
    else if (char === "," && depth === 0) {
      items.push(text.slice(start, index));
      start = index + 1;
    }
  }
  if (quote !== null || depth !== 0) throw new TomlError("unbalanced array", line);
  const tail = text.slice(start).trim();
  if (tail.length > 0) items.push(tail);
  return items;
}

function findUnquoted(text: string, needle: string): number {
  let quote: string | null = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote !== null) {
      if (char === "\\" && quote === '"') index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === needle) return index;
  }
  return -1;
}

function stripComment(line: string): string {
  const hash = findUnquoted(line, "#");
  return hash === -1 ? line : line.slice(0, hash);
}

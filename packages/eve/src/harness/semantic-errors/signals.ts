import { walkCauseChain } from "#shared/errors.js";
import { isObject } from "#shared/guards.js";

export interface ErrorLink {
  readonly name?: string;
  readonly message: string;
  readonly code?: string;
  readonly statusCode?: number;
  readonly type?: string;
  readonly hint?: string;
}

export interface ErrorSignals {
  readonly chain: readonly ErrorLink[];
}

export function extractErrorSignals(error: unknown): ErrorSignals {
  const chain: ErrorLink[] = [];
  for (const candidate of walkCauseChain(error)) {
    if (!isObject(candidate)) continue;
    const link: { -readonly [Key in keyof ErrorLink]: ErrorLink[Key] } = {
      message: typeof candidate.message === "string" ? candidate.message : "",
    };
    if (typeof candidate.name === "string" && candidate.name.length > 0) {
      link.name = candidate.name;
    }
    const bodies = readProviderErrorBodies(candidate);
    const code = readErrorField(candidate, bodies, "code");
    if (code !== undefined) link.code = code;
    if (typeof candidate.statusCode === "number") {
      link.statusCode = candidate.statusCode;
    }
    const type = readErrorField(candidate, bodies, "type");
    if (type !== undefined) link.type = type;
    if (typeof candidate.hint === "string" && candidate.hint.length > 0) {
      link.hint = candidate.hint;
    }
    chain.push(link);
  }
  return { chain };
}

function readProviderErrorBodies(candidate: Record<string, unknown>): readonly unknown[] {
  if (typeof candidate.responseBody !== "string") return [candidate.data];
  try {
    return [candidate.data, JSON.parse(candidate.responseBody)];
  } catch {
    return [candidate.data];
  }
}

function readErrorField(
  candidate: Record<string, unknown>,
  bodies: readonly unknown[],
  field: "code" | "type",
): string | undefined {
  const own = candidate[field];
  if (typeof own === "string" && own.length > 0) return own;

  for (const body of bodies) {
    const value = readBodyField(body, field);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readBodyField(value: unknown, field: "code" | "type"): string | undefined {
  if (!isObject(value)) return undefined;
  const nestedError = value.error;
  if (isObject(nestedError) && typeof nestedError[field] === "string") {
    const nested = nestedError[field];
    return nested.length > 0 ? nested : undefined;
  }
  const top = value[field];
  return typeof top === "string" && top.length > 0 ? top : undefined;
}

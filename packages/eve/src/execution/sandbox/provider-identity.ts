import { createHash } from "node:crypto";

export function createSandboxProviderIdentity(value: unknown): string {
  return createHash("sha256").update(serialize(value, new WeakSet())).digest("hex");
}

function serialize(value: unknown, seen: WeakSet<object>): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "function") return `function:${value.toString()}`;
  if (Array.isArray(value)) return `[${value.map((entry) => serialize(entry, seen)).join(",")}]`;
  if (typeof value !== "object") {
    throw new Error(`Unsupported sandbox provider identity value: ${typeof value}`);
  }
  if (seen.has(value)) throw new Error("Sandbox provider identity values cannot be circular.");
  seen.add(value);
  const result = `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${serialize(entry, seen)}`)
    .join(",")}}`;
  seen.delete(value);
  return result;
}

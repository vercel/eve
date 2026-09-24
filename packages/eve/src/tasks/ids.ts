const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
const SUFFIX_LENGTH = 6;

/**
 * Derives a task ID as `<name>-<6 base32>` from the owner, turn, and call.
 *
 * The derivation is pure so a replayed step assigns the same ID. `taken`
 * resolves the rare collision deterministically by rehashing with a counter.
 */
export function deriveTaskId(input: {
  readonly callId: string;
  readonly name: string;
  readonly ownerId: string;
  readonly taken?: (id: string) => boolean;
  readonly turnId: string;
}): string {
  const prefix = normalizeTaskName(input.name);
  for (let attempt = 0; ; attempt++) {
    const seed = [input.ownerId, input.turnId, input.callId, String(attempt)].join("\u0000");
    const id = `${prefix}-${encodeSuffix(hash64(seed))}`;
    if (input.taken?.(id) !== true) return id;
  }
}

function normalizeTaskName(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized === "" ? "task" : normalized.slice(0, 48);
}

function encodeSuffix(value: bigint): string {
  let out = "";
  let remaining = value;
  for (let index = 0; index < SUFFIX_LENGTH; index++) {
    out += BASE32[Number(remaining & 31n)];
    remaining >>= 5n;
  }
  return out;
}

const MASK = 0xffffffffffffffffn;

/** FNV-1a with a murmur3 finalizer. Workflow bodies cannot rely on `node:crypto`. */
function hash64(value: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & MASK;
  }
  hash ^= hash >> 33n;
  hash = (hash * 0xff51afd7ed558ccdn) & MASK;
  hash ^= hash >> 33n;
  hash = (hash * 0xc4ceb9fe1a85ec53n) & MASK;
  return hash ^ (hash >> 33n);
}

/**
 * ULID generation, implemented here rather than taken from npm.
 *
 * This is a deliberate exception to reaching for a well-known package, made
 * for two reasons. The canonical `ulid` package ships separate Node and
 * browser builds — the Node one hard-imports `node:crypto` — and this module
 * is bundled into browser clients, the Nitro server, and the workflow step
 * sandbox, so a single Web Crypto path is more predictable than trusting
 * conditional exports to resolve correctly in all three. And eve needs
 * monotonic-by-default generation, which that package only offers through a
 * separate `monotonicFactory()`, so a wrapper would exist either way.
 *
 * The encoding is spec-conformant: output has been cross-validated against
 * the reference implementation's `isValid` and `decodeTime`, and
 * `ulid.test.ts` pins the timestamp encoding with golden vectors taken from
 * it. Ids produced here are readable by any other ULID tooling.
 */

// Crockford base32: no I, L, O, or U, so a transcribed id cannot be confused
// with 1/0 and the alphabet stays sort-order-compatible with the raw bits.
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_BYTES = 10;
const RANDOM_CHARS = 16;

/** Character count of a ULID: a 10-char timestamp then a 16-char random tail. */
export const ULID_LENGTH = TIME_CHARS + RANDOM_CHARS;

/** Mints one ULID. See {@link createUlidFactory}. */
export type UlidFactory = () => string;

/**
 * Creates an independent ULID generator with its own monotonic state.
 *
 * Prefer {@link createUlid} unless you need isolation. A separate generator
 * is useful in tests, where the shared one carries state between cases, and
 * anywhere a caller must not have its sequence perturbed by unrelated code.
 *
 * Each generator emits ids that sort in the order it produced them: ids
 * minted within one millisecond increment the random component instead of
 * re-randomizing it, and a clock that moves backwards is pinned to the last
 * millisecond the generator observed.
 */
export function createUlidFactory(): UlidFactory {
  let lastTimeMs = -1;
  const lastRandom = new Uint8Array(RANDOM_BYTES);

  return function createUlidFromFactory(): string {
    const now = Date.now();

    if (now > lastTimeMs) {
      lastTimeMs = now;
      randomFill(lastRandom);
    } else if (!incrementRandom(lastRandom)) {
      // 2^80 ids inside one millisecond. Unreachable in practice; advancing
      // the logical clock keeps the generator monotonic rather than blocking.
      lastTimeMs += 1;
      randomFill(lastRandom);
    }

    return `${encodeTime(lastTimeMs)}${encodeRandom(lastRandom)}`;
  };
}

/**
 * Mints a ULID from the process-wide generator: a 48-bit millisecond
 * timestamp then 80 bits of randomness, in Crockford base32.
 *
 * Ids lead with their timestamp, so they are broadly time-ordered and a
 * primary key built on one stays clustered. Ordering is only guaranteed
 * within a single process: separate processes have independent clocks and
 * random tails, so ids from different machines are not a total order and
 * must not be used as a lossless pagination cursor.
 *
 * Requires Web Crypto. Throws on the first call in an environment without
 * `globalThis.crypto.getRandomValues` rather than silently weakening the
 * randomness.
 */
export const createUlid: UlidFactory = createUlidFactory();

/**
 * Returns true when `value` is shaped like a ULID: {@link ULID_LENGTH}
 * characters drawn from the Crockford base32 alphabet.
 *
 * Shape-only — this does not prove the value was minted here.
 */
export function isUlid(value: string): boolean {
  if (value.length !== ULID_LENGTH) return false;
  for (const character of value) {
    if (!ENCODING.includes(character)) return false;
  }
  return true;
}

function randomFill(target: Uint8Array<ArrayBuffer>): void {
  // Web Crypto rather than `node:crypto`, because this module is bundled into
  // browser clients and into the workflow step sandbox. `getRandomValues` is
  // also available in insecure browser contexts, unlike `randomUUID`.
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.getRandomValues !== "function") {
    throw new Error("Cannot mint a ULID: globalThis.crypto.getRandomValues is unavailable.");
  }
  webCrypto.getRandomValues(target);
}

function encodeTime(timeMs: number): string {
  let remaining = timeMs;
  let encoded = "";
  for (let index = 0; index < TIME_CHARS; index += 1) {
    encoded = ENCODING[remaining % 32] + encoded;
    remaining = Math.floor(remaining / 32);
  }
  return encoded;
}

/** Encodes 80 bits as 16 five-bit groups — an exact fit, so no padding. */
function encodeRandom(bytes: Uint8Array): string {
  let buffer = 0;
  let bufferedBits = 0;
  let encoded = "";

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bufferedBits += 8;
    while (bufferedBits >= 5) {
      bufferedBits -= 5;
      encoded += ENCODING[(buffer >>> bufferedBits) & 31];
    }
    buffer &= (1 << bufferedBits) - 1;
  }

  return encoded;
}

/** Adds one to a big-endian counter in place. Returns false on overflow. */
function incrementRandom(bytes: Uint8Array): boolean {
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    const byte = bytes[index] ?? 0;
    if (byte < 0xff) {
      bytes[index] = byte + 1;
      return true;
    }
    bytes[index] = 0;
  }
  return false;
}

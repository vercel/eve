/**
 * ULID-compatible generation, vendored rather than taken from npm: the
 * `ulid` package's Node build hard-imports `node:crypto`, and this module is
 * bundled into browser clients, the Nitro server, and the workflow step
 * sandbox. `ulid.test.ts` pins the encoding against the reference
 * implementation's golden vectors.
 */

// Crockford base32: omits I, L, O, and U, and sorts in raw-bit order.
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const TIME_MAX = 2 ** 48 - 1;
const RANDOM_BYTES = 10;
const RANDOM_CHARS = 16;

/** Character count of a ULID: a 10-char timestamp then a 16-char random tail. */
export const ULID_LENGTH = TIME_CHARS + RANDOM_CHARS;

/** Mints one ULID. See {@link createUlidFactory}. */
export type UlidFactory = () => string;

/**
 * Creates an independent ULID generator with its own monotonic state.
 *
 * Prefer {@link createUlid} unless a caller needs a sequence that unrelated
 * code cannot perturb. Ids sort in the order one generator produced them:
 * those minted within a millisecond increment the random tail, and a
 * backwards clock pins to the last millisecond observed.
 */
export function createUlidFactory(): UlidFactory {
  let lastTimeMs = -1;
  const lastRandom = new Uint8Array(RANDOM_BYTES);

  return function createUlidFromFactory(): string {
    const now = Date.now();
    if (!Number.isInteger(now) || now < 0 || now > TIME_MAX) {
      throw new Error(`Cannot mint a ULID: timestamp must be an integer from 0 to ${TIME_MAX}.`);
    }

    if (now > lastTimeMs) {
      lastTimeMs = now;
      randomFill(lastRandom);
    } else if (!incrementRandom(lastRandom)) {
      // 2^80 ids in one millisecond: advance the logical clock rather than block.
      if (lastTimeMs === TIME_MAX) {
        throw new Error(
          "Cannot mint a ULID: random component overflowed at the maximum timestamp.",
        );
      }
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
 * Ids lead with their timestamp, so they are broadly time-ordered. Ordering
 * holds within one process only — separate processes have independent clocks
 * and random tails — so a ULID is not a lossless pagination cursor.
 *
 * Throws when the clock is outside the 48-bit timestamp range or Web Crypto
 * is unavailable rather than weakening the randomness.
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
  if (ENCODING.indexOf(value[0] ?? "") > 7) return false;
  for (const character of value) {
    if (!ENCODING.includes(character)) return false;
  }
  return true;
}

function randomFill(target: Uint8Array<ArrayBuffer>): void {
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
      bytes.fill(0, index + 1);
      return true;
    }
  }
  return false;
}

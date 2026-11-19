const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const TIME_MAX = 2 ** 48 - 1;
const RANDOM_BYTES = 10;
const RANDOM_CHARS = 16;

export const ULID_LENGTH = TIME_CHARS + RANDOM_CHARS;

type UlidFactory = () => string;

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

export const createUlid: UlidFactory = createUlidFactory();

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

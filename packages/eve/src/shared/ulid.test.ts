import { afterEach, describe, expect, it, vi } from "vitest";

import { createUlid, createUlidFactory, isUlid, ULID_LENGTH } from "#shared/ulid.js";

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;

afterEach(() => {
  vi.useRealTimers();
});

describe("createUlid", () => {
  it("produces a 26-character Crockford base32 value", () => {
    const ulid = createUlid();

    expect(ulid).toHaveLength(ULID_LENGTH);
    expect(ulid).toMatch(CROCKFORD);
  });

  it("draws from the process-wide generator without repeating", () => {
    const ids = Array.from({ length: 1000 }, () => createUlid());

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("createUlidFactory", () => {
  it("encodes the timestamp exactly as the ULID spec does", () => {
    // Golden vectors taken from the reference `ulid` package's `encodeTime`.
    // They pin the Crockford timestamp so a change to the encoder cannot
    // silently produce ids that other ULID tooling misreads.
    vi.useFakeTimers();
    const mint = createUlidFactory();

    vi.setSystemTime(new Date(0));
    expect(mint().slice(0, 10)).toBe("0000000000");

    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));
    expect(mint().slice(0, 10)).toBe("01KYGDY300");

    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    expect(mint().slice(0, 10)).toBe("01Q3DCBD00");
  });

  it("sorts in emission order when many ids share one millisecond", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));
    const mint = createUlidFactory();

    const ids = Array.from({ length: 500 }, () => mint());

    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sorts later timestamps after earlier ones", () => {
    vi.useFakeTimers();
    const mint = createUlidFactory();

    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));
    const earlier = mint();
    vi.setSystemTime(new Date("2026-07-27T00:00:01.000Z"));
    const later = mint();

    expect(earlier < later).toBe(true);
  });

  it("stays monotonic when the clock moves backwards", () => {
    vi.useFakeTimers();
    const mint = createUlidFactory();

    vi.setSystemTime(new Date("2026-07-27T00:00:05.000Z"));
    const first = mint();
    vi.setSystemTime(new Date("2026-07-27T00:00:04.000Z"));
    const second = mint();

    expect(first < second).toBe(true);
  });

  it("isolates each generator's state from the others", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:05.000Z"));
    const settled = createUlidFactory();
    settled();

    // A fresh generator has observed no clock, so it is free to mint an
    // earlier timestamp than one that has already run past it.
    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));
    const fresh = createUlidFactory();

    expect(fresh() < settled()).toBe(true);
  });
});

describe("isUlid", () => {
  it("accepts values this module mints", () => {
    expect(isUlid(createUlid())).toBe(true);
  });

  it("rejects a wrong length or a non-Crockford character", () => {
    const ulid = createUlid();

    expect(isUlid(ulid.slice(1))).toBe(false);
    expect(isUlid(`${ulid}0`)).toBe(false);
    // U is excluded from the Crockford alphabet.
    expect(isUlid(`U${ulid.slice(1)}`)).toBe(false);
  });
});

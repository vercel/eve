import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { decodeWireValue, encodeWireValue } from "./codec.js";
import { ComputeError } from "./errors.js";

describe("eve-value-v1", () => {
  it("round-trips rich values, references, and cycles", () => {
    const shared = { label: "shared" };
    const value: Record<string, unknown> = {
      arrayBuffer: Uint8Array.from([9, 8, 7]).buffer,
      big: 9_007_199_254_740_993n,
      buffer: Buffer.from([1, 2, 3]),
      date: new Date("2026-09-09T12:34:56.789Z"),
      infinity: Infinity,
      map: new Map([[shared, new Set(["a", "b"])]]),
      nan: Number.NaN,
      negativeZero: -0,
      regexp: /eve/giu,
      sharedA: shared,
      sharedB: shared,
      typed: new Uint16Array([10, 20, 30]),
      undefined,
      url: new URL("https://eve.dev/compute?q=cell"),
      urlSearchParams: new URLSearchParams({ cell: "one", task: "two" }),
    };
    value.self = value;

    const decoded = decodeWireValue(encodeWireValue(value)) as typeof value;

    expect(decoded.self).toBe(decoded);
    expect(decoded.sharedA).toBe(decoded.sharedB);
    expect(decoded.date).toEqual(value.date);
    expect(decoded.url).toEqual(value.url);
    expect(decoded.urlSearchParams).toEqual(value.urlSearchParams);
    expect(decoded.map).toEqual(value.map);
    expect(decoded.regexp).toEqual(value.regexp);
    expect(decoded.typed).toEqual(value.typed);
    expect(decoded.arrayBuffer).toEqual(value.arrayBuffer);
    expect(decoded.buffer).toEqual(value.buffer);
    expect(Buffer.isBuffer(decoded.buffer)).toBe(true);
    expect(decoded.big).toBe(value.big);
    expect(decoded.nan).toBeNaN();
    expect(decoded.infinity).toBe(Infinity);
    expect(Object.is(decoded.negativeZero, -0)).toBe(true);
    expect("undefined" in decoded).toBe(true);
  });

  it("rejects values outside the codec contract", () => {
    class Unsupported {
      value = 1;
    }

    expect(() => encodeWireValue({ function: () => "no" })).toThrowError(ComputeError);
    expect(() => encodeWireValue(new Unsupported())).toThrow(/cannot be encoded/u);
  });

  it("rejects malformed or extended wire envelopes", () => {
    expect(() => decodeWireValue({ codec: "eve-value-v1", data: "not-json" })).toThrow(
      /Invalid eve-value-v1 payload/u,
    );
    expect(() =>
      decodeWireValue({
        codec: "eve-value-v1",
        data: "-1",
        extra: true,
      } as never),
    ).toThrow(/Invalid eve-value-v1 envelope/u);
  });
});

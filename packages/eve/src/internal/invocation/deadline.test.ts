import { afterEach, describe, expect, it } from "vitest";

import { getInvocationDeadline } from "./deadline.js";

const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
const runtime = globalThis as Record<symbol, unknown>;
const previous = runtime[VERCEL_REQUEST_CONTEXT];

afterEach(() => {
  if (previous === undefined) {
    delete runtime[VERCEL_REQUEST_CONTEXT];
  } else {
    runtime[VERCEL_REQUEST_CONTEXT] = previous;
  }
});

describe("getInvocationDeadline", () => {
  it("reads the absolute Function deadline from Vercel request context", () => {
    runtime[VERCEL_REQUEST_CONTEXT] = {
      get: () => ({ deadline: "2026-08-27T15:00:00.000Z" }),
    };

    expect(getInvocationDeadline()).toEqual(new Date("2026-08-27T15:00:00.000Z"));
  });

  it("returns undefined outside a supported invocation context", () => {
    delete runtime[VERCEL_REQUEST_CONTEXT];
    expect(getInvocationDeadline()).toBeUndefined();

    runtime[VERCEL_REQUEST_CONTEXT] = { get: () => ({ deadline: "invalid" }) };
    expect(getInvocationDeadline()).toBeUndefined();
  });
});

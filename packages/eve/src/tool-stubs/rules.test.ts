import { describe, expect, it } from "vitest";

import { parseToolStubs } from "#tool-stubs/rules.js";
import { StubPlayback } from "#tool-stubs/playback.js";

describe("tool stubs", () => {
  it("rejects prototype keys instead of silently dropping a match constraint", () => {
    expect(() =>
      parseToolStubs(
        JSON.parse(
          '[{"id":"a","tool":"list","match":{"__proto__":{"const":"x"}},"outcome":{"response":null}}]',
        ),
      ),
    ).toThrow(/prototype/i);
  });

  it("rejects stubbing eve__search and eve__execute and points at the tool a call reaches", () => {
    for (const tool of ["eve__search", "researcher/eve__execute"]) {
      expect(() => parseToolStubs([{ id: "a", tool, outcome: { response: null } }])).toThrow(
        "Cannot stub eve__search or eve__execute. Stub the tool an eve__execute call reaches, such as linear__list_issues.",
      );
    }
  });

  it("selects a response by partial input without changing the arguments", () => {
    const playback = new StubPlayback(
      parseToolStubs([
        {
          id: "milk",
          tool: "complete_task",
          match: { task_id: { const: "milk" } },
          outcome: { response: { success: true } },
        },
      ]),
    );
    const input = { task_id: "milk", reason: "Done" };

    expect(playback.call({ callId: "call-1", tool: "complete_task", input })).toEqual({
      kind: "stub",
      ruleId: "milk",
      position: 0,
      outcome: { response: { success: true } },
    });
    expect(input).toEqual({ task_id: "milk", reason: "Done" });
  });

  it("advances per call, repeats the last response, and reuses retried calls", () => {
    const playback = new StubPlayback(
      parseToolStubs([
        {
          id: "tasks",
          tool: "list_tasks",
          outcomes: [{ response: ["milk", "dog"] }, { response: ["dog"] }],
        },
      ]),
    );
    const call = { tool: "list_tasks", input: {} };
    expect(playback.call({ ...call, callId: "first" })).toEqual({
      kind: "stub",
      ruleId: "tasks",
      position: 0,
      outcome: { response: ["milk", "dog"] },
    });
    expect(playback.call({ ...call, callId: "second" })).toEqual({
      kind: "stub",
      ruleId: "tasks",
      position: 1,
      outcome: { response: ["dog"] },
    });
    expect(playback.call({ ...call, callId: "first" })).toEqual({
      kind: "stub",
      ruleId: "tasks",
      position: 0,
      outcome: { response: ["milk", "dog"] },
    });
    expect(playback.call({ ...call, callId: "third" })).toEqual({
      kind: "stub",
      ruleId: "tasks",
      position: 1,
      outcome: { response: ["dog"] },
    });
  });

  it("requires each named field and matches nested shapes without filling defaults", () => {
    const playback = new StubPlayback(
      parseToolStubs([
        {
          id: "search",
          tool: "search",
          match: {
            filter: {
              type: "object",
              properties: { status: { const: "open", default: "open" } },
              required: ["status"],
            },
            query: { type: "string", enum: ["milk", "buy milk"] },
            tags: { type: "array", contains: { const: "urgent" } },
          },
          outcome: { response: ["milk"] },
        },
      ]),
    );
    expect(playback.call({ callId: "missing", tool: "search", input: {} })).toEqual({
      kind: "real",
    });
    expect(
      playback.call({
        callId: "default",
        tool: "search",
        input: { filter: {}, query: "milk", tags: ["urgent"] },
      }),
    ).toEqual({ kind: "real" });
    expect(
      playback.call({
        callId: "match",
        tool: "search",
        input: {
          filter: { status: "open", owner: "alice" },
          query: "buy milk",
          tags: ["personal", "urgent"],
          limit: 10,
        },
      }),
    ).toEqual({ kind: "stub", ruleId: "search", position: 0, outcome: { response: ["milk"] } });
  });

  it("uses the first match, advances only its sequence, and never falls through after exhaustion", () => {
    const playback = new StubPlayback(
      parseToolStubs([
        {
          id: "specific",
          tool: "list",
          match: { status: { const: "open" } },
          outcomes: [{ response: "one" }, { response: "two" }],
        },
        {
          id: "fallback",
          tool: "list",
          outcomes: [{ response: "fallback-one" }, { response: "fallback-two" }],
        },
      ]),
    );
    const call = (callId: string, status: string) =>
      playback.call({ callId, tool: "list", input: { status } });
    expect(call("a", "open")).toMatchObject({
      ruleId: "specific",
      outcome: { response: "one" },
      position: 0,
    });
    expect(call("b", "open")).toMatchObject({
      ruleId: "specific",
      outcome: { response: "two" },
      position: 1,
    });
    expect(call("c", "open")).toMatchObject({
      ruleId: "specific",
      outcome: { response: "two" },
      position: 1,
    });
    expect(call("a", "open")).toMatchObject({
      ruleId: "specific",
      outcome: { response: "one" },
      position: 0,
    });
    expect(call("d", "closed")).toMatchObject({
      ruleId: "fallback",
      outcome: { response: "fallback-one" },
      position: 0,
    });
  });

  it("rejects conditional replacement of persistent tools", () => {
    const playback = new StubPlayback(
      parseToolStubs([
        {
          id: "agent",
          tool: "tasks_agent",
          match: { message: { const: "hello" } },
          outcome: { response: "hi" },
        },
      ]),
    );
    expect(
      playback.call({
        callId: "call",
        tool: "tasks_agent",
        input: { message: "other" },
        persistent: true,
      }),
    ).toEqual({
      kind: "error",
      error: 'Persistent tool "tasks_agent" requires an unconditional stub.',
    });
  });

  it.each([
    [{ tool: "list", outcome: { response: null } }],
    [{ id: "a", tool: "", outcome: { response: null } }],
    [{ id: "a", tool: "list" }],
    [{ id: "a", tool: "list", response: null }],
    [{ id: "a", tool: "list", responses: [null] }],
    [{ id: "a", tool: "list", outcome: { response: null }, response: null }],
    [{ id: "a", tool: "list", outcome: null }],
    [{ id: "a", tool: "list", outcome: {} }],
    [{ id: "a", tool: "list", outcome: { response: undefined } }],
    [{ id: "a", tool: "list", outcome: { response: null, extra: true } }],
    [{ id: "a", tool: "list", outcome: { response: null, throw: { message: "Not yet" } } }],
    [{ id: "a", tool: "list", outcome: { throw: {} } }],
    [{ id: "a", tool: "list", outcome: { throw: "Unavailable" } }],
    [{ id: "a", tool: "list", outcome: { throw: { message: 42 } } }],
    [{ id: "a", tool: "list", outcome: { throw: { message: "Unavailable", name: "" } } }],
    [{ id: "a", tool: "list", outcome: { throw: { message: "Unavailable", delayMs: 100 } } }],
    [{ id: "a", tool: "list", outcomes: [] }],
    [{ id: "a", tool: "list", outcomes: [{ response: null }, {}] }],
    [{ id: "a", tool: "list", outcomes: [{ response: null }, { throw: { message: false } }] }],
    [{ id: "a", tool: "list", outcome: { response: null }, outcomes: [{ response: null }] }],
    [{ id: "a", tool: "list", outcome: { response: null }, typo: true }],
    [{ id: "a", tool: "list", match: [], outcome: { response: null } }],
    [{ id: "a", tool: "list", match: { x: 1 }, outcome: { response: null } }],
    [{ id: "a", tool: "list", outcome: { response: { value: Number.NaN } } }],
    [
      { id: "a", tool: "list", outcome: { response: null } },
      { id: "a", tool: "list", outcome: { response: null } },
    ],
    [{ id: "a", tool: "list", match: { x: { type: "strng" } }, outcome: { response: null } }],
    [{ id: "a", tool: "list", match: { x: { pattern: "[" } }, outcome: { response: null } }],
    [{ id: "a", tool: "list", match: { x: { minimum: "1" } }, outcome: { response: null } }],
    [
      {
        id: "a",
        tool: "list",
        match: { x: { $ref: "https://example.com/schema" } },
        outcome: { response: null },
      },
    ],
  ])("rejects invalid rules and unsupported schemas before execution: %j", (...rules) => {
    expect(() => parseToolStubs(rules)).toThrow();
  });

  it("normalizes absent options and preserves response and error outcomes", () => {
    expect(
      parseToolStubs([
        {
          id: "constant",
          tool: "list",
          match: undefined,
          outcome: { response: null },
          outcomes: undefined,
        },
        {
          id: "sequence",
          tool: "list",
          outcome: undefined,
          outcomes: [{ response: false }, { response: 0 }, { response: "" }, { response: null }],
        },
        { id: "failure", tool: "list", outcome: { throw: { message: "Unavailable" } } },
        {
          id: "recovery",
          tool: "list",
          outcomes: [
            { throw: { name: "TimeoutError", message: "Timed out" } },
            { response: { tasks: [] } },
          ],
        },
      ]),
    ).toEqual([
      { id: "constant", tool: "list", outcome: { response: null } },
      {
        id: "sequence",
        tool: "list",
        outcomes: [{ response: false }, { response: 0 }, { response: "" }, { response: null }],
      },
      { id: "failure", tool: "list", outcome: { throw: { message: "Unavailable" } } },
      {
        id: "recovery",
        tool: "list",
        outcomes: [
          { throw: { name: "TimeoutError", message: "Timed out" } },
          { response: { tasks: [] } },
        ],
      },
    ]);
  });

  it("returns the response payload on every call, including keys named response or throw", () => {
    const playback = new StubPlayback(
      parseToolStubs([
        {
          id: "data",
          tool: "lookup",
          outcome: { response: { response: false, throw: "ordinary data" } },
        },
      ]),
    );
    for (const callId of ["first", "second"]) {
      expect(playback.call({ callId, tool: "lookup", input: {} })).toEqual({
        kind: "stub",
        ruleId: "data",
        position: 0,
        outcome: { response: { response: false, throw: "ordinary data" } },
      });
    }
  });

  it.each([
    [{ minimum: "1" }, "#/minimum", "number"],
    [{ properties: { count: { minimun: 1 } } }, "#/properties/count/minimun", "Unsupported"],
    [{ pattern: "[" }, "#/pattern", "regex"],
  ])("identifies the rule, property, and invalid schema keyword: %j", (schema, path, detail) => {
    expect(() =>
      parseToolStubs([
        { id: "valid", tool: "lookup", outcome: { response: null } },
        {
          id: "broken-filter",
          tool: "lookup",
          match: { filter: schema },
          outcome: { response: null },
        },
      ]),
    ).toThrow(
      new RegExp(`Invalid matcher "filter" in tool stub "broken-filter" at ${path}: .*${detail}`),
    );
  });
});

it("does not consume another rule's sequence or advance on unmatched calls", () => {
  const playback = new StubPlayback(
    parseToolStubs([
      {
        id: "open",
        tool: "lookup",
        match: { status: { const: "open" } },
        outcomes: [{ response: "open-1" }, { response: "open-2" }],
      },
      {
        id: "closed",
        tool: "lookup",
        match: { status: { const: "closed" } },
        outcomes: [{ response: "closed-1" }, { response: "closed-2" }],
      },
    ]),
  );
  const call = (callId: string, status: string) =>
    playback.call({ callId, tool: "lookup", input: { status } });
  expect(call("a", "open")).toMatchObject({ outcome: { response: "open-1" } });
  expect(call("b", "absent")).toEqual({ kind: "real" });
  expect(call("c", "closed")).toMatchObject({ outcome: { response: "closed-1" } });
  expect(call("d", "open")).toMatchObject({ outcome: { response: "open-2" } });
  expect(call("e", "closed")).toMatchObject({ outcome: { response: "closed-2" } });
});

it("requires the field even for a true constraint and lets an earlier broad match win", () => {
  const playback = new StubPlayback(
    parseToolStubs([
      { id: "present", tool: "lookup", match: { status: true }, outcome: { response: "any" } },
      {
        id: "open",
        tool: "lookup",
        match: { status: { const: "open" } },
        outcome: { response: "open" },
      },
    ]),
  );
  expect(playback.call({ callId: "missing", tool: "lookup", input: {} })).toEqual({ kind: "real" });
  expect(playback.call({ callId: "null", tool: "lookup", input: { status: null } })).toMatchObject({
    outcome: { response: "any" },
  });
  expect(
    playback.call({ callId: "overlap", tool: "lookup", input: { status: "open" } }),
  ).toMatchObject({ kind: "stub", ruleId: "present", outcome: { response: "any" } });
});

it("includes the final visited string in the configuration size limit", () => {
  expect(() =>
    parseToolStubs([{ id: "x".repeat(1_000_001), tool: "list", outcome: { response: null } }]),
  ).toThrow(/size/);
});

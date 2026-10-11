import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import { Client } from "#client/client.js";
import type { CreatedClientSession } from "#client/sessions.js";
import type { ToolStub } from "#tool-stubs/types.js";

afterEach(() => vi.restoreAllMocks());

it.each([undefined, "Complete the milk task."])(
  "sends declarative rules when creating a session with message %s",
  async (message) => {
    let sent: unknown;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ ok: true, sessionId: "session", status: "accepted" }, { status: 202 });
    });
    const client = new Client({ host: "https://agent.test" });
    const stubs = [
      {
        id: "milk",
        tool: "complete_task",
        match: { task_id: { const: "milk" } },
        outcomes: [
          { throw: { name: "TimeoutError", message: "Service timed out" } },
          { response: { success: true } },
        ],
      },
    ] satisfies ToolStub[];
    if (message === undefined) {
      await client.sessions.create({ stubs });
    } else {
      const created = await client.sessions.create({ message, stubs });
      expectTypeOf(created).toEqualTypeOf<CreatedClientSession>();
    }
    const expected: Record<string, unknown> = {
      stubs: [
        {
          id: "milk",
          tool: "complete_task",
          match: { task_id: { const: "milk" } },
          outcomes: [
            { throw: { name: "TimeoutError", message: "Service timed out" } },
            { response: { success: true } },
          ],
        },
      ],
    };
    if (message !== undefined) expected.message = message;
    expect(sent).toEqual(expected);
  },
);

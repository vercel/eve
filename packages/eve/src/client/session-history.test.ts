import { afterEach, expect, it, vi } from "vitest";
import { Client } from "#client/client.js";
import type { SessionHistoryMessage } from "#shared/session-history.js";

afterEach(() => vi.restoreAllMocks());

const history = [
  { id: "q1", role: "user", text: "How do I redirect www.example.com to example.com?" },
  { role: "assistant", text: "Add both domains, then configure the redirect." },
] satisfies SessionHistoryMessage[];

function capturePosts() {
  const sent: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
    if (init?.method === "POST") {
      sent.push(init.body == null ? undefined : JSON.parse(String(init.body)));
    }
    return Response.json(
      { ok: true, sessionId: "session", deliveryId: "delivery_0" },
      { status: 202 },
    );
  });
  return sent;
}

it.each([undefined, "Can we submit a case anyway?"])(
  "sends history in order when creating a session with message %s",
  async (message) => {
    const sent = capturePosts();
    const client = new Client({ baseUrl: "https://agent.test" });

    if (message === undefined) await client.sessions.create({ history });
    else await client.sessions.create({ message, history });

    expect(sent).toEqual([message === undefined ? { history } : { message, history }]);
  },
);

it("sends history only when the session is created, not on later messages", async () => {
  const sent = capturePosts();
  const client = new Client({ baseUrl: "https://agent.test" });

  const { session } = await client.sessions.create({ history });
  await session.send("Can we submit a case anyway?");

  expect(sent).toEqual([{ history }, { message: "Can we submit a case anyway?" }]);
});

it("creates a session without a request body when it has no history or stubs", async () => {
  const sent = capturePosts();

  await new Client({ baseUrl: "https://agent.test" }).sessions.create();

  expect(sent).toEqual([undefined]);
});

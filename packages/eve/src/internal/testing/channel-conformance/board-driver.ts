import { createTestBoard } from "#internal/testing/board-server.js";
import { boardChannel } from "#public/channels/board/index.js";
import {
  type ChannelDriver,
  numberedOptions,
  type Person,
  type PlatformCall,
} from "#internal/testing/channel-conformance/harness.js";

let nextConversation = 0;

/**
 * Drives a real in-memory `@vercel/board`: people post as `local:user:<name>` through its HTTP
 * API, and the channel registers, pulls, and replies as a Vercel project it lets in. Wake-ups
 * are the channel's own pull route, since an in-memory board can't call a URL.
 */
export function boardDriver(): ChannelDriver {
  nextConversation += 1;
  const channelPath = `conformance-${nextConversation}`;
  const team = createTestBoard();
  const mount = new URL(team.url).pathname;

  let root: string | undefined;
  const queued: { person: Person; text: string }[] = [];

  async function postQueued(): Promise<void> {
    for (const { person, text } of queued.splice(0)) {
      const response = await team.fetch(
        new Request(`${team.url}/messages`, {
          body: JSON.stringify(
            root === undefined ? { channel: channelPath, text } : { re: root, text },
          ),
          headers: {
            authorization: `Bearer ${await team.personToken(person)}`,
            "content-type": "application/json",
          },
          method: "POST",
        }),
      );
      if (!response.ok) throw new Error(`posting as ${person} failed: ${await response.text()}`);
      root ??= ((await response.json()) as { message: { id: string } }).message.id;
    }
  }

  return {
    name: "board",
    personId: "alice",
    capabilities: ["another-person", "text-replies"],
    surface: "shared",
    createChannel: (record) =>
      boardChannel({
        api: {
          async fetch(input, init) {
            const request = new Request(input, init);
            const path = new URL(request.url).pathname.slice(mount.length) || "/";
            // People's messages land just before the channel pulls, as they would before a wake-up.
            if (path === "/watchers/matches") await postQueued();
            const bodyText = request.method === "POST" ? await request.clone().text() : "";
            const response = await team.fetch(request);
            const answered = response.clone();
            record({
              body: bodyText === "" ? {} : JSON.parse(bodyText),
              method: `${request.method} ${path}`,
              response: answered.headers.get("content-type")?.includes("json")
                ? await answered.json()
                : null,
            });
            return response;
          },
        },
        credentials: { token: () => team.eveToken() },
        tail: channelPath,
        url: team.url,
      }),
    message(text, person) {
      queued.push({ person, text });
      return new Request("https://agent.example.com/eve/v1/board/wake", {
        headers: { "x-eve-board-poll": "1" },
        method: "POST",
      });
    },
    findOptions(call, prompt) {
      const text = postedText(call);
      return text?.includes(prompt) === true ? numberedOptions(text) : undefined;
    },
    press: () => {
      throw new Error("A board has no buttons to press.");
    },
    postedText,
  };
}

function postedText(call: PlatformCall): string | undefined {
  if (call.method !== "POST /messages") return undefined;
  const body = call.body as { readonly re?: string; readonly text?: string };
  return body.re === undefined ? undefined : body.text;
}

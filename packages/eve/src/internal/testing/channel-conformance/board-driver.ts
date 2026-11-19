import { createTestBoard, type TestBoard } from "#internal/testing/board-server.js";
import { boardChannel } from "#public/channels/board/index.js";
import {
  type ChannelDriver,
  numberedOptions,
  type PlatformCall,
} from "#internal/testing/channel-conformance/harness.js";

let nextConversation = 0;

export function boardDriver(): ChannelDriver {
  nextConversation += 1;
  const channelPath = `conformance-${nextConversation}`;
  let created: TestBoard | undefined;
  const team = () => (created ??= createTestBoard());
  let root: string | undefined;

  return {
    name: "board",
    personId: "alice",
    capabilities: ["another-person", "text-replies"],
    surface: "shared",
    createChannel(record) {
      team().onCall(record);
      return boardChannel({ tail: channelPath });
    },
    dispose: () => created?.dispose(),
    message(text, person) {
      team().beforePull(async () => {
        const posted = await team().post(
          person,
          root === undefined ? { channel: channelPath, text } : { re: root, text },
        );
        root ??= posted.id;
      });
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

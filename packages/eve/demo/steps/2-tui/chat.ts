// Step 2: the same agent in eve's terminal UI (the one `eve dev` shows). `node chat.ts`.
import { defineAgent, eve, memorySandbox } from "eve/experimental/embed";
import { runTerminal } from "eve/experimental/embed/terminal";

const chat = defineAgent({
  name: "chat",
  model: "anthropic/claude-haiku-4.5",
  instructions: "You are a friendly assistant with a shell. Keep answers short.",
  definitions: eve.defaults({ sandbox: memorySandbox() }),
});

await runTerminal(chat, { name: "chat" });

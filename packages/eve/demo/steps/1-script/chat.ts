// Step 1: an eve agent in a script. `node chat.ts "your message"` sends one message, streams the
// reply (with a line per tool call), and exits.
import { createSession, defineAgent, eve, localUser, memorySandbox } from "eve/experimental/embed";

const chat = defineAgent({
  name: "chat",
  model: "anthropic/claude-haiku-4.5",
  instructions: "You are a friendly assistant with a shell. Keep answers short.",
  definitions: eve.defaults({ sandbox: memorySandbox() }),
});

const message = process.argv.slice(2).join(" ") || "What's today's date? Check with the shell.";
const session = createSession(chat, { identity: localUser() });

const delivery = await session.send(message);
for await (const event of delivery.stream()) {
  if (event.type === "content.delta") process.stdout.write(event.data.delta);
  if (event.type === "call.requested")
    console.log(`\n[${event.data.capability.name}] ${JSON.stringify(event.data.input)}`);
}
console.log();
await session.close();

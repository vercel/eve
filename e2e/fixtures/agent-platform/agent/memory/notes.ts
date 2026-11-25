import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";

export default defineMemory({
  description: "Remember Alice's project notes.",
  provider: fileMemory(),
  scope: () => "agent-platform-e2e",
});

import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";

export default defineMemory({
  description: "Facts the team has shared: preferences, conventions, and decisions.",
  provider: fileMemory(),
  scope: "team",
});

import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { byPrincipal } from "eve/memory/scope";

export default defineMemory({
  description: "Each person's preferences, such as tone and formatting.",
  provider: fileMemory(),
  scope: byPrincipal,
});

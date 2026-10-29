import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";

export default defineMemory({
  description: "Facts the team shares about suppliers: lead times and minimum orders.",
  provider: fileMemory(),
  scope: "team",
});

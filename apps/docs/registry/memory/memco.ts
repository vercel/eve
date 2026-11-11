import { memco } from "@memco/eve";
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";

export default defineMemory({
  description: "The team's shared memory: search it before working something out.",
  provider: memco({ domain: "knowledge" }),
  scope: byPrincipal,
});

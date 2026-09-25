import { arcanaMemory } from "@kybernesis/arcana/memory";
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";

export default defineMemory({
  description: "Recall and manage durable context for the current user.",
  provider: arcanaMemory({
    apiKey: process.env.ARCANA_API_KEY!,
    workspace: process.env.ARCANA_WORKSPACE!,
  }),
  scope: byPrincipal,
});

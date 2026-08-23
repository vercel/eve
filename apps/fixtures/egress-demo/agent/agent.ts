import { defineAgent } from "eve";

export default defineAgent({
  model: resolveModel(),
});

function resolveModel(): `${string}/${string}` {
  return (process.env.EVE_DEMO_MODEL ?? "zai/glm-5.2") as `${string}/${string}`;
}

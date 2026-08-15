import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

if (process.env.EVE_E2E_MODEL === "mock") {
  process.env.EVE_MOCK_AUTHORED_MODELS = "1";
}

const base = e2eAgentConfig();

export default defineAgent({
  ...base,
  // Merge, don't replace: `e2eAgentConfig()` selects the workflow world
  // under `experimental.workflow`, and dropping it silently falls back to
  // the local world on the Postgres/Vercel suites (their durability check
  // then fails with zero workflow runs).
  experimental: {
    ...base.experimental,
    subagentPersistentSessions: true,
  },
  reasoning: "high",
});

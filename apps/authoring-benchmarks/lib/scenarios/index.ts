import { basename } from "node:path";

import type { AuthoringScenario } from "../harness-agent.js";
import { imessageScenario } from "./imessage.js";

const scenarios: Readonly<Record<string, AuthoringScenario>> = {
  "author-000-imessage": imessageScenario,
};

export function authoringScenario(fixturePath: string): AuthoringScenario {
  const name = basename(fixturePath);
  const scenario = scenarios[name];
  if (scenario === undefined) {
    throw new Error(`No authoring scenario is registered for ${JSON.stringify(name)}.`);
  }
  return scenario;
}

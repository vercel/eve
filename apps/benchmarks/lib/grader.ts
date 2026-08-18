import { existsSync, readFileSync } from "node:fs";

import { AGENT_EVAL_DIRECTORY, SOURCE_ROOT, WORKSPACE_ENV, WORLD_EVENTS_PATH } from "./paths.js";
import type { AuthoringTranscriptEntry, AuthoringWorldEvent } from "./protocol.js";

interface AgentEvalResults {
  readonly o11y?: {
    readonly shellCommands?: ReadonlyArray<{
      readonly command: string;
      readonly exitCode?: number;
      readonly success?: boolean;
    }>;
  };
}

export const workspace = process.env[WORKSPACE_ENV];
if (workspace === undefined) throw new Error(`${WORKSPACE_ENV} is required.`);

export interface AuthoringEvalResult {
  readonly commands: ReadonlyArray<string>;
  readonly transcript: ReadonlyArray<AuthoringTranscriptEntry>;
  readonly worldEvents: ReadonlyArray<AuthoringWorldEvent>;
}

export function subjectDefaultAgentModel(): string {
  const source = readFileSync(
    `${SOURCE_ROOT}/packages/eve/src/shared/default-agent-model.ts`,
    "utf8",
  );
  const model = source.match(/DEFAULT_AGENT_MODEL_ID\s*=\s*["']([^"']+)["']/u)?.[1];
  if (model === undefined) throw new Error("Could not read the subject's default agent model.");
  return model;
}

export function authoringEval(): AuthoringEvalResult {
  const results = readJson<AgentEvalResults>(`${AGENT_EVAL_DIRECTORY}/results.json`);
  return {
    commands: (results.o11y?.shellCommands ?? []).map((entry) => entry.command),
    transcript: readJson<ReadonlyArray<AuthoringTranscriptEntry>>(
      `${AGENT_EVAL_DIRECTORY}/harness-transcript.json`,
    ),
    worldEvents: readJsonLines(WORLD_EVENTS_PATH),
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readJsonLines(path: string): AuthoringWorldEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuthoringWorldEvent);
}

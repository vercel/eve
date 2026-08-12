import { existsSync, readFileSync } from "node:fs";

interface AgentEvalResults {
  readonly o11y?: {
    readonly shellCommands?: ReadonlyArray<{
      readonly command: string;
      readonly exitCode?: number;
      readonly success?: boolean;
    }>;
  };
}

export interface AuthoringTranscriptEntry {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface AuthoringWorldEvent {
  readonly type: string;
  readonly data?: Record<string, unknown>;
}

export interface AuthoringEvalResult {
  readonly commands: ReadonlyArray<string>;
  readonly transcript: ReadonlyArray<AuthoringTranscriptEntry>;
  readonly worldEvents: ReadonlyArray<AuthoringWorldEvent>;
}

const AGENT_EVAL_DIRECTORY = "__agent_eval__";
const AUTHORING_EVAL_DIRECTORY = "__authoring_eval__";

export function authoringEval(): AuthoringEvalResult {
  const results = readJson<AgentEvalResults>(`${AGENT_EVAL_DIRECTORY}/results.json`);
  return {
    commands: (results.o11y?.shellCommands ?? []).map((entry) => entry.command),
    transcript: readJson<ReadonlyArray<AuthoringTranscriptEntry>>(
      `${AGENT_EVAL_DIRECTORY}/harness-transcript.json`,
    ),
    worldEvents: readJsonLines(`${AUTHORING_EVAL_DIRECTORY}/world-events.jsonl`),
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

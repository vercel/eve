import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { EveEvalContext } from "eve/evals";

// Multi-deployment sandbox coverage. One `eve eval` run drives exactly one
// target, so the redeploy boundary between phases is owned by the
// `e2e-vercel (sandbox-redeploy)` CI job: it deploys the fixture, runs one
// phase eval, redeploys, and runs the next. Session ids cross the phase
// boundary through a state file in the fixture working directory (the eval
// test body runs on the CI host, not on the deployment). Outside that
// orchestration every phase eval skips itself, so the standard fixture
// matrix stays green.

export type RedeployPhase = "write" | "read-persist" | "read-rotated";

export const REDEPLOY_PHASE_ENV = "EVE_E2E_REDEPLOY_PHASE";

/** File the write phase creates inside each session's sandbox workspace. */
export const REDEPLOY_FILE_PATH = "/workspace/redeploy-note.txt";
export const REDEPLOY_FILE_TOKEN = "sandbox-redeploy-ok-K4W";

/**
 * Mirrors `redeploy-variant/skills/deploy-note.md`, which the CI job copies
 * into `agent/skills/` before the third deployment.
 */
export const REDEPLOY_SKILL_NAME = "deploy-note";
export const REDEPLOY_SKILL_TOKEN = "deploy-note-skill-ok-Q2H";

const STATE_FILE_PATH = resolve(".eve", "evals", "redeploy-state.json");

export interface RedeployState {
  /** Session whose sandbox must survive the unchanged redeploy. */
  readonly persistSessionId: string;
  /** Session whose sandbox must rotate when the skill-adding redeploy lands. */
  readonly rotateSessionId: string;
}

/** Skips the eval unless the CI orchestration selected this phase. */
export function requireRedeployPhase(t: EveEvalContext, phase: RedeployPhase): void {
  const active = process.env[REDEPLOY_PHASE_ENV];
  if (active !== phase) {
    t.skip(
      `Runs only as the "${phase}" phase of the redeploy orchestration ` +
        `(${REDEPLOY_PHASE_ENV}=${active ?? "unset"}).`,
    );
  }
}

export async function saveRedeployState(state: RedeployState): Promise<void> {
  await mkdir(dirname(STATE_FILE_PATH), { recursive: true });
  await writeFile(STATE_FILE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

export async function loadRedeployState(): Promise<RedeployState> {
  const raw = JSON.parse(await readFile(STATE_FILE_PATH, "utf8")) as Partial<RedeployState>;
  if (typeof raw.persistSessionId !== "string" || typeof raw.rotateSessionId !== "string") {
    throw new Error(
      `Redeploy state file ${STATE_FILE_PATH} is missing session ids; run the "write" phase first.`,
    );
  }
  return { persistSessionId: raw.persistSessionId, rotateSessionId: raw.rotateSessionId };
}

import { spawn } from "node:child_process";

import { getDefaultCodexTokenBroker } from "#public/models/openai/chatgpt/token-broker.js";

/** Ensures Codex owns a usable ChatGPT login before setup authors `chatgpt()`. */
export async function ensureChatGptAuth(): Promise<void> {
  const state = await getDefaultCodexTokenBroker().refreshState();
  if (state.kind === "ready") return;

  const child = spawn("codex", ["login"], { stdio: "inherit" });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`codex login failed (${signal ?? code ?? "unknown"}).`));
    });
  });

  const refreshed = await getDefaultCodexTokenBroker().refreshState();
  if (refreshed.kind !== "ready") {
    throw new Error("Codex login completed without a usable ChatGPT session.");
  }
}

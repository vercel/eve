import type { LogWarningsFunction } from "ai";

import { createLogger } from "#internal/logging.js";

const log = createLogger("harness.ai-sdk-warnings");

/**
 * Routes AI SDK provider warnings through eve's logger unless the application
 * already configured the SDK's global warning hook. AI SDK warnings are
 * successful-call diagnostics, so they use the info channel instead of stderr.
 */
export function ensureAiSdkWarningLogger(): void {
  if (globalThis.AI_SDK_LOG_WARNINGS !== undefined) {
    return;
  }

  // AI SDK reads the global, not the similarly named environment variable.
  // Honor the conventional shell setting by translating it once at startup.
  globalThis.AI_SDK_LOG_WARNINGS =
    process.env.AI_SDK_LOG_WARNINGS === "false" ? false : logAiSdkWarnings;
}

const logAiSdkWarnings: LogWarningsFunction = ({ warnings, provider, model }) => {
  for (const warning of warnings) {
    log.info("AI SDK provider warning", {
      model,
      provider,
      warning,
    });
  }
};

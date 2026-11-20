import type { LogWarningsFunction } from "ai";

import { createLogger } from "#internal/logging.js";

const log = createLogger("harness.ai-sdk-warnings");

export function ensureAiSdkWarningLogger(): void {
  if (globalThis.AI_SDK_LOG_WARNINGS !== undefined) {
    return;
  }

  globalThis.AI_SDK_LOG_WARNINGS =
    process.env.AI_SDK_LOG_WARNINGS === "false" ? false : logAiSdkWarnings;
}

const logAiSdkWarnings: LogWarningsFunction = ({ warnings, provider, model }) => {
  for (const warning of warnings) {
    const fields = {
      model,
      provider,
      warning,
    };
    const message = "message" in warning ? warning.message : (warning.details ?? warning.feature);

    if (warning.type === "compatibility") {
      log.info(message, fields);
    } else {
      log.warn(message, fields);
    }
  }
};

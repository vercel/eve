import { createLogger } from "#internal/logging.js";
import type { DevBootProgressReporter } from "#internal/dev-boot-progress.js";
import { startCliLiveRow } from "#cli/ui/live-row.js";

const devBootLog = createLogger("dev.boot");

export function createDevBootProgressReporter(
  row: ReturnType<typeof startCliLiveRow> | undefined,
): DevBootProgressReporter {
  return (event) => {
    switch (event.type) {
      case "phase-started":
        row?.update("Building your agent", event.phase);
        devBootLog.debug(event.phase);
        return;
      case "phase-finished":
        devBootLog.debug(`${event.phase} finished`, { ms: event.elapsedMs });
        return;
      case "before-first-paint":
        row?.stop();
        return;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  };
}

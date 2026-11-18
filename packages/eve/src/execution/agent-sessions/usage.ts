import { addTokenUsage } from "#shared/token-usage-math.js";
import type { TokenUsage } from "#shared/token-usage.js";

export interface RunUsageTally {
  record(turnUsage: TokenUsage): void;
  total(): TokenUsage | undefined;
}

export function createRunUsageTally(onRecord?: () => void): RunUsageTally {
  let spent: TokenUsage | undefined;
  return {
    record(turnUsage) {
      spent = spent === undefined ? turnUsage : addTokenUsage(spent, turnUsage);
      onRecord?.();
    },
    total: () => spent,
  };
}

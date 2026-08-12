/** Environment flag set for processes that belong to an `eve dev` session. */
export const EVE_DEV_ENV_FLAG = "EVE_DEV";

/** Reports whether this process belongs to an `eve dev` session. */
export function isEveDevEnvironment(): boolean {
  return process.env[EVE_DEV_ENV_FLAG] === "1";
}

/**
 * Sets `NODE_ENV` to `mode` when it has no non-empty value, leaving an
 * operator's explicit value untouched.
 */
export function defaultNodeEnv(mode: "development" | "production"): void {
  const env = process.env as Record<string, string | undefined>;
  if (!env.NODE_ENV) {
    env.NODE_ENV = mode;
  }
}

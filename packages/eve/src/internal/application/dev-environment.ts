/** Environment flag set for processes that belong to an `eve dev` session. */
export const EVE_DEV_ENV_FLAG = "EVE_DEV";

/** Reports whether this process belongs to an `eve dev` session. */
export function isEveDevEnvironment(): boolean {
  return process.env[EVE_DEV_ENV_FLAG] === "1";
}

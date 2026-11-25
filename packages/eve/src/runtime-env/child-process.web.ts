import type { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import type { createInterface as nodeCreateInterface } from "node:readline";

function unavailable(): never {
  throw new Error("Child processes are not available in this runtime.");
}

export const spawn: typeof nodeSpawn = () => unavailable();
export const spawnSync: typeof nodeSpawnSync = () => unavailable();
export const createReadlineInterface: typeof nodeCreateInterface = () => unavailable();

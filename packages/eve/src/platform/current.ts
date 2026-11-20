import { createPlatform, DEFAULT_PLATFORM_TARGET } from "#platform/create.js";
import type { Platform } from "#platform/types.js";

const INSTALLED_PLATFORM = Symbol.for("eve.platform");

interface PlatformHolder {
  [INSTALLED_PLATFORM]?: Platform;
}

const holder = globalThis as PlatformHolder;

export function installPlatform(platform: Platform): () => void {
  const previous = holder[INSTALLED_PLATFORM];
  holder[INSTALLED_PLATFORM] = platform;
  return () => {
    holder[INSTALLED_PLATFORM] = previous;
  };
}

export function currentPlatform(): Platform {
  return (holder[INSTALLED_PLATFORM] ??= createPlatform(DEFAULT_PLATFORM_TARGET));
}

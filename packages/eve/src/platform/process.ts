import type { PlatformDeclaration } from "#platform/declaration.js";
import { createEntities, type Entities } from "#platform/entities.js";
import { createLifetime, type Lifetime } from "#runtime/lifetime.js";

interface ProcessPlatform {
  readonly declaration: PlatformDeclaration<unknown>;
  readonly lifetime: Lifetime;
  entities?: Entities;
  pending?: Promise<Entities>;
}

const PROCESS_PLATFORM = Symbol.for("eve.process-platform");

const holder = globalThis as { [PROCESS_PLATFORM]?: ProcessPlatform };

export function selectProcessPlatform(declaration: PlatformDeclaration<unknown>): void {
  if (holder[PROCESS_PLATFORM]?.declaration !== declaration) {
    holder[PROCESS_PLATFORM] = { declaration, lifetime: createLifetime() };
  }
}

function selected(): ProcessPlatform {
  const platform = holder[PROCESS_PLATFORM];
  if (platform === undefined) {
    throw new Error(
      "This process has no app and no platform module. eve reads the platform of a process without an app from the generated platform module, which every eve build output loads.",
    );
  }
  return platform;
}

export function selectedProcessPlatformNow(): Entities | undefined {
  return holder[PROCESS_PLATFORM] === undefined ? undefined : processPlatformNow();
}

export async function processPlatform(): Promise<Entities> {
  const platform = selected();
  if (platform.entities !== undefined) return platform.entities;
  platform.pending ??= Promise.resolve(platform.declaration.context?.()).then((context) => {
    platform.entities ??= createEntities(platform.declaration, context, platform.lifetime);
    return platform.entities;
  });
  return await platform.pending;
}

export function processPlatformNow(): Entities {
  const platform = selected();
  if (platform.entities !== undefined) return platform.entities;
  const context = platform.declaration.context?.();
  if (context instanceof Promise) {
    platform.pending ??= context.then((resolved) => {
      platform.entities ??= createEntities(platform.declaration, resolved, platform.lifetime);
      return platform.entities;
    });
    throw new Error(
      "This process has no app, and its platform's context() is still resolving. Read the platform after it resolves, or start the app.",
    );
  }
  platform.entities = createEntities(platform.declaration, context, platform.lifetime);
  return platform.entities;
}

import { createEntities, type Entities } from "#platform/entities.js";
import { vercelCorePlatform } from "#platform/vercel/core.js";

let fallbackPlatform: Entities | undefined;

export function builtInPlatform(): Entities {
  return (fallbackPlatform ??= createFallbackPlatform());
}

export function platformOf(app: { readonly platform: Entities } | undefined): Entities {
  return app?.platform ?? builtInPlatform();
}

function createFallbackPlatform(): Entities {
  const core = createEntities(vercelCorePlatform, undefined);
  const readThrough = (entity: string, module: string): never => {
    throw new Error(
      `With no app, read the "${entity}" platform entity through ${module}, which falls back to the Vercel built-in.`,
    );
  };
  return Object.freeze({
    get deployment() {
      return core.deployment;
    },
    get identity() {
      return core.identity;
    },
    get network() {
      return core.network;
    },
    get telemetry() {
      return core.telemetry;
    },
    get build(): never {
      return readThrough("build", "#platform/build.js");
    },
    get compute(): never {
      return readThrough("compute", "#platform/hosted-sandbox.js");
    },
    get models(): never {
      return readThrough("models", "#platform/models.js");
    },
    get storage(): never {
      return readThrough("storage", "#platform/document-store.js");
    },
    get triggers(): never {
      return readThrough("triggers", "#platform/schedules.js");
    },
  });
}

import { appOf, runInApp } from "#context/app.js";
import { contextStorage } from "#context/container.js";
import type { Durable } from "#execution/durable.js";
import { installedDurable } from "#execution/hosts.js";
import { definePlatform, type PlatformFields } from "#platform/declaration.js";
import { createEntities, type Entities } from "#platform/entities.js";
import { selectProcessPlatform } from "#platform/process.js";
import { builtInHosts, processApp, type App } from "#runtime/app.js";
import { createLifetime } from "#runtime/lifetime.js";

type TestPlatformFields = Partial<PlatformFields<undefined>>;

export function testPlatform(fields: TestPlatformFields = {}) {
  return definePlatform({
    deployment: () => ({
      environment: () => undefined,
      deploymentId: () => undefined,
      productionHost: () => undefined,
      publicHost: () => undefined,
      scope: () => undefined,
    }),
    ...fields,
  });
}

export function testEntities(fields: TestPlatformFields = {}): Entities {
  return createEntities(testPlatform(fields), undefined);
}

export function testApp(
  input: { readonly platform?: Entities; readonly durable?: Durable } = {},
): App {
  const hosts = builtInHosts();
  return {
    platform: input.platform ?? testEntities(),
    get durable(): Durable {
      const durable = input.durable ?? installedDurable(hosts);
      if (durable === undefined) throw new Error("The test app has no durable engine installed.");
      return durable;
    },
    hosts,
    lifetime: createLifetime(),
  };
}

export function inTestApp<T>(fn: () => T, app: App = testApp()): T {
  return appOf(contextStorage.getStore()) === undefined ? runInApp(app, fn) : fn();
}

export function startTestApp(app: App = testApp()): App {
  const started = processApp();
  started.platform = app.platform;
  started.started = app;
  selectProcessPlatform(testPlatform());
  return app;
}

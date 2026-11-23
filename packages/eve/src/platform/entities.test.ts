import { describe, expect, it, vi } from "vitest";

import { definePlatform } from "#platform/declaration.js";
import { createEntities, type Deployment } from "#platform/entities.js";

const deployment: Deployment = {
  environment: () => "production",
  deploymentId: () => "dpl_1",
  productionHost: () => undefined,
  publicHost: () => undefined,
  scope: () => undefined,
};

describe("createEntities", () => {
  it("makes each entity at its first read, one time per declaration's entities", () => {
    const factory = vi.fn(() => deployment);
    const platform = definePlatform({ deployment: factory });
    const entities = createEntities(platform, undefined);

    expect(factory).not.toHaveBeenCalled();
    expect(entities.deployment).toBe(deployment);
    expect(entities.deployment).toBe(deployment);
    expect(factory).toHaveBeenCalledTimes(1);

    createEntities(platform, undefined).deployment;
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("gives a factory the other entities and the platform context", () => {
    const platform = definePlatform<{ readonly attribute: string }>({
      deployment: () => deployment,
      telemetry: (app, context) => ({
        sessionAttribute: `${context.attribute}:${app.platform.deployment.deploymentId()}`,
      }),
    });

    expect(createEntities(platform, { attribute: "host" }).telemetry.sessionAttribute).toBe(
      "host:dpl_1",
    );
  });

  it("gives the defaults for the entities a platform leaves out", () => {
    const entities = createEntities(definePlatform({ deployment: () => deployment }), undefined);

    expect(entities.storage.documents).toBeUndefined();
    expect(entities.triggers).toBeUndefined();
    expect(entities.compute).toBeUndefined();
    expect(entities.models).toBeUndefined();
    expect(entities.identity.developmentScope).toBeUndefined();
    expect(entities.network.self).toBeUndefined();
    expect(entities.telemetry.sessionAttribute).toBeUndefined();
    expect(entities.build).toEqual({});
  });

  it("names both entities when two factories read each other", () => {
    const platform = definePlatform({
      deployment: () => deployment,
      storage: (app) => ({ documents: app.platform.network.token as never }),
      network: (app) => ({ token: app.platform.storage.documents as never }),
    });

    expect(() => createEntities(platform, undefined).storage).toThrow(
      'The "network" and "storage" factories of the platform read each other.',
    );
  });

  it("refuses a factory that returns a promise", () => {
    const platform = definePlatform({
      deployment: () => deployment,
      storage: () => Promise.resolve({}) as never,
    });

    expect(() => createEntities(platform, undefined).storage).toThrow(
      'The "storage" factory of the platform returned a promise.',
    );
  });

  it.each(["", "default", "docker", "just-bash"])(
    'refuses a hosted sandbox named "%s", which DefaultSandbox records for its own providers',
    (name) => {
      const platform = definePlatform({
        deployment: () => deployment,
        compute: () => ({ name }) as never,
      });

      expect(() => createEntities(platform, undefined).compute).toThrow(
        `A hosted sandbox can't be named "${name}"`,
      );
    },
  );

  it("refuses an object that definePlatform() did not make", () => {
    expect(() => createEntities({ deployment: () => deployment } as never, undefined)).toThrow(
      "Build the platform with definePlatform",
    );
  });
});

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

  it.each([
    {
      cycle: "storage → network → telemetry → storage",
      platform: definePlatform({
        deployment: (app) => ({ ...deployment, scope: app.platform.storage.documents as never }),
        storage: (app) => ({ documents: app.platform.network.token as never }),
        network: (app) => ({ token: app.platform.telemetry.spanProcessor as never }),
        telemetry: (app) => ({ sessionAttribute: app.platform.storage.documents as never }),
      }),
    },
    {
      cycle: "storage → storage",
      platform: definePlatform({
        deployment: (app) => ({ ...deployment, scope: app.platform.storage.documents as never }),
        storage: (app) => ({ documents: app.platform.storage.documents }),
      }),
    },
  ])("names the whole read cycle $cycle in order", ({ cycle, platform }) => {
    expect(() => createEntities(platform, undefined).deployment).toThrow(
      `The entity factories of the platform read in a cycle: ${cycle}.`,
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

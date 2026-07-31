import {
  createDockerSandboxProvider,
  referenceDockerSandboxResource,
  restoreDockerSandboxResource,
  type DockerSandboxReference,
  type DockerSandboxResource,
  type DockerSandboxTemplateReference,
} from "#execution/sandbox/bindings/local.js";
import { defineSandboxAdapter, type Sandbox } from "#shared/sandbox-value.js";
import { defineSandboxTemplate } from "#shared/sandbox-template.js";
import type { DockerSandboxCreateOptions } from "#public/sandbox/docker-sandbox.js";

export type {
  DockerSandboxCreateOptions,
  DockerSandboxNetworkPolicy,
  DockerSandboxPullPolicy,
} from "#public/sandbox/docker-sandbox.js";

/**
 * Build-time options for a Docker Sandbox template.
 */
export interface DockerSandboxTemplateOptions extends DockerSandboxCreateOptions {
  /**
   * Runs during template prewarm after eve hydrates the managed workspace.
   */
  readonly prepare?: (sandbox: Sandbox) => Promise<void> | void;
}

/**
 * A build-prewarmed Docker Sandbox base.
 */
export interface DockerSandboxTemplate {
  create(): Promise<Sandbox>;
}

const asDockerSandbox = defineSandboxAdapter<DockerSandboxResource, DockerSandboxReference>({
  type: "docker.com/container/v1",
  reference: referenceDockerSandboxResource,
  restore: restoreDockerSandboxResource,
  session(resource) {
    return resource.session;
  },
  shutdown(resource) {
    return resource.shutdown();
  },
});

/**
 * Docker Sandbox creation and build-prewarming.
 */
export const DockerSandbox = {
  /**
   * Creates the durable Docker Sandbox returned by an authored definition.
   */
  async create(options: DockerSandboxCreateOptions = {}): Promise<Sandbox> {
    return await asDockerSandbox.create(async (context) => {
      return await createDockerSandboxProvider({
        createOptions: options,
      }).create({ context });
    });
  },

  /**
   * Declares a reusable Docker base that eve prepares during build.
   */
  template(options: DockerSandboxTemplateOptions = {}): DockerSandboxTemplate {
    const { prepare, ...createOptions } = options;
    const provider = createDockerSandboxProvider({ createOptions });
    return defineSandboxTemplate<DockerSandboxTemplateReference, undefined, DockerSandboxTemplate>(
      {
        revision: createOptions,
        type: "docker.com/container-template/v1",
        async prewarm({ appRoot, hydrate, log, templateId }) {
          return await provider.prewarm({
            appRoot,
            log,
            async prepare(resource) {
              const sandbox = asDockerSandbox(resource);
              await hydrate(sandbox);
              await prepare?.(sandbox);
            },
            templateId,
          });
        },
        async create({ reference }) {
          return await asDockerSandbox.create(async (context) => {
            return await provider.create({ context, template: reference });
          });
        },
      },
      (create) => ({
        async create(): Promise<Sandbox> {
          return await create(undefined);
        },
      }),
    );
  },
};

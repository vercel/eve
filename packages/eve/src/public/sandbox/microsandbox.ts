import {
  createMicrosandboxSandboxProvider,
  referenceMicrosandboxResource,
  restoreMicrosandboxResource,
  type MicrosandboxReference,
  type MicrosandboxResource,
  type MicrosandboxTemplateReference,
} from "#execution/sandbox/bindings/local.js";
import { defineSandboxAdapter, type Sandbox } from "#shared/sandbox-value.js";
import { defineSandboxTemplate } from "#shared/sandbox-template.js";
import { parseJsonValue } from "#shared/json.js";
import type { MicrosandboxSandboxCreateOptions } from "#public/sandbox/microsandbox-sandbox.js";

export type { MicrosandboxSandboxCreateOptions } from "#public/sandbox/microsandbox-sandbox.js";

/**
 * Build-time options for a microsandbox template.
 */
export interface MicrosandboxSandboxTemplateOptions extends MicrosandboxSandboxCreateOptions {
  /**
   * Runs during template prewarm after eve hydrates the managed workspace.
   */
  readonly prepare?: (sandbox: Sandbox) => Promise<void> | void;
}

/**
 * A build-prewarmed microsandbox base.
 */
export interface MicrosandboxSandboxTemplate {
  create(): Promise<Sandbox>;
}

const asMicrosandbox = defineSandboxAdapter<MicrosandboxResource, MicrosandboxReference>({
  type: "microsandbox.dev/sandbox/v1",
  reference: referenceMicrosandboxResource,
  restore: restoreMicrosandboxResource,
  session(resource) {
    return resource.session;
  },
  shutdown(resource) {
    return resource.shutdown();
  },
});

/**
 * microsandbox creation and build-prewarming.
 */
export const MicrosandboxSandbox = {
  /**
   * Creates the durable microsandbox returned by an authored definition.
   */
  async create(options: MicrosandboxSandboxCreateOptions = {}): Promise<Sandbox> {
    return await asMicrosandbox.create(async (context) => {
      return await createMicrosandboxSandboxProvider({
        createOptions: options,
      }).create({ context });
    });
  },

  /**
   * Declares a reusable microsandbox base that eve prepares during build.
   */
  template(options: MicrosandboxSandboxTemplateOptions = {}): MicrosandboxSandboxTemplate {
    const { prepare, ...createOptions } = options;
    const provider = createMicrosandboxSandboxProvider({ createOptions });
    return defineSandboxTemplate<
      MicrosandboxTemplateReference,
      undefined,
      MicrosandboxSandboxTemplate
    >(
      {
        revision: parseJsonValue(createOptions),
        type: "microsandbox.dev/sandbox-template/v1",
        async prewarm({ appRoot, hydrate, log, templateId }) {
          return await provider.prewarm({
            appRoot,
            log,
            async prepare(resource) {
              const sandbox = asMicrosandbox(resource);
              await hydrate(sandbox);
              await prepare?.(sandbox);
            },
            templateId,
          });
        },
        async create({ reference }) {
          return await asMicrosandbox.create(async (context) => {
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

import {
  createJustBashSandboxProvider,
  referenceJustBashSandboxResource,
  restoreJustBashSandboxResource,
  type JustBashSandboxReference,
  type JustBashSandboxResource,
  type JustBashSandboxTemplateReference,
} from "#execution/sandbox/bindings/local.js";
import { defineSandboxAdapter, type Sandbox } from "#shared/sandbox-value.js";
import { defineSandboxTemplate } from "#shared/sandbox-template.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";

export type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";

/**
 * Build-time options for a just-bash template.
 */
export interface JustBashSandboxTemplateOptions extends JustBashSandboxCreateOptions {
  /**
   * Runs during template prewarm after eve hydrates the managed workspace.
   */
  readonly prepare?: (sandbox: Sandbox) => Promise<void> | void;
}

/**
 * A build-prewarmed just-bash filesystem base.
 */
export interface JustBashSandboxTemplate {
  create(): Promise<Sandbox>;
}

const asJustBashSandbox = defineSandboxAdapter<JustBashSandboxResource, JustBashSandboxReference>({
  type: "just-bash.dev/sandbox/v1",
  reference: referenceJustBashSandboxResource,
  restore: restoreJustBashSandboxResource,
  session(resource) {
    return resource.session;
  },
  shutdown(resource) {
    return resource.shutdown();
  },
});

/**
 * just-bash sandbox creation and build-prewarming.
 */
export const JustBashSandbox = {
  /**
   * Creates the durable just-bash sandbox returned by an authored definition.
   */
  async create(options: JustBashSandboxCreateOptions = {}): Promise<Sandbox> {
    return await asJustBashSandbox.create(async (context) => {
      return await createJustBashSandboxProvider({
        createOptions: options,
      }).create({ context });
    });
  },

  /**
   * Declares a reusable just-bash base that eve prepares during build.
   */
  template(options: JustBashSandboxTemplateOptions = {}): JustBashSandboxTemplate {
    const { prepare, ...createOptions } = options;
    const provider = createJustBashSandboxProvider({ createOptions });
    return defineSandboxTemplate<
      JustBashSandboxTemplateReference,
      undefined,
      JustBashSandboxTemplate
    >(
      {
        revision: createOptions,
        type: "just-bash.dev/sandbox-template/v1",
        async prewarm({ appRoot, hydrate, log, templateId }) {
          return await provider.prewarm({
            appRoot,
            log,
            async prepare(resource) {
              const sandbox = asJustBashSandbox(resource);
              await hydrate(sandbox);
              await prepare?.(sandbox);
            },
            templateId,
          });
        },
        async create({ reference }) {
          return await asJustBashSandbox.create(async (context) => {
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

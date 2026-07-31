import {
  createVercelSandboxResource,
  prewarmVercelSandboxTemplate,
  referenceVercelSandboxResource,
  restoreVercelSandboxResource,
  shutdownVercelSandboxResource,
  type VercelSandboxReference,
  type VercelSandboxResource,
  type VercelSandboxTemplateReference,
} from "#execution/sandbox/bindings/vercel.js";
import { defineSandboxAdapter, type Sandbox } from "#shared/sandbox-value.js";
import { defineSandboxTemplate } from "#shared/sandbox-template.js";
import type {
  VercelSandboxCreateOptions,
  VercelSandboxSessionOptions,
} from "#public/sandbox/vercel-sandbox.js";
import { parseJsonObject } from "#shared/json.js";

export type {
  VercelSandboxCreateOptions,
  VercelSandboxSessionOptions,
  VercelSandboxSource,
} from "#public/sandbox/vercel-sandbox.js";

/**
 * Build-time options for a Vercel Sandbox template.
 */
export type VercelSandboxTemplateOptions = VercelSandboxCreateOptions & {
  /**
   * Runs during template prewarm after eve hydrates the managed workspace.
   */
  readonly prepare?: (sandbox: Sandbox) => Promise<void> | void;
};

/**
 * Options for intentionally sharing a named Vercel Sandbox.
 */
export type VercelSandboxGetOrCreateOptions = VercelSandboxSessionOptions & {
  readonly name: string;
};

/**
 * A build-prewarmed Vercel Sandbox base.
 */
export interface VercelSandboxTemplate {
  create(options?: VercelSandboxSessionOptions): Promise<Sandbox>;
  getOrCreate(options: VercelSandboxGetOrCreateOptions): Promise<Sandbox>;
}

const asVercelSandbox = defineSandboxAdapter<VercelSandboxResource, VercelSandboxReference>({
  type: "vercel.com/sandbox/v1",
  reference: referenceVercelSandboxResource,
  restore: restoreVercelSandboxResource,
  session(resource) {
    return resource.session;
  },
  shutdown: shutdownVercelSandboxResource,
});

/**
 * Vercel Sandbox creation and build-prewarming.
 */
export const VercelSandbox = {
  /**
   * Creates the durable Vercel Sandbox returned by an authored definition.
   */
  async create(options: VercelSandboxCreateOptions = {}): Promise<Sandbox> {
    return await asVercelSandbox.create(async (context) => {
      return await createVercelSandboxResource({
        context,
        options,
      });
    });
  },

  /**
   * Declares a reusable Vercel Sandbox base that eve prepares during build.
   */
  template(options: VercelSandboxTemplateOptions = {}): VercelSandboxTemplate {
    const { prepare, ...templateCreateOptions } = options;
    return defineSandboxTemplate<
      VercelSandboxTemplateReference,
      { readonly name?: string; readonly options?: VercelSandboxSessionOptions },
      VercelSandboxTemplate
    >(
      {
        revision: createVercelTemplateOptionsRevision(templateCreateOptions),
        type: "vercel.com/sandbox-template/v1",
        async prewarm({ hydrate, log, templateId }) {
          return await prewarmVercelSandboxTemplate({
            log,
            options: templateCreateOptions,
            async prepare(resource) {
              const sandbox = asVercelSandbox(resource);
              await hydrate(sandbox);
              await prepare?.(sandbox);
            },
            templateId,
          });
        },
        async create({ options: request, reference }) {
          return await asVercelSandbox.create(async (context) => {
            return await createVercelSandboxResource({
              context,
              name: request.name,
              options: templateCreateOptions,
              sessionOptions: request.options,
              template: reference,
            });
          });
        },
      },
      (create) => ({
        async create(createOptions: VercelSandboxSessionOptions = {}): Promise<Sandbox> {
          return await create({ options: createOptions });
        },
        async getOrCreate({
          name,
          ...createOptions
        }: VercelSandboxGetOrCreateOptions): Promise<Sandbox> {
          return await create({ name, options: createOptions });
        },
      }),
    );
  },
};

function createVercelTemplateOptionsRevision(options: VercelSandboxCreateOptions) {
  return parseJsonObject(options);
}

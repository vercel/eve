import {
  selectAvailableDefaultSandboxProvider,
  type DefaultSandboxProviderName,
  type DefaultSandboxOptions,
} from "#execution/sandbox/default-provider.js";
import type { Sandbox } from "#shared/sandbox-value.js";
import {
  defineSandboxTemplate,
  getSandboxTemplateInternal,
  withSandboxTemplateBindings,
  type SandboxTemplate,
} from "#shared/sandbox-template.js";
import { parseJsonValue, type JsonObject, type JsonValue } from "#shared/json.js";
import { DockerSandbox } from "#public/sandbox/docker.js";
import { JustBashSandbox } from "#public/sandbox/just-bash.js";
import { MicrosandboxSandbox } from "#public/sandbox/microsandbox.js";
import { VercelSandbox } from "#public/sandbox/vercel.js";

export type { DefaultSandboxOptions };

/**
 * Build-time options for eve's availability-aware default template.
 */
export interface DefaultSandboxTemplateOptions {
  /**
   * Runs during template prewarm after eve hydrates the managed workspace.
   */
  readonly prepare?: (sandbox: Sandbox) => Promise<void> | void;
}

/**
 * A build-prewarmed base owned by the provider selected during build.
 */
export interface DefaultSandboxTemplate {
  create(): Promise<Sandbox>;
}

interface DefaultTemplateReference extends JsonObject {
  readonly provider: DefaultSandboxProviderName;
  readonly reference: JsonValue;
}

/**
 * Availability-aware sandbox creation used by eve's framework default.
 */
export const DefaultSandbox = {
  /**
   * Creates a durable sandbox using the best provider available at runtime.
   */
  async create(options?: DefaultSandboxOptions): Promise<Sandbox> {
    switch (selectAvailableDefaultSandboxProvider()) {
      case "docker":
        return await DockerSandbox.create(options?.docker);
      case "just-bash":
        return await JustBashSandbox.create(options?.justBash);
      case "microsandbox":
        return await MicrosandboxSandbox.create(options?.microsandbox);
      case "vercel":
        return await VercelSandbox.create(options?.vercel);
    }
  },

  /**
   * Declares a build-prewarmed base using the provider available at build
   * time. The frozen reference records that provider for runtime creation.
   */
  template(options: DefaultSandboxTemplateOptions = {}): DefaultSandboxTemplate {
    return defineSandboxTemplate<DefaultTemplateReference, undefined, DefaultSandboxTemplate>(
      {
        type: "eve/default-sandbox-template/v2",
        async prewarm(input) {
          const provider = selectAvailableDefaultSandboxProvider();
          const template = createProviderTemplate(provider, options);
          return {
            provider,
            reference: parseJsonValue(await getSandboxTemplateInternal(template).prewarm(input)),
          };
        },
        async create({ reference }) {
          const template = createProviderTemplate(reference.provider, options);
          return await withSandboxTemplateBindings(
            new Map([[getSandboxTemplateInternal(template), reference.reference]]),
            async () => await template.create(undefined),
          );
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

function createProviderTemplate(
  provider: DefaultSandboxProviderName,
  options: DefaultSandboxTemplateOptions,
): SandboxTemplate<undefined> {
  switch (provider) {
    case "docker":
      return DockerSandbox.template(options);
    case "just-bash":
      return JustBashSandbox.template(options);
    case "microsandbox":
      return MicrosandboxSandbox.template(options);
    case "vercel":
      return VercelSandbox.template(options);
  }
}

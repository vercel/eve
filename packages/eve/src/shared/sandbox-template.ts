import { createHash } from "node:crypto";

import { contextStorage } from "#context/container.js";
import { SandboxTemplateBindingsKey } from "#context/keys.js";
import { withVirtualContextValue } from "#context/virtual-scope.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import type { Sandbox } from "#shared/sandbox-value.js";

const SANDBOX_TEMPLATE = Symbol.for("eve.sandbox-template");

/**
 * Build assets discovered beside an exported sandbox template.
 */
export interface SandboxTemplateAssets {
  readonly dockerfile?: {
    readonly contextPath: string;
    readonly path: string;
  };
}

/**
 * Input passed to a provider's build-time template implementation.
 *
 * The app author supplies only template options such as `prepare`. eve
 * supplies the build identity, application root, assets, hydration, and log
 * sink directly to the provider implementation.
 */
export interface SandboxTemplatePrewarmInput {
  readonly appRoot: string;
  readonly assets: SandboxTemplateAssets;
  hydrate(sandbox: Sandbox): Promise<void>;
  readonly log?: (message: string) => void;
  readonly templateId: string;
}

/**
 * Provider implementation behind one exported sandbox template.
 */
export interface SandboxTemplateDefinition<Reference extends JsonValue, CreateOptions> {
  /**
   * Stable protocol discriminator owned by the provider implementation.
   *
   * App sandbox definitions never see or supply this value.
   */
  readonly type: string;
  /**
   * Provider-owned inputs that affect the prewarmed base.
   *
   * eve hashes this value into its private template identity. App authors do
   * not supply cache or revalidation keys.
   */
  readonly revision?: JsonValue;
  /**
   * Produces the provider reference frozen into the deployment.
   */
  prewarm(input: SandboxTemplatePrewarmInput): Promise<Reference>;
  /**
   * Creates a durable sandbox from the frozen provider reference.
   */
  create(input: {
    readonly options: CreateOptions;
    readonly reference: Reference;
  }): Sandbox | Promise<Sandbox>;
}

/**
 * A provider-owned base that eve can prepare during build.
 */
export interface SandboxTemplate<CreateOptions = Record<string, never>> {
  /**
   * Creates a durable sandbox from this build-prewarmed base.
   */
  create(options: CreateOptions): Promise<Sandbox>;
}

type SandboxTemplateCreate<CreateOptions> = (options: CreateOptions) => Promise<Sandbox>;

export interface InternalSandboxTemplate {
  readonly implementationId: string;
  prewarm(input: SandboxTemplatePrewarmInput): Promise<unknown>;
}

type SandboxTemplateWithInternal<CreateOptions> = SandboxTemplate<CreateOptions> & {
  readonly [SANDBOX_TEMPLATE]: InternalSandboxTemplate;
};

/**
 * Defines the provider lifecycle behind a build-prewarmed template.
 *
 * Runtime references are scoped to the active sandbox definition invocation;
 * the template is never process-globally bound. Providers may use the second
 * argument to expose simpler author-facing methods over the internal
 * `create(options)` operation.
 */
export function defineSandboxTemplate<
  Reference extends JsonValue,
  CreateOptions = Record<string, never>,
>(definition: SandboxTemplateDefinition<Reference, CreateOptions>): SandboxTemplate<CreateOptions>;
export function defineSandboxTemplate<
  Reference extends JsonValue,
  CreateOptions,
  AuthorApi extends object,
>(
  definition: SandboxTemplateDefinition<Reference, CreateOptions>,
  defineAuthorApi: (create: SandboxTemplateCreate<CreateOptions>) => AuthorApi,
): AuthorApi;
export function defineSandboxTemplate<Reference extends JsonValue, CreateOptions>(
  definition: SandboxTemplateDefinition<Reference, CreateOptions>,
  defineAuthorApi?: (create: SandboxTemplateCreate<CreateOptions>) => object,
): object {
  const implementationId = `template-${stableHash(
    stableJsonStringify({
      revision: parseJsonValue(definition.revision ?? null),
      type: expectSandboxTemplateType(definition.type),
    }),
  )}`;
  const internal: InternalSandboxTemplate = {
    implementationId,
    async prewarm(input) {
      return await definition.prewarm(input);
    },
  };
  const create: SandboxTemplateCreate<CreateOptions> = async (options) => {
    const reference = readActiveSandboxTemplateReference(internal);
    if (reference === undefined) {
      throw new Error(
        "Sandbox template has no prewarmed build result. Export it from the sandbox module and run eve build.",
      );
    }
    // Compilation erases provider reference types; JSON validation is the shared boundary.
    return await definition.create({
      options,
      reference: parseJsonValue(reference) as Reference,
    });
  };
  const authorApi =
    defineAuthorApi?.(create) ?? ({ create } satisfies SandboxTemplate<CreateOptions>);
  Object.defineProperty(authorApi, SANDBOX_TEMPLATE, { value: internal });
  return authorApi;
}

/**
 * Returns whether a module export is a build-prewarmable sandbox template.
 */
export function isSandboxTemplate(value: unknown): value is SandboxTemplate {
  return isSandboxTemplateWithInternal(value);
}

/**
 * Reads the framework-owned template lifecycle.
 */
export function getSandboxTemplateInternal<CreateOptions>(
  template: SandboxTemplate<CreateOptions>,
): InternalSandboxTemplate {
  if (!isSandboxTemplateWithInternal(template)) {
    throw new TypeError("Expected a SandboxTemplate value.");
  }
  return template[SANDBOX_TEMPLATE];
}

function isSandboxTemplateWithInternal(
  value: unknown,
): value is SandboxTemplateWithInternal<unknown> {
  return typeof value === "object" && value !== null && SANDBOX_TEMPLATE in value;
}

/**
 * Runs one sandbox definition with its exact exported template references.
 */
export async function withSandboxTemplateBindings<T>(
  bindings: ReadonlyMap<InternalSandboxTemplate, unknown>,
  callback: () => T | Promise<T>,
): Promise<T> {
  return await withVirtualContextValue(SandboxTemplateBindingsKey, bindings, callback);
}

function readActiveSandboxTemplateReference(
  template: InternalSandboxTemplate,
): unknown | undefined {
  return contextStorage.getStore()?.get(SandboxTemplateBindingsKey)?.get(template);
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function expectSandboxTemplateType(type: string): string {
  if (type.trim() === "") {
    throw new TypeError("Sandbox template type must be a non-empty provider protocol name.");
  }
  return type;
}

function stableJsonStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`)
    .join(",")}}`;
}

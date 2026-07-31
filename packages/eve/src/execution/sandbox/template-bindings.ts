import { waitForDevelopmentSandboxPrewarm } from "#execution/sandbox/development-prewarm.js";
import {
  prewarmAppSandboxes,
  type PrewarmedSandboxTemplateBinding,
} from "#execution/sandbox/prewarm.js";
import { waitForSandboxTemplatePrewarmLock } from "#execution/sandbox/template-prewarm-lock.js";
import { isEveDevEnvironment } from "#internal/application/optional-package-install.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createRuntimeSandboxTemplateKey } from "#runtime/sandbox/keys.js";
import type { RuntimeRegisteredSandbox } from "#runtime/sandbox/registry.js";
import { SandboxTemplateUnavailableError } from "#shared/sandbox-errors.js";
import {
  getSandboxTemplateInternal,
  withSandboxTemplateBindings,
  type InternalSandboxTemplate,
} from "#shared/sandbox-template.js";

interface ResolvedSandboxTemplateBinding {
  readonly exportName: string;
  readonly template: InternalSandboxTemplate;
  readonly templateKey: string;
  reference: unknown;
}

interface SandboxTemplateBindingScope {
  run<T>(callback: () => T | Promise<T>): Promise<T>;
}

/**
 * Keeps provider references invocation-scoped while development rebuilds
 * replace stale references behind the same author-facing template.
 */
export async function createSandboxTemplateBindingScope(input: {
  readonly appRoot: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId: string;
  readonly revision: string;
  readonly sandbox: RuntimeRegisteredSandbox;
}): Promise<SandboxTemplateBindingScope> {
  const bindings = await Promise.all(
    input.sandbox.definition.templates.map(async ({ exportName, reference, template }) => {
      const internal = getSandboxTemplateInternal(template);
      return {
        exportName,
        reference,
        template: internal,
        templateKey: await createRuntimeSandboxTemplateKey({
          compiledArtifactsSource: input.compiledArtifactsSource,
          exportName,
          implementationId: internal.implementationId,
          nodeId: input.nodeId,
          revision: input.revision,
        }),
      };
    }),
  );

  async function prepare(): Promise<void> {
    assertManagedWorkspaceHasTemplate(input.sandbox);
    if (bindings.length === 0) {
      return;
    }

    const backgroundBindings = await waitForDevelopmentSandboxPrewarm({
      appRoot: input.appRoot,
      compiledArtifactsSource: input.compiledArtifactsSource,
      log: logDevelopmentSandbox,
    });
    const ready = applyPrewarmedBindings(bindings, input.nodeId, backgroundBindings);
    if (isEveDevEnvironment() && !ready) {
      applyPrewarmedBindings(bindings, input.nodeId, await rebuildTemplates(input));
    }

    await Promise.all(
      bindings.map(async ({ template, templateKey }) => {
        await waitForSandboxTemplatePrewarmLock({
          appRoot: input.appRoot,
          provider: template.implementationId,
          log: logDevelopmentSandbox,
          templateKey,
        });
      }),
    );
  }

  async function invoke<T>(callback: () => T | Promise<T>): Promise<T> {
    return await withSandboxTemplateBindings(createReferenceMap(bindings), callback);
  }

  return {
    async run(callback) {
      await prepare();
      try {
        return await invoke(callback);
      } catch (error) {
        if (
          input.compiledArtifactsSource.kind !== "disk" ||
          !SandboxTemplateUnavailableError.is(error)
        ) {
          throw error;
        }
        applyPrewarmedBindings(bindings, input.nodeId, await rebuildTemplates(input));
        return await invoke(callback);
      }
    },
  };
}

function createReferenceMap(
  bindings: readonly ResolvedSandboxTemplateBinding[],
): ReadonlyMap<InternalSandboxTemplate, unknown> {
  const references = new Map<InternalSandboxTemplate, unknown>();
  for (const binding of bindings) {
    if (binding.reference !== undefined) {
      references.set(binding.template, binding.reference);
    }
  }
  return references;
}

function applyPrewarmedBindings(
  bindings: readonly ResolvedSandboxTemplateBinding[],
  nodeId: string,
  prewarmed: readonly PrewarmedSandboxTemplateBinding[],
): boolean {
  const references = new Map(
    prewarmed.map((binding) => [
      createBindingKey(binding.nodeId, binding.exportName, binding.templateKey),
      binding.reference,
    ]),
  );
  for (const binding of bindings) {
    const reference = references.get(
      createBindingKey(nodeId, binding.exportName, binding.templateKey),
    );
    if (reference !== undefined) {
      binding.reference = reference;
    }
  }
  return bindings.every((binding) => binding.reference !== undefined);
}

async function rebuildTemplates(input: {
  readonly appRoot: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<readonly PrewarmedSandboxTemplateBinding[]> {
  return await prewarmAppSandboxes({
    appRoot: input.appRoot,
    compiledArtifactsSource: input.compiledArtifactsSource,
    log: logDevelopmentSandbox,
  });
}

function assertManagedWorkspaceHasTemplate(sandbox: RuntimeRegisteredSandbox): void {
  if (
    sandbox.definition.templates.length === 0 &&
    (sandbox.workspaceResourceRoot.contentHash !== undefined ||
      sandbox.workspaceResourceRoot.rootEntries.length > 0)
  ) {
    throw new Error(
      `Sandbox "${sandbox.definition.logicalPath}" has a managed workspace but exports no SandboxTemplate.`,
    );
  }
}

function createBindingKey(nodeId: string, exportName: string, templateKey: string): string {
  return `${nodeId}\0${exportName}\0${templateKey}`;
}

function logDevelopmentSandbox(message: string): void {
  if (isEveDevEnvironment()) {
    console.log(message);
  }
}

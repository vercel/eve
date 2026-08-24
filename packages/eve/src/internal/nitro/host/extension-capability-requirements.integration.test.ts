import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXTENSION_CAPABILITY_VERSIONS } from "#compiler/extension-compatibility.js";
import { createAgentSourceManifest } from "#discover/manifest.js";
import { deriveExtensionCapabilityRequirements } from "#internal/nitro/host/extension-capability-requirements.js";
import type { ExtensionDeclarationBinding } from "#internal/nitro/host/extension-declaration-binding.js";

describe("deriveExtensionCapabilityRequirements", () => {
  it("loads the extension declaration from its binding instead of its logical path", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "eve-extension-declaration-binding-"));
    const physicalPath = join(sourceRoot, "physical", "extension.mjs");
    await mkdir(join(sourceRoot, "physical"), { recursive: true });
    await mkdir(join(sourceRoot, "logical"), { recursive: true });
    await writeFile(join(sourceRoot, "package.json"), '{"type":"module"}\n', "utf8");
    await writeFile(physicalPath, "export default { schema: {} };\n", "utf8");
    await writeFile(
      join(sourceRoot, "logical", "extension.mjs"),
      'throw new Error("logical declaration path executed");\n',
      "utf8",
    );
    const declarationBinding: ExtensionDeclarationBinding = {
      backing: {
        externalDependencies: [],
        extensionScope: { namespace: "acme-crm", sourceRoot },
        kind: "filesystem",
        sourcePath: physicalPath,
      },
      logicalPath: "logical/extension.mjs",
      owner: { kind: "extension", namespace: "crm", packageName: "@acme/crm" },
    };

    await expect(
      deriveExtensionCapabilityRequirements({
        declarationBinding,
        manifest: createAgentSourceManifest({
          agentId: "crm-extension",
          agentRoot: sourceRoot,
          appRoot: sourceRoot,
        }),
      }),
    ).resolves.toEqual({
      extension: EXTENSION_CAPABILITY_VERSIONS.extension,
      config: EXTENSION_CAPABILITY_VERSIONS.config,
    });
  });
});

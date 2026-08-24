import {
  EVE_RUNTIME_SOURCE_REVISION_TOKEN,
  resolveEveRuntimeSourceRevision,
  resolveFrameworkAgentSourceRevision,
} from "#framework-sources/revision.js";

// Keep the token split so the package build does not stamp the bundler plugin
// itself. Application bundles still need the compiler-selected package version
// embedded alongside the runtime source hash.
const EVE_PACKAGE_VERSION_TOKEN = ["__EVE", "PACKAGE_VERSION__"].join("_");

/** Stamps and guards one bundle against framework source changing mid-build. */
export function createFrameworkSourceRevisionPlugin(
  input: {
    readonly expectedRevision?: string;
    readonly resolveRevision?: () => string;
  } = {},
): Record<string, unknown> {
  const resolveRevision =
    input.resolveRevision ?? (() => resolveFrameworkAgentSourceRevision({ fresh: true }));
  const expectedRevision = input.expectedRevision ?? resolveFrameworkAgentSourceRevision();
  const expectedPackageVersion = readFrameworkPackageVersion(expectedRevision);
  const assertCurrent = (): void => {
    const current = resolveRevision();
    if (current !== expectedRevision) {
      throw new Error(
        `Framework source revision changed while compiling artifacts: expected "${expectedRevision}", received "${current}".`,
      );
    }
  };

  return {
    name: "eve-framework-source-revision",
    buildStart: assertCurrent,
    buildEnd: assertCurrent,
    transform(code: string) {
      const stampsRuntimeRevision = code.includes(EVE_RUNTIME_SOURCE_REVISION_TOKEN);
      const stampsPackageVersion = code.includes(EVE_PACKAGE_VERSION_TOKEN);
      if (!stampsRuntimeRevision && !stampsPackageVersion) return undefined;
      assertCurrent();
      return code
        .replaceAll(
          EVE_RUNTIME_SOURCE_REVISION_TOKEN,
          stampsRuntimeRevision
            ? resolveEveRuntimeSourceRevision({ fresh: true })
            : EVE_RUNTIME_SOURCE_REVISION_TOKEN,
        )
        .replaceAll(EVE_PACKAGE_VERSION_TOKEN, expectedPackageVersion);
    },
  };
}

function readFrameworkPackageVersion(revision: string): string {
  const packageSeparator = revision.indexOf("@");
  const contentSeparator = revision.indexOf(":", packageSeparator + 1);
  if (
    packageSeparator <= 0 ||
    contentSeparator <= packageSeparator + 1 ||
    contentSeparator === revision.length - 1
  ) {
    throw new Error(`Invalid framework source revision "${revision}".`);
  }
  return revision.slice(packageSeparator + 1, contentSeparator);
}

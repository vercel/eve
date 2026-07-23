import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const extractorRequire = createRequire(require.resolve("@microsoft/api-extractor/package.json"));
const ts = extractorRequire("typescript");

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
export const EVE_ROOT = join(REPO_ROOT, "packages/eve");
export const COMPATIBILITY_SOURCE = join(EVE_ROOT, "src/compiler/extension-compatibility.ts");
export const CONTRACT_ROOT = join(EVE_ROOT, "extension-contracts");
export const ENTRYPOINT_ROOT = join(CONTRACT_ROOT, "entrypoints");
export const COMPATIBILITY_FIXTURE_ROOT = join(CONTRACT_ROOT, "compatibility");
export const REPORT_ROOT = join(CONTRACT_ROOT, "reports");
export const COMPATIBILITY_FIXTURE_PLACEHOLDER = "REPLACE_WITH_RETAINED_AUTHORING_EXAMPLE";

export const PUBLIC_SURFACES = [
  { path: "src/public/extension/index.ts", capabilities: ["extension", "config"] },
  { path: "src/public/tools/index.ts", capabilities: ["tool", "dynamicTool"] },
  { path: "src/public/connections/index.ts", capabilities: ["connection"] },
  { path: "src/public/hooks/index.ts", capabilities: ["hook"] },
  { path: "src/public/skills/index.ts", capabilities: ["skill", "dynamicSkill"] },
  {
    path: "src/public/instructions/index.ts",
    capabilities: ["instructions", "dynamicInstructions"],
  },
  { path: "src/public/context/index.ts", capabilities: ["state"] },
];

export function toPosix(path) {
  return sep === "/" ? path : path.split(sep).join("/");
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(property) {
  if (
    ts.isIdentifier(property.name) ||
    ts.isStringLiteral(property.name) ||
    ts.isNumericLiteral(property.name)
  ) {
    return property.name.text;
  }
  throw new Error("Extension capability contracts must use static property names.");
}

function objectLiteral(expression, description) {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isObjectLiteralExpression(unwrapped)) {
    throw new Error(`${description} must be an object literal.`);
  }
  return unwrapped;
}

function propertyAssignment(object, name, description) {
  const property = object.properties.find(
    (candidate) => ts.isPropertyAssignment(candidate) && propertyName(candidate) === name,
  );
  if (!property || !ts.isPropertyAssignment(property)) {
    throw new Error(`${description} must define ${name}.`);
  }
  return property;
}

function numericValue(expression, description) {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isNumericLiteral(unwrapped)) throw new Error(`${description} must be a number.`);
  return Number(unwrapped.text);
}

function numericArray(expression, description) {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isArrayLiteralExpression(unwrapped)) {
    throw new Error(`${description} must be an array literal.`);
  }
  return unwrapped.elements.map((element) => numericValue(element, `${description} entry`));
}

function droppedEpochs(expression, description) {
  const object = objectLiteral(expression, description);
  return Object.fromEntries(
    object.properties.map((property) => {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error(`${description} must contain property assignments.`);
      }
      const reason = unwrapExpression(property.initializer);
      if (!ts.isStringLiteral(reason)) {
        throw new Error(`${description}.${propertyName(property)} must be a string literal.`);
      }
      return [propertyName(property), reason.text];
    }),
  );
}

function contractTable(source) {
  const sourceFile = ts.createSourceFile(
    COMPATIBILITY_SOURCE,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "EXTENSION_CAPABILITY_CONTRACTS" &&
        declaration.initializer
      ) {
        return objectLiteral(declaration.initializer, "EXTENSION_CAPABILITY_CONTRACTS");
      }
    }
  }
  throw new Error("Could not find EXTENSION_CAPABILITY_CONTRACTS.");
}

export function parseCapabilityConfiguration(source) {
  const contracts = Object.fromEntries(
    contractTable(source).properties.map((property) => {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error("EXTENSION_CAPABILITY_CONTRACTS must contain property assignments.");
      }
      const capability = propertyName(property);
      const contract = objectLiteral(property.initializer, `Capability ${capability}`);
      return [
        capability,
        {
          current: numericValue(
            propertyAssignment(contract, "current", `Capability ${capability}`).initializer,
            `Capability ${capability}.current`,
          ),
          supported: numericArray(
            propertyAssignment(contract, "supported", `Capability ${capability}`).initializer,
            `Capability ${capability}.supported`,
          ),
          dropped: droppedEpochs(
            propertyAssignment(contract, "dropped", `Capability ${capability}`).initializer,
            `Capability ${capability}.dropped`,
          ),
        },
      ];
    }),
  );
  return {
    contracts,
    current: Object.fromEntries(
      Object.entries(contracts).map(([capability, contract]) => [capability, contract.current]),
    ),
    support: Object.fromEntries(
      Object.entries(contracts).map(([capability, contract]) => [capability, contract.supported]),
    ),
  };
}

export function bumpCapabilityConfiguration(source, capability, decision) {
  const table = contractTable(source);
  const property = table.properties.find(
    (candidate) => ts.isPropertyAssignment(candidate) && propertyName(candidate) === capability,
  );
  if (!property || !ts.isPropertyAssignment(property)) {
    throw new Error(`Unknown extension capability "${capability}".`);
  }

  const configuration = parseCapabilityConfiguration(source);
  const contract = configuration.contracts[capability];
  const nextVersion = contract.current + 1;
  const supported = decision.retain
    ? [...contract.supported, nextVersion]
    : [...contract.supported.filter((version) => version !== contract.current), nextVersion];
  const dropped = decision.retain
    ? contract.dropped
    : { ...contract.dropped, [contract.current]: decision.reason };
  const droppedSource = Object.entries(dropped)
    .map(([version, reason]) => `${version}: ${JSON.stringify(reason)}`)
    .join(", ");
  const replacement = `${capability}: { current: ${nextVersion}, supported: [${supported.join(", ")}], dropped: {${droppedSource === "" ? "" : ` ${droppedSource} `}} }`;

  return {
    source: `${source.slice(0, property.getStart())}${replacement}${source.slice(property.end)}`,
    previousVersion: contract.current,
    version: nextVersion,
  };
}

export function retainedCompatibilityFixture(capability, version) {
  return `/**
 * Replace this scaffold with a representative ${capability} epoch ${version}
 * authoring example that must continue to compile against the current eve API.
 * ${COMPATIBILITY_FIXTURE_PLACEHOLDER}
 */
export {};
`;
}

export function collectExportNames(source, { valuesOnly = false } = {}) {
  const names = new Set();
  const sourceFile = ts.createSourceFile(
    "extension-capability-entrypoint.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause) {
      if (!ts.isNamedExports(statement.exportClause)) continue;
      for (const specifier of statement.exportClause.elements) {
        if (valuesOnly && (statement.isTypeOnly || specifier.isTypeOnly)) continue;
        names.add(specifier.name.text);
      }
      continue;
    }
    const isExported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!isExported) continue;
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name) names.add(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
      continue;
    }
    if (ts.isEnumDeclaration(statement)) {
      names.add(statement.name.text);
      continue;
    }
    if (
      !valuesOnly &&
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
    ) {
      names.add(statement.name.text);
    }
  }
  return names;
}

export async function validateCapabilityConfiguration(configuration) {
  const issues = [];
  const capabilities = Object.keys(configuration.current);
  const entrypointEntries = await readdir(ENTRYPOINT_ROOT, { withFileTypes: true });
  const entrypointCapabilities = entrypointEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name.slice(0, -3))
    .sort();

  for (const capability of capabilities) {
    const { current: version, dropped, supported } = configuration.contracts[capability];
    if (!Number.isInteger(version) || version < 1) {
      issues.push({
        file: toPosix(relative(REPO_ROOT, COMPATIBILITY_SOURCE)),
        message: `Capability "${capability}" must have a positive integer epoch.`,
      });
    }
    if (!supported.includes(version)) {
      issues.push({
        file: toPosix(relative(REPO_ROOT, COMPATIBILITY_SOURCE)),
        message: `Capability "${capability}" does not list its current epoch ${version} as supported.`,
      });
    }
    if (new Set(supported).size !== supported.length) {
      issues.push({
        file: toPosix(relative(REPO_ROOT, COMPATIBILITY_SOURCE)),
        message: `Capability "${capability}" lists a supported epoch more than once.`,
      });
    }
    const droppedVersions = Object.keys(dropped).map(Number);
    for (const supportedVersion of supported) {
      if (
        !Number.isInteger(supportedVersion) ||
        supportedVersion < 1 ||
        supportedVersion > version
      ) {
        issues.push({
          file: toPosix(relative(REPO_ROOT, COMPATIBILITY_SOURCE)),
          message: `Capability "${capability}" has invalid supported epoch ${supportedVersion}; supported epochs must be positive and no newer than current epoch ${version}.`,
        });
      }
    }
    for (const droppedVersion of droppedVersions) {
      if (!Number.isInteger(droppedVersion) || droppedVersion < 1 || droppedVersion >= version) {
        issues.push({
          file: toPosix(relative(REPO_ROOT, COMPATIBILITY_SOURCE)),
          message: `Capability "${capability}" has invalid dropped epoch ${droppedVersion}; only historical epochs before current epoch ${version} can be dropped.`,
        });
      }
      if (dropped[String(droppedVersion)].trim() === "") {
        issues.push({
          file: toPosix(relative(REPO_ROOT, COMPATIBILITY_SOURCE)),
          message: `Capability "${capability}" must record why epoch ${droppedVersion} was dropped.`,
        });
      }
    }
    for (let historicalVersion = 1; historicalVersion < version; historicalVersion++) {
      const isSupported = supported.includes(historicalVersion);
      const isDropped = Object.hasOwn(dropped, historicalVersion);
      if (isSupported === isDropped) {
        issues.push({
          file: toPosix(relative(REPO_ROOT, COMPATIBILITY_SOURCE)),
          message: `Capability "${capability}" epoch ${historicalVersion} must be classified exactly once as supported or dropped.`,
        });
      }
      if (!isSupported) continue;
      const fixturePath = join(COMPATIBILITY_FIXTURE_ROOT, capability, `v${historicalVersion}.ts`);
      try {
        const fixture = await readFile(fixturePath, "utf8");
        if (fixture.includes(COMPATIBILITY_FIXTURE_PLACEHOLDER)) {
          issues.push({
            file: toPosix(relative(REPO_ROOT, fixturePath)),
            message: `Replace the scaffold with a representative ${capability} epoch ${historicalVersion} authoring example before advertising retained support.`,
          });
        }
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          issues.push({
            file: toPosix(relative(REPO_ROOT, fixturePath)),
            message: `Advertising ${capability} epoch ${historicalVersion} requires an immutable compatibility fixture that exercises the retained authoring contract.`,
          });
          continue;
        }
        throw error;
      }
    }
  }

  const configured = [...capabilities].sort();
  if (JSON.stringify(configured) !== JSON.stringify(entrypointCapabilities)) {
    issues.push({
      file: toPosix(relative(REPO_ROOT, ENTRYPOINT_ROOT)),
      message: `Contract entrypoints must exactly match configured capabilities. Expected ${configured.join(", ")}; found ${entrypointCapabilities.join(", ")}.`,
    });
  }

  for (const surface of PUBLIC_SURFACES) {
    const publicSource = await readFile(join(EVE_ROOT, surface.path), "utf8");
    const publicNames = collectExportNames(publicSource, { valuesOnly: true });
    const contractNames = new Set();
    for (const capability of surface.capabilities) {
      const contractSource = await readFile(join(ENTRYPOINT_ROOT, `${capability}.ts`), "utf8");
      for (const name of collectExportNames(contractSource, { valuesOnly: true })) {
        contractNames.add(name);
      }
    }
    const missing = [...publicNames].filter((name) => !contractNames.has(name)).sort();
    const extra = [...contractNames].filter((name) => !publicNames.has(name)).sort();
    if (missing.length > 0 || extra.length > 0) {
      const details = [
        missing.length > 0 ? `unassigned exports: ${missing.join(", ")}` : "",
        extra.length > 0 ? `unknown exports: ${extra.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      issues.push({
        file: toPosix(relative(REPO_ROOT, join(EVE_ROOT, surface.path))),
        message: `Capability contract roots are incomplete (${details}). Assign every public authoring value to one of: ${surface.capabilities.join(", ")}.`,
      });
    }
  }

  return issues;
}

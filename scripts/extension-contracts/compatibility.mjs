import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const extractorRequire = createRequire(require.resolve("@microsoft/api-extractor/package.json"));
const ts = extractorRequire("typescript");

function reportSource(report) {
  const match = report.match(/```ts\n([\s\S]*?)\n```/);
  if (!match)
    throw new Error("Could not read the TypeScript declaration block from an API report.");
  return match[1];
}

function parsedReport(report, name) {
  const source = reportSource(report);
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Names every declaration API Extractor traced from one capability root. */
export function collectReportDeclarationNames(report) {
  const sourceFile = parsedReport(report, "capability-report.d.ts");
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (
      (ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    }
  }
  return names;
}

function interfaceName(statement) {
  return statement.name.text;
}

function textMultiset(nodes, sourceFile) {
  const counts = new Map();
  for (const node of nodes) {
    const text = node.getText(sourceFile);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return counts;
}

function consumeText(counts, text) {
  const count = counts.get(text) ?? 0;
  if (count === 0) return false;
  if (count === 1) counts.delete(text);
  else counts.set(text, count - 1);
  return true;
}

function interfaceCompatibility(previous, current, previousSource, currentSource) {
  const reasons = [];
  const currentMembers = textMultiset(current.members, currentSource);
  for (const member of previous.members) {
    const text = member.getText(previousSource);
    if (!consumeText(currentMembers, text)) {
      reasons.push(`${interfaceName(previous)} changed or removed member: ${text}`);
    }
  }

  const previousShape = [
    ...(previous.typeParameters ?? []).map((node) => node.getText(previousSource)),
    ...(previous.heritageClauses ?? []).map((node) => node.getText(previousSource)),
  ];
  const currentShape = [
    ...(current.typeParameters ?? []).map((node) => node.getText(currentSource)),
    ...(current.heritageClauses ?? []).map((node) => node.getText(currentSource)),
  ];
  if (JSON.stringify(previousShape) !== JSON.stringify(currentShape)) {
    reasons.push(`${interfaceName(previous)} changed its type parameters or heritage clauses.`);
  }

  for (const [text, count] of currentMembers) {
    const members = current.members.filter((member) => member.getText(currentSource) === text);
    if (members.slice(0, count).some((member) => member.questionToken === undefined)) {
      reasons.push(`${interfaceName(previous)} added a required member: ${text}`);
    }
  }
  return reasons;
}

/**
 * Conservatively recognizes declaration changes that preserve old authored
 * source: new top-level declarations and optional interface members. Anything
 * else requires an explicit compatibility decision.
 */
export function classifyStructuralBackwardCompatibility(previousReport, currentReport) {
  const previous = parsedReport(previousReport, "previous.d.ts");
  const current = parsedReport(currentReport, "current.d.ts");
  const reasons = [];

  const currentInterfaces = new Map(
    current.statements
      .filter(ts.isInterfaceDeclaration)
      .map((statement) => [interfaceName(statement), statement]),
  );
  for (const previousInterface of previous.statements.filter(ts.isInterfaceDeclaration)) {
    const name = interfaceName(previousInterface);
    const currentInterface = currentInterfaces.get(name);
    if (!currentInterface) {
      reasons.push(`Interface ${name} was removed.`);
      continue;
    }
    reasons.push(...interfaceCompatibility(previousInterface, currentInterface, previous, current));
  }

  const currentStatements = textMultiset(
    current.statements.filter((statement) => !ts.isInterfaceDeclaration(statement)),
    current,
  );
  for (const statement of previous.statements.filter(
    (candidate) => !ts.isInterfaceDeclaration(candidate),
  )) {
    const text = statement.getText(previous);
    if (!consumeText(currentStatements, text)) {
      reasons.push(`Declaration changed or was removed: ${text.split("\n", 1)[0]}`);
    }
  }

  return { compatible: reasons.length === 0, reasons };
}

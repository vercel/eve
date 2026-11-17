export function renderLocalSelfModificationExtension(): string {
  return `import selfModification from "eve/extensions/self-modification/local";\n\nexport default selfModification({\n  // model: "provider/model",\n  // reasoning: "high",\n});\n`;
}

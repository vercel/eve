/** Render discovery stubs for Monty's flat external-function interface. */
export function renderPythonSignature(input: {
  name: string;
  inputSchema: unknown;
  outputSchema?: unknown;
}): string {
  const declarations: string[] = [];
  function hint(raw: unknown, name: string): string {
    const schema = raw as Record<string, unknown> | undefined;
    if (!schema || typeof schema !== "object") return "Any";
    const variants = schema.anyOf ?? schema.oneOf;
    if (Array.isArray(variants))
      return variants.map((entry, index) => hint(entry, `${name}${index}`)).join(" | ");
    if (Array.isArray(schema.enum))
      return `Literal[${schema.enum.map((entry) => (entry === null ? "None" : entry === true ? "True" : entry === false ? "False" : JSON.stringify(entry))).join(", ")}]`;
    if (Array.isArray(schema.type))
      return schema.type.map((type) => hint({ ...schema, type }, name)).join(" | ");
    switch (schema.type) {
      case "string":
        return "str";
      case "integer":
        return "int";
      case "number":
        return "float";
      case "boolean":
        return "bool";
      case "null":
        return "None";
      case "array":
        return `list[${hint(schema.items, `${name}Item`)}]`;
      case "object": {
        if (!schema.properties) return "dict[str, Any]";
        const required = new Set(Array.isArray(schema.required) ? schema.required : []);
        const fields = Object.entries(schema.properties as Record<string, unknown>).map(
          ([key, value], index) =>
            `${JSON.stringify(key)}: ${required.has(key) ? "Required" : "NotRequired"}[${hint(value, `${name}Field${index}`)}]`,
        );
        declarations.push(`${name} = TypedDict(${JSON.stringify(name)}, {${fields.join(", ")}})`);
        return name;
      }
      default:
        return "Any";
    }
  }
  const prefix = input.name.replace(/[^A-Za-z0-9_]/gu, "_");
  const argument = hint(input.inputSchema, `${prefix}_Input`);
  const output = hint(input.outputSchema, `${prefix}_Output`);
  return [
    "from typing import Any, Literal, TypedDict, Required, NotRequired",
    ...declarations,
    `async def ${input.name}(input: ${argument}) -> ${output}: ...`,
  ].join("\n");
}

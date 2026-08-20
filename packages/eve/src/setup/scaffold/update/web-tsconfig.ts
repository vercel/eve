import { readFile, writeFile } from "node:fs/promises";

import {
  applyEdits,
  modify,
  type ParseError,
  parse as parseJsonc,
} from "#compiled/jsonc-parser/index.js";

import { pathExists } from "../files.js";
import { WEB_APP_TEMPLATE_FILES } from "../create/web-template.js";

const FORMATTING_OPTIONS = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
} as const;

type JsonObject = Record<string, unknown>;

export async function reconcileWebTsConfig(path: string): Promise<boolean> {
  const templateSource = WEB_APP_TEMPLATE_FILES["tsconfig.json"];
  if (!(await pathExists(path))) {
    await writeFile(path, templateSource, "utf8");
    return true;
  }

  const source = await readFile(path, "utf8");
  const config = parseConfig(source, path);
  const template = parseConfig(templateSource, "Web Chat tsconfig template");
  const compilerOptions = objectValue(config.compilerOptions);
  const templateCompilerOptions = objectValue(template.compilerOptions);
  let nextSource = source;

  const setValue = (propertyPath: (string | number)[], value: unknown): void => {
    nextSource = applyEdits(
      nextSource,
      modify(nextSource, propertyPath, value, { formattingOptions: FORMATTING_OPTIONS }),
    );
  };

  if (config.$schema === undefined) {
    setValue(["$schema"], template.$schema);
  }

  for (const [key, value] of Object.entries(templateCompilerOptions)) {
    if (key === "paths") {
      setValue(["compilerOptions", "paths", "@/*"], ["./*"]);
      continue;
    }
    if (key === "lib") {
      setValue(["compilerOptions", key], mergeStringArrays(compilerOptions[key], value));
      continue;
    }
    if (key === "plugins") {
      setValue(["compilerOptions", key], mergeUniqueValues(compilerOptions[key], value));
      continue;
    }
    if (compilerOptions[key] === undefined) {
      setValue(["compilerOptions", key], value);
    }
  }

  setValue(["include"], mergeStringArrays(config.include, template.include));
  setValue(["exclude"], mergeStringArrays(config.exclude, template.exclude));

  if (nextSource === source) return false;
  await writeFile(path, nextSource, "utf8");
  return true;
}

function parseConfig(source: string, label: string): JsonObject {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isObject(parsed)) {
    throw new Error(`Cannot configure Web Chat because ${label} is not valid JSONC.`);
  }
  return parsed;
}

function objectValue(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeStringArrays(current: unknown, required: unknown): string[] {
  const currentValues = Array.isArray(current)
    ? current.filter((value): value is string => typeof value === "string")
    : [];
  const requiredValues = Array.isArray(required)
    ? required.filter((value): value is string => typeof value === "string")
    : [];
  return [...new Set([...currentValues, ...requiredValues])];
}

function mergeUniqueValues(current: unknown, required: unknown): unknown[] {
  const values = [
    ...(Array.isArray(current) ? current : []),
    ...(Array.isArray(required) ? required : []),
  ];
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

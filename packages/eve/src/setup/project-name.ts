const PROJECT_NAME_REGEX = /^(?!.*---)[a-z0-9-_.]+$/;
const PROJECT_NAME_ERROR =
  "Project name can only contain up to 100 lowercase letters, digits, and the characters '.', '_', '-'.";

/** Returns an error message when a project name is not a safe single path segment. */
export function validateProjectName(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "Project name cannot be empty.";
  if (trimmed === "." || trimmed === "..") return `Project name cannot be '${trimmed}'.`;
  if (!PROJECT_NAME_REGEX.test(trimmed) || trimmed.length > 100) return PROJECT_NAME_ERROR;
  return undefined;
}

/** Parses and normalizes a project name at an external input boundary. */
export function parseProjectName(value: string): string {
  const trimmed = value.trim();
  const validationError = validateProjectName(trimmed);
  if (validationError !== undefined) throw new Error(validationError);
  return trimmed;
}

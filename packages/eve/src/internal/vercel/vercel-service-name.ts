const VERCEL_SERVICE_NAME_PATTERN = /^[a-z](?:[a-z_-]*[a-z])?$/;

export const MAX_VERCEL_SERVICE_NAME_LENGTH = 64;

export function isValidVercelServiceName(name: string): boolean {
  return name.length <= MAX_VERCEL_SERVICE_NAME_LENGTH && VERCEL_SERVICE_NAME_PATTERN.test(name);
}

export function assertValidVercelServiceName(name: string, subject: string): void {
  if (isValidVercelServiceName(name)) return;
  throw new Error(
    `${subject} ${JSON.stringify(name)} is invalid. Vercel service names must use 1-${MAX_VERCEL_SERVICE_NAME_LENGTH} lowercase letters, hyphens, or underscores, beginning and ending with a letter.`,
  );
}

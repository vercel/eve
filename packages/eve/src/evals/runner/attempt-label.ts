export function formatAttemptLabel(id: string, attempt: number | undefined): string {
  return attempt === undefined ? id : `${id}#${attempt}`;
}

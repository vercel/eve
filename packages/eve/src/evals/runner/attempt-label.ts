/** Labels an eval result by id, suffixed with `#<attempt>` when the run repeats evals. */
export function formatAttemptLabel(id: string, attempt: number | undefined): string {
  return attempt === undefined ? id : `${id}#${attempt}`;
}

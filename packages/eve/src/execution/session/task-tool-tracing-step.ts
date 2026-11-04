/** The step output preserves the start time when the workflow resumes in another worker. */
export async function startTaskToolCallsStep(): Promise<number> {
  "use step";
  return Date.now();
}

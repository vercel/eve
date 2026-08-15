export interface QuestionOption {
  id: string;
  value: unknown;
}

interface QuestionWithOptions<O extends QuestionOption> {
  key: string;
  options: readonly O[];
}

/** Finds an option by the stable id used by prompt and wire boundaries. */
export function optionById<O extends QuestionOption>(
  question: QuestionWithOptions<O>,
  id: unknown,
): O | undefined {
  return question.options.find((option) => option.id === String(id));
}

/** Finds an option by its in-process rich value. */
export function optionByValue<O extends QuestionOption>(
  question: QuestionWithOptions<O>,
  value: O["value"],
): O | undefined {
  return question.options.find((option) => option.value === value);
}

/** Maps a rich value to its stable id, rejecting an invalid question definition. */
export function requiredOptionId<O extends QuestionOption>(
  question: QuestionWithOptions<O>,
  value: O["value"],
  role: string,
): string {
  const option = optionByValue(question, value);
  if (option === undefined) {
    throw new Error(`Question "${question.key}" has a ${role} that is not one of its options.`);
  }
  return option.id;
}

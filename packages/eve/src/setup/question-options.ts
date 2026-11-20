export interface QuestionOption {
  id: string;
  value: unknown;
}

interface QuestionWithOptions<O extends QuestionOption> {
  key: string;
  options: readonly O[];
}

export function optionById<O extends QuestionOption>(
  question: QuestionWithOptions<O>,
  id: unknown,
): O | undefined {
  return question.options.find((option) => option.id === String(id));
}

export function optionByValue<O extends QuestionOption>(
  question: QuestionWithOptions<O>,
  value: O["value"],
): O | undefined {
  return question.options.find((option) => option.value === value);
}

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

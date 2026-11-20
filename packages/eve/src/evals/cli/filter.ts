import type { EveEval } from "#evals/types.js";

export function filterEvalsByTags(input: {
  readonly evaluations: readonly EveEval[];
  readonly includeTags: readonly string[];
  readonly excludeTags: readonly string[];
}): EveEval[] {
  return input.evaluations.filter((evaluation) => {
    const tags = evaluation.tags ?? [];

    if (input.includeTags.length > 0 && !tags.some((tag) => input.includeTags.includes(tag))) {
      return false;
    }

    return !tags.some((tag) => input.excludeTags.includes(tag));
  });
}

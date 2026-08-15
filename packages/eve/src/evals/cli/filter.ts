import type { EveEval } from "#evals/types.js";

/**
 * Applies `--tag` and `--exclude-tag` filtering for the `eve eval` command.
 *
 * An eval runs when it carries at least one `includeTags` entry (or no
 * include filter is given) and carries none of the `excludeTags` entries.
 * Exclusion wins over inclusion so suite-level runs (e.g. a mock-model world
 * suite excluding `real-model` evals) can never pull in an excluded eval.
 */
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

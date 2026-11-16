import type { ToolContext } from "eve/tools";

import { parseEntryUrl } from "./entries";
import { withContentfulLocale } from "./locale";
import type { LocaleContext } from "./locale";
import { PAGE_ROUTES } from "./model";

/**
 * Wraps a tool executor with locale resolution for its input space or entry URL.
 *
 * @typeParam I - Tool input containing a space alias or supported URL.
 * @typeParam O - Result produced by the original executor.
 * @param execute - Executor called only after the target space and locale are resolved.
 * @param localeContext - Explicit locale selection and per-operation schema cache.
 * @returns An executor that forwards input, cancellation, and an explicit operation-local locale context.
 * @throws {@link Error} When neither a configured space nor a supported entry URL is available.
 */
export const withLocale =
  <I extends { space?: string; url?: string }, O>(
    execute: (
      input: I,
      ctx: ToolContext,
      localeContext: LocaleContext
    ) => O | Promise<O>
  ) =>
  (input: I, ctx: ToolContext): Promise<O> => {
    const ref = input.url ? parseEntryUrl(input.url) : null;
    let { space } = input;
    if (!space && ref) {
      space = ref.kind === "id" ? ref.spaceId : PAGE_ROUTES[ref.page].spaceId;
    }
    if (!space) {
      throw new Error(
        "A configured Contentful space or entry URL is required."
      );
    }
    return withContentfulLocale(
      space,
      (localeContext) => execute(input, ctx, localeContext),
      ctx.abortSignal
    );
  };

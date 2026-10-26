import type { Announcement } from "#harness/announcements.js";
import { SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";

import { compareCodeUnits } from "./rank.js";
import type { StepCatalog } from "./step-catalog.js";

const ANNOUNCEMENT_KEY = "dynamic-tools";
const MAX_LISTED_NAMES = 20;

/**
 * Hints at the deferred tools and agents a dynamic resolver adds mid-session,
 * since the catalog listing names no deferred entry. The hint gives names
 * only: descriptions are unbounded and the model needs `eve__search` for the
 * signature anyway, so an exact-name search is where it learns the rest.
 * The first step records a silent baseline: entries present then stay out of
 * context like any deferred entry. The recorded value is every name seen so
 * far, so an entry going away changes nothing and only a name the model hasn't
 * seen appends a message. `announced` holds the values announced so far.
 */
export function dynamicToolAnnouncements(
  catalog: Pick<StepCatalog, "deferred" | "dynamic">,
  announced: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, Announcement>> {
  const recorded = announced?.[ANNOUNCEMENT_KEY];
  const present = [...catalog.deferred.keys()]
    .filter((name) => catalog.dynamic.has(name))
    .sort(compareCodeUnits);
  // Nothing to add to a baseline that is already recorded.
  if (present.length === 0 && recorded !== undefined) return {};
  const names = new Set([...recordedNames(recorded), ...present]);
  return {
    [ANNOUNCEMENT_KEY]: {
      value: JSON.stringify([...names].sort(compareCodeUnits)),
      render: (previous) => {
        if (previous === undefined) return undefined;
        const known = new Set(recordedNames(previous));
        const added = present.filter((name) => !known.has(name));
        return added.length === 0 ? undefined : renderAdded(added);
      },
    },
  };
}

function renderAdded(added: readonly string[]): string {
  const listed = added.slice(0, MAX_LISTED_NAMES);
  const more = added.length - listed.length;
  const names = more > 0 ? [...listed, `and ${more} more`] : listed;
  return `New in your catalog: ${names.join(", ")}. Search an exact name with ${SEARCH_TOOL_NAME} for its description and signature.`;
}

/** The recorded names; a value that isn't a JSON list of names counts as none. */
function recordedNames(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  try {
    const names: unknown = JSON.parse(value);
    return Array.isArray(names)
      ? names.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
}

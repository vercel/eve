import { defineDynamic, defineInstructions, type DynamicContext } from "eve/instructions";

import { renderAlwaysOnSection, renderUnavailableNote } from "../lib/render.ts";
import { loadTurnSkills } from "../lib/runtime.ts";

/** Injects the turn's always-on custom skills into the system prompt. */
export default defineDynamic(async (ctx: DynamicContext) => {
  const scopes = await loadTurnSkills({
    session: ctx.session,
    ...(ctx.conversation !== undefined && { conversation: ctx.conversation }),
    turnId: ctx.turn?.id,
  });
  const sections = scopes.flatMap(({ scope, skills }) => {
    const section = renderAlwaysOnSection(
      skills.filter((skill) => skill.applicationMode === "always"),
      scope,
    );
    return section === null ? [] : [section];
  });
  const unavailable = scopes.filter((loaded) => loaded.unavailable === true);
  if (unavailable.length > 0)
    sections.push(renderUnavailableNote(unavailable.map(({ scope }) => scope)));
  return sections.length > 0 ? defineInstructions({ content: sections.join("\n\n") }) : null;
});

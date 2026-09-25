import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { getEffectiveModelSelection } from "#context/effective-model.js";
import {
  LiveStepDynamicModelSelectionKey,
  SessionDynamicModelReferenceKey,
  StaticModelReferenceKey,
  TurnDynamicModelReferenceKey,
} from "#context/keys.js";

const STATIC_MODEL = { id: "openai/static" } as const;

describe("getEffectiveModelSelection", () => {
  it("uses step, turn, session, then static precedence", () => {
    const ctx = new ContextContainer();
    ctx.setVirtualContext(StaticModelReferenceKey, STATIC_MODEL);

    expect(getEffectiveModelSelection(ctx)?.reference.id).toBe("openai/static");

    ctx.set(SessionDynamicModelReferenceKey, { id: "openai/session" });
    expect(getEffectiveModelSelection(ctx)?.reference.id).toBe("openai/session");

    ctx.set(TurnDynamicModelReferenceKey, { id: "openai/turn" });
    expect(getEffectiveModelSelection(ctx)?.reference.id).toBe("openai/turn");

    ctx.setVirtualContext(LiveStepDynamicModelSelectionKey, {
      reference: { id: "openai/step" },
    });
    expect(getEffectiveModelSelection(ctx)?.reference.id).toBe("openai/step");
  });

  it("returns null for a dynamic-only agent without a selection", () => {
    const ctx = new ContextContainer();
    ctx.setVirtualContext(StaticModelReferenceKey, null);

    expect(getEffectiveModelSelection(ctx)).toBeNull();
  });

  it("fails when static model state was not initialized", () => {
    expect(() => getEffectiveModelSelection(new ContextContainer())).toThrow(
      "Effective model resolution requires initialized static model state.",
    );
  });
});

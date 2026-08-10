import { describe, expect, it } from "vitest";
import { confirm, select, text, type MultiSelectQuestion } from "./ask.js";
import { setupQuestionToWire } from "./setup-question-wire.js";

describe("setupQuestionToWire", () => {
  it("projects selects to stable option ids without runtime values", () => {
    const value = { internal: true };
    const wire = setupQuestionToWire(
      select({
        key: "mode",
        message: "Mode?",
        options: [{ id: "managed", label: "Managed", value }],
        recommended: value,
        required: true,
      }),
    );
    expect(wire).toEqual({
      kind: "select",
      key: "mode",
      message: "Mode?",
      required: true,
      recommended: "managed",
      options: [{ id: "managed", label: "Managed" }],
    });
    expect(JSON.stringify(wire)).not.toContain("internal");
  });
  it("projects confirms and ordinary text without runtime behavior", () => {
    expect(
      setupQuestionToWire(
        confirm({ key: "deploy", message: "Deploy?", recommended: true, required: true }),
      ),
    ).toEqual({
      kind: "confirm",
      key: "deploy",
      message: "Deploy?",
      required: true,
      recommended: true,
    });
    expect(
      setupQuestionToWire(
        text({
          key: "name",
          message: "Name?",
          placeholder: "my-agent",
          validate: () => "not serialized",
        }),
      ),
    ).toEqual({
      kind: "text",
      key: "name",
      message: "Name?",
      required: false,
      placeholder: "my-agent",
      sensitive: false,
    });
  });

  it("projects multi-select availability and rich recommendations to ids", () => {
    const locked = { internal: "locked" };
    const optional = { internal: "optional" };
    const question: MultiSelectQuestion<object> = {
      key: "components",
      message: "Components?",
      options: [
        {
          id: "core",
          label: "Core",
          value: locked,
          locked: true,
          lockedReason: "Always included",
        },
        {
          id: "extra",
          label: "Extra",
          value: optional,
          hint: "Optional tools",
          disabled: true,
          disabledReason: "Unavailable",
        },
      ],
      recommended: [locked],
    };

    const wire = setupQuestionToWire(question);

    expect(wire).toEqual({
      kind: "multi-select",
      key: "components",
      message: "Components?",
      required: false,
      recommended: ["core"],
      options: [
        { id: "core", label: "Core", locked: true, lockedReason: "Always included" },
        {
          id: "extra",
          label: "Extra",
          hint: "Optional tools",
          disabled: true,
          disabledReason: "Unavailable",
        },
      ],
    });
    expect(JSON.stringify(wire)).not.toContain("internal");
  });

  it("rejects recommendations that are not represented by an option id", () => {
    const known = { id: "known" };
    const unknown = { id: "unknown" };

    expect(() =>
      setupQuestionToWire(
        select({
          key: "mode",
          message: "Mode?",
          options: [{ id: "known", label: "Known", value: known }],
          recommended: unknown,
        }),
      ),
    ).toThrow('Question "mode" has a recommendation that is not one of its options.');
  });

  it("exposes only the environment name for sensitive questions", () => {
    expect(
      setupQuestionToWire(
        text({
          key: "token",
          message: "Token",
          sensitive: true,
          environment: "TOKEN",
          required: true,
        }),
      ),
    ).toEqual({
      kind: "environment",
      key: "token",
      message: "Token",
      required: true,
      variable: "TOKEN",
      sensitive: true,
    });
  });
});

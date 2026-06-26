import { describe, expect, it, vi } from "vitest";

import { WizardCancelledError } from "#setup/step.js";
import { searchActionValue } from "#setup/cli/select-state.js";

import { createTuiPrompter, type TuiPrompterRenderer } from "./tui-prompter.js";

function fakeRenderer(overrides: Partial<TuiPrompterRenderer> = {}): TuiPrompterRenderer {
  return {
    readSelect: vi.fn(async () => []),
    readEditableSelect: vi.fn(async () => undefined),
    readText: vi.fn(async () => ""),
    readAcknowledge: vi.fn(async () => {}),
    readChoice: vi.fn(() => ({ choice: Promise.resolve(undefined), close: vi.fn() })),
    setStatus: vi.fn(),
    renderLine: vi.fn(),
    renderOutput: vi.fn(),
    ...overrides,
  };
}

describe("createTuiPrompter", () => {
  it("round-trips non-string option values through the panel's string keys", async () => {
    const renderer = fakeRenderer({
      readSelect: vi.fn(async () => ["option-0"]),
    });
    const prompter = createTuiPrompter(renderer);

    const picked = await prompter.select<boolean>({
      message: "Deploy this agent to Vercel?",
      options: [
        { value: true, label: "Yes" },
        { value: false, label: "No" },
      ],
    });

    expect(picked).toBe(true);
    expect(renderer.readSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: "single" }));
  });

  it("maps a searchable action back to its typed value", async () => {
    const renderer = fakeRenderer({
      readSelect: vi.fn(async () => [searchActionValue("older-agent")]),
    });
    const prompter = createTuiPrompter(renderer);

    await expect(
      prompter.select({
        message: "Project to link",
        search: true,
        hintLayout: "inline",
        searchAction: {
          label: (query) => `Search for '${query}'`,
          value: (query) => `search:${query}`,
        },
        options: [{ value: "prj_recent", label: "recent-agent" }],
      }),
    ).resolves.toBe("search:older-agent");
    expect(renderer.readSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "search",
        layout: "task-list",
        searchAction: { label: expect.any(Function) },
      }),
    );
  });

  it("encodes replacement rows for an in-place search action", async () => {
    let searchRequest:
      | Extract<Parameters<TuiPrompterRenderer["readSelect"]>[0], { kind: "search" }>
      | undefined;
    const renderer = fakeRenderer({
      readSelect: vi.fn(async (request) => {
        if (request.kind !== "search") throw new Error("Expected a searchable request.");
        searchRequest = request;
        await expect(request.searchAction?.load?.("older-agent")).resolves.toEqual([
          { value: "option-1", label: "older-agent" },
        ]);
        return ["option-1"];
      }),
    });
    const prompter = createTuiPrompter(renderer);

    await expect(
      prompter.select({
        message: "Project to link",
        search: true,
        searchAction: {
          label: (query) => `Search for '${query}'`,
          value: (query) => `search:${query}`,
          load: async () => [{ value: "prj_older", label: "older-agent" }],
        },
        options: [{ value: "prj_recent", label: "recent-agent" }],
      }),
    ).resolves.toBe("prj_older");
    expect(searchRequest?.searchAction?.label("older-agent")).toBe("Search for 'older-agent'");
  });

  it("returns the marked set from a multi-select", async () => {
    const renderer = fakeRenderer({
      readSelect: vi.fn(async () => ["option-0", "option-1"]),
    });
    const prompter = createTuiPrompter(renderer);

    const picked = await prompter.select<string>({
      message: "Select channels",
      multiple: true,
      options: [
        { value: "web", label: "Web Chat" },
        { value: "slack", label: "Slack" },
      ],
    });

    expect(picked).toEqual(["web", "slack"]);
    expect(renderer.readSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "multi", required: false }),
    );
  });

  it("round-trips an inline-edited select value", async () => {
    const renderer = fakeRenderer({
      readEditableSelect: vi.fn(async () => ({
        kind: "edited" as const,
        value: "option-0",
        text: "custom-name",
      })),
    });
    const prompter = createTuiPrompter(renderer);

    await expect(
      prompter.selectEditable?.({
        message: "Vercel project",
        options: [
          { value: "new", label: "Create a new project" },
          { value: "link", label: "Link an existing project" },
        ],
        editable: {
          value: "new",
          defaultValue: "weather-agent",
          formatHint: (value) => `Name: ${value}`,
        },
      }),
    ).resolves.toEqual({ kind: "edited", value: "new", text: "custom-name" });
  });

  it("throws WizardCancelledError when a panel is cancelled", async () => {
    const renderer = fakeRenderer({
      readSelect: vi.fn(async () => undefined),
      readText: vi.fn(async () => undefined),
    });
    const prompter = createTuiPrompter(renderer);

    await expect(
      prompter.select({ message: "Pick", options: [{ value: "a", label: "A" }] }),
    ).rejects.toBeInstanceOf(WizardCancelledError);
    await expect(prompter.text({ message: "Name" })).rejects.toBeInstanceOf(WizardCancelledError);
  });

  it("masks passwords through the text panel", async () => {
    const renderer = fakeRenderer({
      readText: vi.fn(async () => "secret"),
    });
    const prompter = createTuiPrompter(renderer);

    await expect(prompter.password({ message: "API key" })).resolves.toBe("secret");
    expect(renderer.readText).toHaveBeenCalledWith(expect.objectContaining({ mask: true }));
  });

  it("maps the log surface onto flow lines and the ephemeral status", () => {
    const renderer = fakeRenderer();
    const prompter = createTuiPrompter(renderer);

    prompter.log.message("checking");
    prompter.log.success("done");
    prompter.log.warning("careful");
    prompter.note("collision", "Heads up");

    expect(renderer.renderLine).toHaveBeenCalledWith("checking", "info");
    expect(renderer.renderLine).toHaveBeenCalledWith("done", "success");
    expect(renderer.renderLine).toHaveBeenCalledWith("careful", "warning");
    expect(renderer.renderLine).toHaveBeenCalledWith("Heads up", "warning");

    const spinner = prompter.log.spinner?.("Checking the project…");
    expect(renderer.setStatus).toHaveBeenCalledWith("Checking the project…");
    spinner?.stop();
    spinner?.stop();
    expect(renderer.setStatus).toHaveBeenCalledTimes(2);
    expect(renderer.setStatus).toHaveBeenLastCalledWith(undefined);
  });

  it("keeps concurrent choices on the interaction surface, not the log", () => {
    const handle = { choice: Promise.resolve("retry"), close: vi.fn() };
    const renderer = fakeRenderer({ readChoice: vi.fn(() => handle) });
    const prompter = createTuiPrompter(renderer);
    const options = {
      status: "Creating a Slackbot...",
      context: "Waiting for browser setup",
      actions: [{ value: "retry", label: "Try again" }],
    };

    expect(prompter.awaitChoice?.(options)).toBe(handle);
    expect(renderer.readChoice).toHaveBeenCalledWith(options);
    expect("awaitChoice" in prompter.log).toBe(false);
  });

  it("keeps values distinct when their string representations collide", async () => {
    const renderer = fakeRenderer({
      readSelect: vi.fn(async () => ["option-1"]),
    });
    const prompter = createTuiPrompter(renderer);

    await expect(
      prompter.select<string | number>({
        message: "Pick a value",
        options: [
          { value: 1, label: "Number" },
          { value: "1", label: "String" },
        ],
      }),
    ).resolves.toBe("1");
  });
});

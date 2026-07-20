import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { DEFAULT_AGENT_MODEL_ID } from "#shared/default-agent-model.js";

import { headlessAsker, InteractionRequired, interactiveAsker, type Asker } from "../ask.js";
import type { Prompter, PrompterValue, SingleSelectOptions } from "../prompter.js";
import { createDefaultSetupState } from "../state.js";
import type { OutputSink } from "../step.js";
import { runHeadless, runInteractive } from "../runner.js";
import {
  modelOptionsFromCatalog,
  parseGatewayCatalog,
  selectModel,
  type GatewayCatalogModel,
  type SelectModelDeps,
} from "./select-model.js";

const silentSink: OutputSink = { write: () => {} };

const CATALOG: GatewayCatalogModel[] = [
  {
    id: "zai/glm-4.6",
    name: "GLM 4.6",
    type: "language",
    owned_by: "zai",
    released: 300,
    tags: ["web-search"],
  },
  {
    id: "openai/gpt-5-mini",
    name: "GPT-5 mini",
    type: "language",
    owned_by: "openai",
    released: 200,
    tags: ["web-search"],
  },
  {
    id: "anthropic/claude-sonnet-5",
    name: "Claude Sonnet 5",
    type: "language",
    owned_by: "anthropic",
    released: 100,
    tags: ["web-search"],
  },
  // Filtered out: not a language model.
  { id: "openai/dall-e-3", name: "DALL-E 3", type: "image", owned_by: "openai" },
  // Filtered out: missing the web-search tag.
  { id: "google/gemma-2", name: "Gemma 2", type: "language", owned_by: "google", tags: [] },
];

function catalogDeps(models: GatewayCatalogModel[] = CATALOG): SelectModelDeps {
  return { fetchModels: vi.fn(async () => models) };
}

function unexpectedFetch(): SelectModelDeps {
  return {
    fetchModels: vi.fn(async (): Promise<GatewayCatalogModel[]> => {
      throw new Error("Unexpected catalog fetch in a select-model test.");
    }),
  };
}

/** Proves a path never reaches the channel at all. */
function untouchableAsker(): Asker {
  return {
    ask(question): Promise<never> {
      throw new Error(`untouchableAsker was asked "${question.key}"`);
    },
    askMany(question): Promise<never> {
      throw new Error(`untouchableAsker was asked "${question.key}"`);
    },
  };
}

type SingleHandler = (opts: SingleSelectOptions<PrompterValue>) => PrompterValue;

function createSelectPrompter(handler: SingleHandler): {
  prompter: Prompter;
  single: SingleHandler;
} {
  const single = vi.fn(handler);
  return { prompter: createFakePrompter({ single }).prompter, single };
}

describe("modelOptionsFromCatalog", () => {
  it("filters, sorts newest-first behind the featured lead, and marks the shortlist", () => {
    const options = modelOptionsFromCatalog(CATALOG);

    expect(options.map((option) => option.value)).toEqual([
      "anthropic/claude-sonnet-5",
      "zai/glm-4.6",
      "openai/gpt-5-mini",
    ]);
    expect(options.filter((option) => option.featured).map((o) => o.value)).toEqual([
      "anthropic/claude-sonnet-5",
    ]);
  });

  it("falls back to the static shortlist without a catalog or matches", () => {
    for (const catalog of [undefined, [] as GatewayCatalogModel[]]) {
      const values = modelOptionsFromCatalog(catalog).map((option) => option.value);
      expect(values).toContain(DEFAULT_AGENT_MODEL_ID);
      expect(values).toContain("google/gemini-3.5");
    }
  });
});

describe("selectModel box", () => {
  it("short-circuits both runners on a preset model", async () => {
    const deps = unexpectedFetch();
    const box = selectModel({ asker: untouchableAsker(), presetModel: "openai/gpt-5-mini", deps });

    const interactive = await runInteractive([box], createDefaultSetupState(), silentSink);
    expect(interactive.kind).toBe("done");
    if (interactive.kind !== "done") return;
    expect(interactive.state.modelId).toBe("openai/gpt-5-mini");

    const headless = await runHeadless([box], createDefaultSetupState(), silentSink);
    expect(headless.modelId).toBe("openai/gpt-5-mini");

    expect(deps.fetchModels).not.toHaveBeenCalled();
  });

  it("offers a searchable picker over the filtered, release-sorted catalog", async () => {
    let captured: SingleSelectOptions<PrompterValue> | undefined;
    const { prompter } = createSelectPrompter((opts) => {
      captured = opts;
      return "anthropic/claude-sonnet-5";
    });
    const box = selectModel({ asker: interactiveAsker(prompter), deps: catalogDeps() });

    const result = await runInteractive([box], createDefaultSetupState(), silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.modelId).toBe("anthropic/claude-sonnet-5");
    expect(captured?.search).toBe(true);
    // The featured default remains first; the rest are newest release first.
    expect(captured?.options.map((option) => option.value)).toEqual([
      "anthropic/claude-sonnet-5",
      "zai/glm-4.6",
      "openai/gpt-5-mini",
    ]);
    // Cursor defaults to the top catalog entry when no default is configured.
    expect(captured?.initialValue).toBe("anthropic/claude-sonnet-5");
  });

  it("orders the curated shortlist first, marks it featured, and pre-selects the default", async () => {
    let captured: SingleSelectOptions<PrompterValue> | undefined;
    const { prompter } = createSelectPrompter((opts) => {
      captured = opts;
      return DEFAULT_AGENT_MODEL_ID;
    });
    // "Claude Opus 4.8" sorts above "Claude Sonnet 5" alphabetically, but the
    // curated order (Sonnet first) wins over the alphabetical tiebreak.
    const catalog: GatewayCatalogModel[] = [
      {
        id: "anthropic/claude-opus-4.8",
        name: "Claude Opus 4.8",
        type: "language",
        owned_by: "anthropic",
        released: 400,
        tags: ["web-search"],
      },
      ...CATALOG,
    ];
    const box = selectModel({ asker: interactiveAsker(prompter), deps: catalogDeps(catalog) });

    const result = await runInteractive([box], createDefaultSetupState(), silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(captured?.options.map((option) => option.value)).toEqual([
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-4.8",
      "zai/glm-4.6",
      "openai/gpt-5-mini",
    ]);
    // Only the curated entries are featured: the picker's default view shows
    // them alone, and scrolling or search surfaces the rest of the catalog.
    expect(captured?.options.filter((option) => option.featured).map((o) => o.value)).toEqual([
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-4.8",
    ]);
    expect(captured?.initialValue).toBe(DEFAULT_AGENT_MODEL_ID);
  });

  it("sorts undated models after dated models with deterministic ties", async () => {
    let captured: SingleSelectOptions<PrompterValue> | undefined;
    const { prompter } = createSelectPrompter((opts) => {
      captured = opts;
      return "acme/newer";
    });
    const models: GatewayCatalogModel[] = [
      {
        id: "acme/undated",
        name: "Undated",
        type: "language",
        owned_by: "acme",
        tags: ["web-search"],
      },
      {
        id: "acme/zeta",
        name: "Same release Zeta",
        type: "language",
        owned_by: "acme",
        released: 100,
        tags: ["web-search"],
      },
      {
        id: "acme/alpha",
        name: "Same release Alpha",
        type: "language",
        owned_by: "acme",
        released: 100,
        tags: ["web-search"],
      },
      {
        id: "acme/newer",
        name: "Newer",
        type: "language",
        owned_by: "acme",
        released: 200,
        tags: ["web-search"],
      },
    ];

    await runInteractive(
      [selectModel({ asker: interactiveAsker(prompter), deps: catalogDeps(models) })],
      createDefaultSetupState(),
      silentSink,
    );

    expect(captured?.options.map((option) => option.value)).toEqual([
      "acme/newer",
      "acme/alpha",
      "acme/zeta",
      "acme/undated",
    ]);
  });

  it("pre-selects the configured default model when present in the catalog", async () => {
    let captured: SingleSelectOptions<PrompterValue> | undefined;
    const { prompter } = createSelectPrompter((opts) => {
      captured = opts;
      return "openai/gpt-5-mini";
    });
    const box = selectModel({
      asker: interactiveAsker(prompter),
      defaultModel: "openai/gpt-5-mini",
      deps: catalogDeps(),
    });

    await runInteractive([box], createDefaultSetupState(), silentSink);

    expect(captured?.initialValue).toBe("openai/gpt-5-mini");
  });

  it("skips malformed catalog entries instead of rejecting the whole catalog", () => {
    const models = parseGatewayCatalog({
      data: [
        CATALOG[0],
        { id: "vendor/experimental", shape: "unrecognized" },
        "not even an object",
        CATALOG[1],
      ],
    });

    expect(models.map((model) => model.id)).toEqual(["zai/glm-4.6", "openai/gpt-5-mini"]);
  });

  it("keeps a model when only its optional catalog metadata is malformed", () => {
    expect(
      parseGatewayCatalog({
        data: [
          {
            id: "vendor/experimental",
            name: "Experimental",
            type: "language",
            owned_by: "vendor",
            released: "unannounced",
            tags: null,
          },
        ],
      }),
    ).toEqual([
      {
        id: "vendor/experimental",
        name: "Experimental",
        type: "language",
        owned_by: "vendor",
      },
    ]);
  });

  it("rejects a catalog payload without a data array", () => {
    expect(() => parseGatewayCatalog({ models: [] })).toThrow("invalid model catalog");
  });

  it("falls back to the static shortlist when the catalog fetch fails", async () => {
    let captured: SingleSelectOptions<PrompterValue> | undefined;
    const { prompter } = createSelectPrompter((opts) => {
      captured = opts;
      return DEFAULT_AGENT_MODEL_ID;
    });
    const deps: SelectModelDeps = {
      fetchModels: vi.fn(async (): Promise<GatewayCatalogModel[]> => {
        throw new Error("network down");
      }),
    };
    const box = selectModel({ asker: interactiveAsker(prompter), deps });

    const result = await runInteractive([box], createDefaultSetupState(), silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.modelId).toBe(DEFAULT_AGENT_MODEL_ID);
    expect(captured?.options.map((option) => option.value)).toContain(DEFAULT_AGENT_MODEL_ID);
    expect(captured?.options.map((option) => option.value)).toContain("google/gemini-3.5");
  });

  it("falls back to the static shortlist when the filtered catalog is empty", async () => {
    let captured: SingleSelectOptions<PrompterValue> | undefined;
    const { prompter } = createSelectPrompter((opts) => {
      captured = opts;
      return DEFAULT_AGENT_MODEL_ID;
    });
    const box = selectModel({
      asker: interactiveAsker(prompter),
      deps: catalogDeps([
        { id: "openai/dall-e-3", name: "DALL-E 3", type: "image", owned_by: "openai" },
      ]),
    });

    await runInteractive([box], createDefaultSetupState(), silentSink);

    expect(captured?.options.map((option) => option.value)).toContain(DEFAULT_AGENT_MODEL_ID);
  });

  it("headless without a preset refuses with InteractionRequired naming the question", async () => {
    // The unified gather builds the option list before asking, so the catalog
    // fetch now precedes the structural refusal (the dual-face box failed
    // before fetching).
    const deps = catalogDeps();
    const box = selectModel({ asker: headlessAsker(), deps });

    const run = runHeadless([box], createDefaultSetupState(), silentSink);
    await expect(run).rejects.toThrow(InteractionRequired);
    await expect(runHeadless([box], createDefaultSetupState(), silentSink)).rejects.toMatchObject({
      message: expect.stringMatching(/Which model should your agent use\?/),
      question: expect.objectContaining({ key: "model", required: true }),
    });
  });
});

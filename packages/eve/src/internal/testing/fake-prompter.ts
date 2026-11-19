import { vi } from "vitest";

import type {
  MultiSelectOptions,
  Prompter,
  PrompterValue,
  SingleSelectOptions,
} from "#setup/prompter.js";

interface FakePrompterConfig {
  text?: (opts: Parameters<Prompter["text"]>[0]) => string;
  password?: (opts: { message: string }) => string;
  single?: (opts: SingleSelectOptions<PrompterValue>) => PrompterValue | Promise<PrompterValue>;
  multiple?: (
    opts: MultiSelectOptions<PrompterValue>,
  ) => PrompterValue[] | Promise<PrompterValue[]>;
}

interface FakePrompter {
  prompter: Prompter;
  selectMessages: string[];
}

export function createFakePrompter(config: FakePrompterConfig = {}): FakePrompter {
  const selectMessages: string[] = [];
  const fail = (message: string): never => {
    throw new Error(`Unexpected prompt in test: "${message}"`);
  };

  function select<T extends PrompterValue>(opts: SingleSelectOptions<T>): Promise<T>;
  function select<T extends PrompterValue>(opts: MultiSelectOptions<T>): Promise<T[]>;
  async function select<T extends PrompterValue>(
    opts: SingleSelectOptions<T> | MultiSelectOptions<T>,
  ): Promise<T | T[]> {
    selectMessages.push(opts.message);
    if (opts.multiple === true) {
      return (config.multiple ? await config.multiple(opts) : fail(opts.message)) as T[];
    }
    return (config.single ? await config.single(opts) : fail(opts.message)) as T;
  }

  const prompter: Prompter = {
    text: async (opts) => (config.text ? config.text(opts) : fail(opts.message)),
    password: async (opts) => (config.password ? config.password(opts) : fail(opts.message)),
    select,
    acknowledge: vi.fn(async () => {}),
    note: vi.fn(),
    intro: vi.fn(),
    outro: vi.fn(),
    log: {
      message: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      commandOutput: vi.fn(),
    },
  };

  return { prompter, selectMessages };
}

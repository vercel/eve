import {
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  type ToolChoice,
  type ToolSet,
} from "ai";
import { Factuality } from "autoevals";

/**
 * The OpenAI-shaped client surface autoevals expects. Extracted from the
 * library so we don't take a direct dependency on `openai` types.
 */
type AutoevalsClient = NonNullable<Parameters<typeof Factuality>[0]["client"]>;

type ProviderOptions = Parameters<typeof generateText>[0]["providerOptions"];

interface AutoevalsClientConfig {
  readonly languageModel: LanguageModel;
  readonly providerOptions?: ProviderOptions;
}

interface ChatParams {
  readonly messages?: readonly ChatMessage[];
  readonly tools?: readonly ChatTool[];
  readonly tool_choice?: ChatToolChoice;
}

interface ChatMessage {
  readonly role?: "assistant" | "developer" | "system" | "user";
  readonly content?: string | readonly ChatMessageContentPart[] | null;
}

interface ChatMessageContentPart {
  readonly text?: string;
}

interface ChatTool {
  readonly type?: string;
  readonly function?: {
    readonly name?: string;
    readonly description?: string;
    readonly parameters?: Record<string, unknown>;
  };
}

type ChatToolChoice =
  | "auto"
  | "none"
  | "required"
  | { readonly type: "function"; readonly function: { readonly name: string } };

export function createAutoevalsClient(config: AutoevalsClientConfig): AutoevalsClient {
  const adapter: unknown = {
    chat: {
      completions: {
        create: (params: ChatParams) => createChatCompletion(params, config),
      },
    },
  };
  return adapter as AutoevalsClient;
}

async function createChatCompletion(
  params: ChatParams,
  config: AutoevalsClientConfig,
): Promise<{ readonly choices: readonly unknown[] }> {
  const tools = convertTools(params.tools);
  const result = await generateText({
    model: config.languageModel,
    messages: convertMessages(params.messages ?? []),
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    toolChoice: convertToolChoice(params.tool_choice),
    providerOptions: config.providerOptions,
  });

  const toolCalls = result.toolCalls.map((call) => ({
    id: call.toolCallId,
    type: "function",
    function: {
      name: call.toolName,
      arguments: JSON.stringify(call.input ?? {}),
    },
  }));

  return {
    choices: [
      {
        index: 0,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content: result.text || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
      },
    ],
  };
}

function convertMessages(messages: readonly ChatMessage[]): ModelMessage[] {
  return messages.map((message) => {
    const content = contentToText(message.content);
    switch (message.role) {
      case "assistant":
        return { role: "assistant", content };
      case "developer":
      case "system":
        return { role: "system", content };
      case "user":
      default:
        return { role: "user", content };
    }
  });
}

function contentToText(content: ChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function convertTools(tools: readonly ChatTool[] | undefined): ToolSet {
  const result: ToolSet = {};
  for (const item of tools ?? []) {
    if (item.type !== "function" || item.function?.name === undefined) continue;
    result[item.function.name] = {
      description: item.function.description,
      inputSchema: jsonSchema(item.function.parameters ?? {}),
    };
  }
  return result;
}

function convertToolChoice(choice: ChatToolChoice | undefined): ToolChoice<ToolSet> | undefined {
  if (choice === undefined) return undefined;
  if (typeof choice === "string") return choice;
  return { type: "tool", toolName: choice.function.name };
}

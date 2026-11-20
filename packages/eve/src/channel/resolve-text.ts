import type {
  InteractionOption,
  InteractionRequest,
} from "#protocol/session-events/families/interaction.js";
import type { Answer } from "#shared/input.js";

interface TextResolvable {
  readonly interactionId: string;
  readonly request: Pick<InteractionRequest, "allowFreeform" | "options">;
}

export function renderTextInteraction(
  request: Pick<InteractionRequest, "options" | "prompt">,
): string {
  const lines = [request.prompt];
  if (request.options !== undefined && request.options.length > 0) {
    lines.push(
      "",
      ...request.options.map((option, index) => {
        const description = option.description ? ` - ${option.description}` : "";
        return `${index + 1}. ${option.label}${description}`;
      }),
    );
  }
  return lines.join("\n");
}

export function answerFromText(text: string, interaction: TextResolvable): Answer | undefined {
  const { interactionId, request } = interaction;
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();

  if (request.options !== undefined && request.options.length > 0) {
    const matched = matchOption(normalized, request.options);
    if (matched !== undefined) {
      return { interactionId, optionId: matched.id };
    }
  }

  const acceptsFreeform =
    request.allowFreeform === true || request.options === undefined || request.options.length === 0;

  if (acceptsFreeform) {
    return { interactionId, text: trimmed };
  }

  return undefined;
}

function matchOption(
  normalized: string,
  options: readonly InteractionOption[],
): InteractionOption | undefined {
  const byId = options.find((o) => o.id.toLowerCase() === normalized);
  if (byId !== undefined) {
    return byId;
  }

  const byLabel = options.find((o) => o.label.toLowerCase() === normalized);
  if (byLabel !== undefined) {
    return byLabel;
  }

  const numericIndex = Number(normalized);
  if (Number.isInteger(numericIndex) && numericIndex > 0 && numericIndex <= options.length) {
    return options[numericIndex - 1];
  }

  return undefined;
}

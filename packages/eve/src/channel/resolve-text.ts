import type {
  InteractionOption,
  InteractionRequest,
} from "#protocol/session-events/families/interaction.js";
import type { Answer } from "#shared/input.js";

/** An interaction plain text answers: an interaction row, or an approval the session asked. */
interface TextResolvable {
  readonly interactionId: string;
  readonly request: Pick<InteractionRequest, "allowFreeform" | "options">;
}

/**
 * Renders a request's prompt and numbered options as the plain text that
 * {@link answerFromText} parses, so a reply with the number, label, or
 * id answers it. Channels append their own reply instructions.
 */
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

/**
 * Maps freeform text to an {@link Answer} to one interaction.
 *
 * Resolution order:
 * 1. Exact option ID (case-insensitive)
 * 2. Exact option label (case-insensitive)
 * 3. 1-based numeric index into the options array
 * 4. Freeform text when the request allows freeform answers or the
 *    request has no options
 */
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

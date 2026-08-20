import type { InputOption, InputRequest, InputResponse } from "#runtime/input/types.js";

/**
 * Maps freeform text to an {@link InputResponse} for a single request.
 *
 * Emitters import this utility to resolve text-based user input against
 * pending request options. The harness and runtime do not call it.
 *
 * Resolution order:
 * 1. Exact option ID (case-insensitive)
 * 2. Exact option label (case-insensitive)
 * 3. 1-based numeric index into the options array
 * 4. Freeform text if {@link InputRequest.allowFreeform} is not `false`
 */
export function resolveTextToResponse(
  text: string,
  request: InputRequest,
): InputResponse | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();

  if (request.options !== undefined && request.options.length > 0) {
    const matched = matchOption(normalized, request.options);
    if (matched !== undefined) {
      return { requestId: request.requestId, optionId: matched.id };
    }
  }

  const acceptsFreeform =
    request.allowFreeform === true || request.options === undefined || request.options.length === 0;

  if (acceptsFreeform && trimmed.length > 0) {
    return { requestId: request.requestId, text: trimmed };
  }

  return undefined;
}

/**
 * Resolves text against all pending requests, returning one
 * {@link InputResponse} for each request that could be matched.
 */
export function resolveTextToResponses(
  text: string,
  requests: readonly InputRequest[],
): readonly InputResponse[] {
  const responses: InputResponse[] = [];

  for (const request of requests) {
    const response = resolveTextToResponse(text, request);
    if (response !== undefined) {
      responses.push(response);
    }
  }

  return responses;
}

function matchOption(normalized: string, options: readonly InputOption[]): InputOption | undefined {
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

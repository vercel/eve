/**
 * Inbound Discord interaction parsing and prompt shaping.
 *
 * The channel owns small, documented data shapes instead of exposing
 * Discord's raw interaction payloads as the primary public API.
 */

import { isNonEmptyString, isObject } from "#shared/guards.js";

/** Maps the Discord interaction kinds the channel handles to their wire `type` integers. */
export const DISCORD_INTERACTION_TYPE = {
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  MODAL_SUBMIT: 5,
  PING: 1,
} as const;

/** Maps Discord interaction callback kinds to the wire `type` integers used in interaction responses. */
export const DISCORD_INTERACTION_RESPONSE_TYPE = {
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  MODAL: 9,
  PONG: 1,
} as const;

/** Discord message `flags` bit (1 << 6 = 64) marking a response ephemeral (visible only to the invoking user). */
export const DISCORD_EPHEMERAL_MESSAGE_FLAG = 1 << 6;

/** Discord user metadata surfaced by inbound interactions. */
export interface DiscordUser {
  readonly avatar?: string;
  readonly discriminator?: string;
  readonly globalName?: string;
  readonly id: string;
  readonly isBot: boolean;
  readonly username: string;
}

/** Discord guild member metadata surfaced by inbound interactions. */
export interface DiscordMember {
  readonly nick?: string;
  readonly roles: readonly string[];
  readonly user: DiscordUser;
}

/** Common fields shared by parsed Discord interactions. */
export interface DiscordInteractionBase {
  readonly applicationId: string;
  readonly channelId: string;
  readonly guildId?: string;
  readonly id: string;
  readonly member?: DiscordMember;
  readonly token: string;
  readonly user: DiscordUser;
  readonly raw: Record<string, unknown>;
}

/**
 * One slash-command option from Discord's interaction payload. `value` holds the
 * primitive argument for leaf options and is undefined for subcommands and
 * subcommand groups, which carry their child options in `options`.
 */
export interface DiscordCommandOption {
  readonly name: string;
  readonly value?: string | number | boolean;
  readonly options: readonly DiscordCommandOption[];
}

/** Parsed Discord slash/application command interaction. */
export interface DiscordCommandInteraction extends DiscordInteractionBase {
  readonly commandId?: string;
  readonly commandName: string;
  readonly options: readonly DiscordCommandOption[];
  readonly type: typeof DISCORD_INTERACTION_TYPE.APPLICATION_COMMAND;
}

/**
 * Parsed Discord message-component interaction. `componentType` is Discord's
 * raw component-type integer (0 when absent). `values` holds the selected option
 * ids for string-select components and is empty for buttons.
 */
export interface DiscordComponentInteraction extends DiscordInteractionBase {
  readonly componentType: number;
  readonly customId: string;
  readonly messageId: string;
  readonly type: typeof DISCORD_INTERACTION_TYPE.MESSAGE_COMPONENT;
  readonly values: readonly string[];
}

/** Parsed Discord modal-submit interaction. */
export interface DiscordModalSubmitInteraction extends DiscordInteractionBase {
  readonly customId: string;
  readonly messageId?: string;
  readonly textInputs: Readonly<Record<string, string>>;
  readonly type: typeof DISCORD_INTERACTION_TYPE.MODAL_SUBMIT;
}

/** Parsed Discord interaction variants handled by the native channel. */
export type DiscordInteraction =
  | DiscordCommandInteraction
  | DiscordComponentInteraction
  | DiscordModalSubmitInteraction;

const DISCORD_RESPONSE_INSTRUCTIONS =
  "Reply for Discord in concise Markdown. Avoid mass mentions, long tables, " +
  "and messages that need more than a few short posts.";

/**
 * Fields rendered into the model-visible `<discord_context>` block by
 * {@link formatDiscordContextBlock}. The optional fields (username, guildId,
 * commandName) are omitted from the block when not provided.
 */
export interface DiscordInboundContext {
  readonly channelId: string;
  readonly commandName?: string;
  readonly guildId?: string;
  readonly interactionId: string;
  readonly userId: string;
  readonly username?: string;
}

/** Parses one JSON-decoded Discord interaction payload. */
export function parseDiscordInteraction(value: unknown): DiscordInteraction | null {
  if (!isObject(value)) return null;
  const type = value.type;
  if (type === DISCORD_INTERACTION_TYPE.APPLICATION_COMMAND) {
    return parseCommandInteraction(value);
  }
  if (type === DISCORD_INTERACTION_TYPE.MESSAGE_COMPONENT) {
    return parseComponentInteraction(value);
  }
  if (type === DISCORD_INTERACTION_TYPE.MODAL_SUBMIT) {
    return parseModalSubmitInteraction(value);
  }
  return null;
}

/** Returns the model-facing prompt for a command: the value of a `message` option when present and non-blank, otherwise a reconstructed `/command opt:value ...` string. */
export function commandInteractionMessage(interaction: DiscordCommandInteraction): string {
  const message = findOptionValue(interaction.options, "message");
  if (typeof message === "string" && message.trim().length > 0) return message;

  const optionText = formatCommandOptions(interaction.options);
  return optionText ? `/${interaction.commandName} ${optionText}` : `/${interaction.commandName}`;
}

/** Renders one {@link DiscordInboundContext} as a deterministic context block. */
export function formatDiscordContextBlock(context: DiscordInboundContext): string {
  const lines = [
    "<discord_context>",
    "response_medium: discord",
    `response_instructions: ${DISCORD_RESPONSE_INSTRUCTIONS}`,
    `user_id: ${context.userId}`,
    ...(context.username ? [`username: ${context.username}`] : []),
    `channel_id: ${context.channelId}`,
    ...(context.guildId ? [`guild_id: ${context.guildId}`] : []),
    `interaction_id: ${context.interactionId}`,
    ...(context.commandName ? [`command_name: ${context.commandName}`] : []),
    "</discord_context>",
  ];
  return lines.join("\n");
}

function parseCommandInteraction(raw: Record<string, unknown>): DiscordCommandInteraction | null {
  const base = parseInteractionBase(raw);
  const data = isObject(raw.data) ? raw.data : null;
  if (!base || !data || !isNonEmptyString(data.name)) return null;
  return {
    ...base,
    commandId: isNonEmptyString(data.id) ? data.id : undefined,
    commandName: data.name,
    options: parseOptions(data.options),
    type: DISCORD_INTERACTION_TYPE.APPLICATION_COMMAND,
  };
}

function parseComponentInteraction(
  raw: Record<string, unknown>,
): DiscordComponentInteraction | null {
  const base = parseInteractionBase(raw);
  const data = isObject(raw.data) ? raw.data : null;
  const message = isObject(raw.message) ? raw.message : null;
  if (!base || !data || !isNonEmptyString(data.custom_id)) return null;
  const messageId = isNonEmptyString(message?.id) ? message.id : "";
  if (!messageId) return null;
  return {
    ...base,
    componentType: typeof data.component_type === "number" ? data.component_type : 0,
    customId: data.custom_id,
    messageId,
    type: DISCORD_INTERACTION_TYPE.MESSAGE_COMPONENT,
    values: Array.isArray(data.values)
      ? data.values.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

function parseModalSubmitInteraction(
  raw: Record<string, unknown>,
): DiscordModalSubmitInteraction | null {
  const base = parseInteractionBase(raw);
  const data = isObject(raw.data) ? raw.data : null;
  if (!base || !data || !isNonEmptyString(data.custom_id)) return null;
  const message = isObject(raw.message) ? raw.message : null;
  return {
    ...base,
    customId: data.custom_id,
    messageId: isNonEmptyString(message?.id) ? message.id : undefined,
    textInputs: parseTextInputs(data.components),
    type: DISCORD_INTERACTION_TYPE.MODAL_SUBMIT,
  };
}

function parseInteractionBase(raw: Record<string, unknown>): DiscordInteractionBase | null {
  if (
    !isNonEmptyString(raw.id) ||
    !isNonEmptyString(raw.application_id) ||
    !isNonEmptyString(raw.channel_id) ||
    !isNonEmptyString(raw.token)
  ) {
    return null;
  }
  const user = parseInteractionUser(raw);
  if (!user) return null;
  return {
    applicationId: raw.application_id,
    channelId: raw.channel_id,
    guildId: isNonEmptyString(raw.guild_id) ? raw.guild_id : undefined,
    id: raw.id,
    member: parseMember(raw.member),
    raw,
    token: raw.token,
    user,
  };
}

function parseInteractionUser(raw: Record<string, unknown>): DiscordUser | null {
  const directUser = parseUser(raw.user);
  if (directUser) return directUser;
  const member = parseMember(raw.member);
  return member?.user ?? null;
}

function parseMember(value: unknown): DiscordMember | undefined {
  if (!isObject(value)) return undefined;
  const user = parseUser(value.user);
  if (!user) return undefined;
  return {
    nick: isNonEmptyString(value.nick) ? value.nick : undefined,
    roles: Array.isArray(value.roles)
      ? value.roles.filter((entry): entry is string => typeof entry === "string")
      : [],
    user,
  };
}

function parseUser(value: unknown): DiscordUser | null {
  if (!isObject(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.username)) {
    return null;
  }
  return {
    avatar: isNonEmptyString(value.avatar) ? value.avatar : undefined,
    discriminator: isNonEmptyString(value.discriminator) ? value.discriminator : undefined,
    globalName: isNonEmptyString(value.global_name) ? value.global_name : undefined,
    id: value.id,
    isBot: value.bot === true,
    username: value.username,
  };
}

function parseOptions(value: unknown): DiscordCommandOption[] {
  if (!Array.isArray(value)) return [];
  const options: DiscordCommandOption[] = [];
  for (const item of value) {
    if (!isObject(item) || !isNonEmptyString(item.name)) continue;
    const option: DiscordCommandOption = {
      name: item.name,
      options: parseOptions(item.options),
      value: parseOptionValue(item.value),
    };
    options.push(option);
  }
  return options;
}

function parseOptionValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function parseTextInputs(value: unknown): Record<string, string> {
  const inputs: Record<string, string> = {};
  if (!Array.isArray(value)) return inputs;
  for (const row of value) {
    if (!isObject(row) || !Array.isArray(row.components)) continue;
    for (const component of row.components) {
      if (!isObject(component)) continue;
      if (isNonEmptyString(component.custom_id) && typeof component.value === "string") {
        inputs[component.custom_id] = component.value;
      }
    }
  }
  return inputs;
}

function findOptionValue(
  options: readonly DiscordCommandOption[],
  name: string,
): string | number | boolean | undefined {
  for (const option of options) {
    if (option.name === name && option.value !== undefined) return option.value;
    const nested = findOptionValue(option.options, name);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function formatCommandOptions(options: readonly DiscordCommandOption[]): string {
  return options
    .map(formatOption)
    .filter((entry) => entry.length > 0)
    .join(" ");
}

function formatOption(option: DiscordCommandOption): string {
  if (option.value !== undefined) return `${option.name}:${String(option.value)}`;
  const nested = formatCommandOptions(option.options);
  return nested ? `${option.name} ${nested}` : option.name;
}

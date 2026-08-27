/**
 * Serialized-context slot names shared with modules that must inspect a
 * serialized context map without instantiating the owning key.
 *
 * `ChannelKey` (`#runtime/sessions/runtime-context-keys.ts`) carries a
 * codec that calls into the runtime, so workflow bodies cannot import
 * it; they read its slot through this name constant instead. The owning
 * keys construct themselves from these constants, so the names cannot
 * silently drift apart.
 */

export const CHANNEL_CONTEXT_KEY_NAME = "eve.channel";
export const SESSION_CALLBACK_CONTEXT_KEY_NAME = "eve.sessionCallback";

import { defineMcpClientConnection } from "eve/connections";

/**
 * The Typefully tools the coordinator can discover and call.
 *
 * @remarks
 * Names are the server's own, as its tool list publishes them, with no prefix. A tool the server
 * adds later stays invisible until it is added here.
 */
const ALLOWED_TOOLS = [
  "get_me",
  "list_social_sets",
  "get_social_set_details",
  "linkedin_resolve_linkedin_organization_from_url",
  "list_drafts",
  "get_draft",
  "create_draft",
  "edit_draft",
  "delete_draft",
  "get_queue",
  "get_queue_schedule",
  "queue_put_queue_schedule",
  "create_media_upload",
  "get_media_status",
  "update_media",
  "list_tags",
  "create_tag",
  "list_comments",
  "create_comment",
  "update_comment",
  "comments_add_comment_to_thread",
  "comments_resolve_thread",
  "delete_comment",
  "delete_thread",
];

/**
 * Tools that always pause for approval: the irreversible deletes, and replacing the queue
 * schedule, which moves every queued post at once.
 */
const ALWAYS_GATED_TOOLS = [
  "delete_draft",
  "delete_comment",
  "delete_thread",
  "queue_put_queue_schedule",
];

/**
 * Tools that can publish or schedule a post. They pause unless the call is a plain draft.
 */
const PUBLISH_TOOLS = ["create_draft", "edit_draft"];

/**
 * Whether a create or edit call saves a plain draft with no publish time.
 *
 * @remarks
 * Fails closed: anything other than an input whose `requestBody` leaves `publish_at` and
 * `plan_at` unset counts as scheduling, so an unexpected input shape asks for approval.
 *
 * @param input - The raw input the model passed to the tool.
 * @returns `true` only for a recognizable draft with no publish time.
 */
const isPlainDraft = (input: unknown): boolean => {
  const body = (input as { requestBody?: unknown } | null)?.requestBody;
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const { publish_at: publishAt, plan_at: planAt } = body as Record<
    string,
    unknown
  >;
  return [publishAt, planAt].every(
    (value) => value === undefined || value === null || value === ""
  );
};

/**
 * Typefully connection (MCP): drafts, the publishing queue, media, tags, and comments.
 *
 * @remarks
 * eve passes the approval policy the qualified tool name, `typefully__<tool>`, so each list above
 * is matched exactly against the part after the separator. A name that doesn't match the server's
 * fails open silently, so check any new entry against the server's published tool list.
 *
 * The server authenticates with a static API key, the one static credential in this template,
 * read from `TYPEFULLY_API_KEY`. That makes the connection app-scoped: one shared Typefully
 * workspace across all Slack users.
 */
export default defineMcpClientConnection({
  approval: ({ toolName, toolInput }) => {
    const tool = toolName.split("__").pop() ?? toolName;
    if (ALWAYS_GATED_TOOLS.includes(tool)) {
      return "user-approval";
    }
    if (PUBLISH_TOOLS.includes(tool) && !isPlainDraft(toolInput)) {
      return "user-approval";
    }
    return "not-applicable";
  },
  auth: {
    getToken: () => {
      const token = process.env.TYPEFULLY_API_KEY;
      if (!token) {
        throw new Error("TYPEFULLY_API_KEY is not set.");
      }
      return Promise.resolve({ token });
    },
  },
  description:
    "Typefully: draft, schedule, and manage social posts across X, LinkedIn, Threads, Bluesky, " +
    "and Mastodon. List social sets (accounts) and their connected platforms; create, edit, " +
    "read, and list drafts; schedule posts and manage the publishing queue; upload media; " +
    "organize with tags; and manage comment threads.",
  tools: { allow: ALLOWED_TOOLS },
  url: "https://mcp.typefully.com/mcp",
});

import { getConnectorMetadata } from "@vercel/connect";
import { defineDynamic, defineInstructions } from "eve/instructions";

/**
 * The name every connector in this template uses, so its UID is predictable:
 * `vercel connect create <service> --name company-brain` creates
 * `<service>/company-brain` and attaches it to the linked project.
 */
const CONNECTOR_NAME = "company-brain";

/** The UID `vercel connect create <service> --name company-brain` gives a connector. */
export function connectorUid(service: string): string {
  return `${service}/${CONNECTOR_NAME}`;
}

const CHECK_TTL_MS = 5 * 60_000;
const checks = new Map<string, { readonly attached: Promise<boolean>; readonly atMs: number }>();

/**
 * Whether a Vercel Connect connector is attached to this project. Cached for a
 * few minutes, so a newly created connector takes effect without a redeploy.
 */
export function isConnectorAttached(uid: string): Promise<boolean> {
  const check = checks.get(uid);
  if (check !== undefined && Date.now() - check.atMs <= CHECK_TTL_MS) return check.attached;
  const attached = getConnectorMetadata(uid).then(
    () => true,
    () => false,
  );
  checks.set(uid, { attached, atMs: Date.now() });
  return attached;
}

interface SetupNote {
  /** Product name, such as `Notion`. */
  readonly label: string;
  /** Vercel Connect service key, such as `notion`. */
  readonly service: string;
  /** `--connection-method` for services with more than one. */
  readonly connectionMethod?: string;
  /** Extra `vercel connect create` flags, such as `--data @credentials.json`. */
  readonly createFlags?: string;
  /** What the agent can't reach without it, such as `pages and databases`. */
  readonly what: string;
  /** Path of the instructions file that defines this note. */
  readonly file: string;
  /** Steps before creating the connector. */
  readonly beforeCreate?: readonly string[];
  /** Steps after creating the connector. */
  readonly afterCreate?: readonly string[];
  /** Whether each person signs in with their own account. */
  readonly perPerson?: boolean;
}

/**
 * Instructions that tell the agent a source isn't connected and how an admin
 * connects it. They say nothing once the connector is attached.
 */
export function connectorSetupNote(note: SetupNote) {
  const method = note.connectionMethod ? ` --connection-method ${note.connectionMethod}` : "";
  const flags = note.createFlags ? ` ${note.createFlags}` : "";
  const steps = [
    ...(note.beforeCreate ?? []),
    `From the agent's linked Vercel project, run \`vercel connect create ${note.service}${method} --name ${CONNECTOR_NAME}${flags}\`. It creates the connector and attaches it to the project.`,
    ...(note.afterCreate ?? []),
  ];
  const content = [
    `## ${note.label}`,
    `${note.label} isn't connected, so you can't reach its ${note.what}. When someone asks about ${note.label} or connecting it, say so plainly, and that an admin can connect it:`,
    steps.map((step, index) => `${index + 1}. ${step}`).join("\n"),
    [
      "The agent picks it up within a few minutes, without a redeploy.",
      note.perPerson
        ? `Each person then signs in to ${note.label} the first time you need it, so you see only what they can see.`
        : "",
      `To drop this note, delete \`${note.file}\`.`,
    ]
      .filter(Boolean)
      .join(" "),
  ].join("\n\n");
  const uid = connectorUid(note.service);
  return defineDynamic(async () =>
    (await isConnectorAttached(uid)) ? null : defineInstructions({ content }),
  );
}

import { defineTool } from "eve/tools";
import { z } from "zod";
import { judgeRules } from "#lib/decisions/config.js";
import {
  COPY_RULE_LABELS,
  COPY_RULES,
  type CopyCheck,
  checkPatterns,
  MAX_BODY_LENGTH,
  MAX_SUBJECT_LENGTH,
  SEND_TYPES,
} from "#lib/email/config.js";

/**
 * The email pre-send copy check.
 *
 * @remarks
 * A factory in the same shape as the other shared tools, called from a one-line file in the email
 * agent's `tools/`. The patterns and the questions live in `config.ts`; this module is the tool
 * interface over them.
 *
 * @packageDocumentation
 */

/**
 * The rule names, in report order.
 */
const RULE_NAMES = Object.keys(COPY_RULES) as (keyof typeof COPY_RULES)[];

/**
 * Notes for a judged row, by verdict.
 */
const VERDICT_NOTES = {
  fail: "The copy does not appear to meet this. Fix it before asking for approval.",
  pass: "The copy appears to meet this.",
  unsure:
    "Too close to call. Read the copy and settle it yourself, or ask the user.",
} as const;

/**
 * Note for a row the decision model never answered.
 */
const NOT_JUDGED_NOTE =
  "Not judged, because the decision model was unavailable. Read the copy and settle it yourself.";

/**
 * Tool that checks final email copy against what must be true before a send.
 *
 * @remarks
 * Runs the pattern checks, then asks the decision model the copy rules. The result is a report
 * for the agent to act on and for the user to see before they approve. It carries no overall
 * verdict on purpose: the approval belongs to the user, and the questions this tool cannot read
 * from the copy (consent, jurisdiction) stay with them.
 *
 * A decision model that is unavailable leaves its rows as `unsure` rather than failing the call,
 * so the pattern checks are always reported.
 *
 * @returns The configured tool.
 */
export const checkSendReadinessTool = () =>
  defineTool({
    description:
      "Check final email copy before asking the user to approve a send. Pass the subject, the " +
      "body exactly as it will be sent, the plain text version, and how it will go out. Returns " +
      "one row per check: the unsubscribe placeholder, name placeholders with no fallback, the " +
      "plain text version, a physical postal address, a clear opt-out notice, whether the mail " +
      "is identifiable as an advertisement, and whether the subject misleads. Fix every failed " +
      "row and settle every unsure row by reading the copy before you ask for approval, and tell " +
      "the user what you found. A report with no failed rows is a floor rather than clearance to " +
      "send: consent, which countries the recipients are in, and how opt-outs are honored are " +
      "not in the copy, so they remain questions for the user.",
    /**
     * Run the pattern checks and the decision-model rules over the copy.
     *
     * @param input - Validated tool input.
     * @param input.subject - The subject line.
     * @param input.body - The HTML or text body as it will be sent.
     * @param input.plainText - The plain text version, when one exists.
     * @param input.sendType - Whether the copy goes out as a broadcast or a one-off send.
     * @param ctx - Tool context; supplies the call's `abortSignal`.
     * @returns The report rows and whether the judgment rules were `judged` at all.
     */
    async execute({ body, plainText, sendType, subject }, ctx) {
      const judgments = await judgeRules(
        COPY_RULES,
        { body, subject },
        ctx.abortSignal
      );
      const verdicts = new Map(
        judgments?.map(({ rule, verdict }) => [rule, verdict])
      );
      const judged: CopyCheck[] = RULE_NAMES.map((rule) => {
        const status = verdicts.get(rule);
        return {
          check: COPY_RULE_LABELS[rule],
          note: status ? VERDICT_NOTES[status] : NOT_JUDGED_NOTE,
          status: status ?? "unsure",
        };
      });
      return {
        checks: [...checkPatterns(body, plainText, sendType), ...judged],
        judged: judgments !== null,
      };
    },
    inputSchema: z.object({
      body: z
        .string()
        .min(1)
        .max(MAX_BODY_LENGTH)
        .describe(
          "The HTML or text body exactly as it will be sent, placeholders included."
        ),
      plainText: z
        .string()
        .max(MAX_BODY_LENGTH)
        .optional()
        .describe("The plain text version. Omit it only when none exists yet."),
      sendType: z
        .enum(SEND_TYPES)
        .describe(
          "'broadcast' for a campaign to a segment, 'one-off' for a single email or a batch."
        ),
      subject: z
        .string()
        .min(1)
        .max(MAX_SUBJECT_LENGTH)
        .describe("The subject line as it will be sent."),
    }),
    outputSchema: z.object({
      checks: z
        .array(
          z.object({
            check: z.string().describe("What was checked."),
            note: z
              .string()
              .describe("What was found, or what to do about it."),
            status: z
              .enum(["pass", "fail", "unsure"])
              .describe(
                "'pass' = met; 'fail' = not met; 'unsure' = could not be settled, so read the copy."
              ),
          })
        )
        .describe("One row per check, pattern checks first."),
      judged: z
        .boolean()
        .describe(
          "False when the decision model was unavailable, so the judgment rows are all unsure."
        ),
    }),
  });

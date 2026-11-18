import type { Verdict } from "#lib/decisions/config.js";

/**
 * Bounds, patterns, and questions for the email pre-send copy check.
 *
 * @remarks
 * Mail cannot be recalled, so the copy is checked once more before the agent asks the user to
 * approve a send. Some of what has to be true is a matter of pattern (a placeholder is present, a
 * name has a fallback) and some is a matter of reading (there is a postal address, the subject is
 * honest). The patterns live here as pure functions and the reading goes to the decision model as
 * {@link COPY_RULES}.
 *
 * Everything here reads copy that was handed in. Nothing reaches Resend, so the connection's allow
 * list and its send approval are untouched by this check.
 *
 * @packageDocumentation
 */

/**
 * Maximum subject line length accepted, in characters.
 *
 * @defaultValue 500
 */
export const MAX_SUBJECT_LENGTH = 500;

/**
 * Maximum body length accepted, in characters, for the HTML or text body and the plain text
 * version.
 *
 * @defaultValue 200_000
 */
export const MAX_BODY_LENGTH = 200_000;

/**
 * How the copy will go out.
 */
export const SEND_TYPES = ["broadcast", "one-off"] as const;

/**
 * One of {@link SEND_TYPES}.
 */
export type SendType = (typeof SEND_TYPES)[number];

/**
 * One row of the pre-send report.
 */
export interface CopyCheck {
  /** What was checked. */
  check: string;
  /** What was found, or what to do about it. */
  note: string;
  /** The outcome. `unsure` rows are for the agent to settle by reading the copy. */
  status: Verdict;
}

/**
 * The placeholder Resend replaces with each recipient's unsubscribe link in a broadcast.
 */
const UNSUBSCRIBE_PLACEHOLDER = "{{{RESEND_UNSUBSCRIBE_URL}}}";

/**
 * Matches a name placeholder written with no fallback.
 *
 * @remarks
 * `{{{FIRST_NAME|there}}}` carries a fallback and does not match. A fixed literal pattern, so
 * nothing from the copy is interpolated into it.
 */
const NAME_WITHOUT_FALLBACK = /\{\{\{\s*(?:FIRST_NAME|LAST_NAME)\s*\}\}\}/g;

/**
 * Run the checks that are a matter of pattern rather than judgment.
 *
 * @remarks
 * The unsubscribe placeholder is a broadcast feature. A one-off send carries its own link, which a
 * pattern can't recognize, so a missing placeholder there is `unsure` rather than `fail`.
 *
 * @param body - The HTML or text body as it will be sent.
 * @param plainText - The plain text version, when one was written.
 * @param sendType - Whether the copy goes out as a broadcast or as a one-off send.
 * @returns One row each for the unsubscribe placeholder, name fallbacks, and the plain text
 * version.
 */
export const checkPatterns = (
  body: string,
  plainText: string | undefined,
  sendType: SendType
): CopyCheck[] => {
  const bareNames = [...new Set(body.match(NAME_WITHOUT_FALLBACK) ?? [])];
  return [
    body.includes(UNSUBSCRIBE_PLACEHOLDER)
      ? {
          check: "Unsubscribe link in the body",
          note: `${UNSUBSCRIBE_PLACEHOLDER} is present.`,
          status: "pass",
        }
      : {
          check: "Unsubscribe link in the body",
          note:
            sendType === "broadcast"
              ? `${UNSUBSCRIBE_PLACEHOLDER} is missing. Add it so each recipient gets a ` +
                "working unsubscribe link."
              : `${UNSUBSCRIBE_PLACEHOLDER} is absent, which is expected outside a broadcast. ` +
                "Confirm the body carries its own working unsubscribe link.",
          status: sendType === "broadcast" ? "fail" : "unsure",
        },
    bareNames.length === 0
      ? {
          check: "Name placeholders carry a fallback",
          note: "No name placeholder is missing a fallback.",
          status: "pass",
        }
      : {
          check: "Name placeholders carry a fallback",
          note: `Add a fallback to ${bareNames.join(", ")}, as in {{{FIRST_NAME|there}}}.`,
          status: "fail",
        },
    plainText?.trim()
      ? {
          check: "Plain text version",
          note: "A plain text version was supplied.",
          status: "pass",
        }
      : {
          check: "Plain text version",
          note: "No plain text version was supplied. Write one before sending.",
          status: "fail",
        },
  ];
};

/**
 * The judgment rules asked of the decision model, keyed by rule name.
 *
 * @remarks
 * Each maps to a row in the `deliverability` skill's legal requirements table that is readable
 * from the copy. The rows that depend on facts outside the copy (consent, jurisdiction, how the
 * opt-out is run afterwards) are deliberately absent: those are questions for the user.
 *
 * Each question is phrased so that "yes" means the copy is fine.
 */
export const COPY_RULES = {
  identifiableAsAdvertisement:
    "Would a recipient clearly understand that this message is marketing from the sender, " +
    "rather than a personal note or a transactional notice?",
  optOutNotice:
    "Does the body clearly tell the recipient how to stop receiving further mail?",
  postalAddress:
    "Does the body contain a physical postal address for the sender, such as a street address " +
    "or a PO box with a city?",
  subjectNotMisleading:
    "Does the subject line honestly describe what the body contains?",
} as const;

/**
 * The report label for each judgment rule.
 */
export const COPY_RULE_LABELS: Readonly<
  Record<keyof typeof COPY_RULES, string>
> = {
  identifiableAsAdvertisement: "Identifiable as an advertisement",
  optOutNotice: "Clear notice of how to decline further mail",
  postalAddress: "Physical postal address of the sender",
  subjectNotMisleading: "Subject line does not mislead",
};

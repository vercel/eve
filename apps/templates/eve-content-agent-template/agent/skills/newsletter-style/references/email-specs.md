# Email newsletter specs

Concrete limits and specs for quick reference. Only the numbers below are sourced; don't add
others without a source. Display limits vary by client, so these are practical ranges, not
guarantees — when it matters, preview in Litmus or Email on Acid.

## Subject line

| Thing | Value |
| --- | --- |
| Mailchimp recommended max | 9 words / 60 characters |
| Widely cited sweet spot | 30–50 characters |
| Shown on mobile before truncation | ~33–43 characters |
| Shown on desktop (Gmail) | up to ~70 characters |
| Max emojis | 1 |
| Max punctuation marks | 3 |

Front-load the message inside the first ~33 characters so it survives mobile truncation. Open
rates drop as length grows, with the steepest fall after ~50 characters.

## Preheader / preview text

| Thing | Value |
| --- | --- |
| Recommended total length | 40–130 characters |
| Shown on mobile before truncation | ~30–40 characters |
| Shown on Gmail desktop | ~100–120 characters |
| Essential words within first | ~40 characters |

Always set it explicitly; an empty preheader lets the client pull whatever text comes first in
the body. Extend the subject line, don't repeat it.

## From-name

- Recognizable and consistent across issues. Recognizing the sender is the top open factor for
  ~88% of users — above subject-line relevance.
- "FirstName from Brand" adds a human tone when the brand is already known; otherwise lead with
  the brand name.

## Layout & CTA

| Thing | Value |
| --- | --- |
| Container width (desktop) | ~600px, single column |
| Body font size | 16–18px |
| CTA buttons per issue | 1 primary |
| CTA copy length | 2–5 words |

Read time after open averages ~51 seconds (~200 words), and most readers scan rather than read.
Default to a clean, near-plain-text feel: in HubSpot's A/B tests plain-text beat HTML on opens
and clicks, and a single image reduced click rate. Always pair any HTML with a plain-text
(multipart) version.

## Sources

- Mailchimp — Best Practices for Email Subject Lines: https://mailchimp.com/help/best-practices-for-email-subject-lines/
- Mailchimp — Email Sender Name Best Practices: https://mailchimp.com/resources/sender-name/
- Twilio — What's the ideal email subject line length?: https://www.twilio.com/en-us/blog/ideal-email-subject-length
- Campaign Monitor — Structure your email marketing for scanners: https://www.campaignmonitor.com/blog/email-marketing/structure-email-marketing-campaigns-scanners/
- Nielsen Norman Group — Text Scanning Patterns: Eyetracking Evidence: https://www.nngroup.com/articles/text-scanning-patterns-eyetracking/
- HubSpot — Plain Text vs. HTML Emails: Which Is Better? [New Data]: https://blog.hubspot.com/marketing/plain-text-vs-html-emails-data

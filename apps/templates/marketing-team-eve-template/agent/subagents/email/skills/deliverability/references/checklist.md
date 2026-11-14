# Deliverability checklist

Checks in priority order. The Evidence column says what it takes to verify each one honestly: a named tool means you can check it and cite the result, and `none` means nothing available here can confirm it, so report it as unchecked and name what would answer it. Never move a `none` row into a finding.

Every number in the Thresholds section names the page it came from, and those pages are listed under Sources. Quote a threshold with its provider attached, because the providers do not publish the same numbers.

## 1. Sending domain

| Check                                                   | Evidence                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| The domain exists in this Resend workspace              | `list-domains`                                                |
| Its status is verified                                  | `get-domain`                                                  |
| SPF and DKIM records are the ones Resend issued         | `get-domain`                                                  |
| The from address in the campaign uses a verified domain | `get-domain` plus `get-broadcast`                             |
| Sending from a subdomain rather than the root domain    | `list-domains`, by inspection of the name                     |
| The DNS records are currently published and unmodified  | none: verification status reflects what Resend last confirmed |
| DMARC is published, and at what policy                  | none: DMARC is a DNS record Resend does not issue             |
| Reverse DNS and TLS on the sending path                 | none: managed by Resend                                       |
| BIMI                                                    | none                                                          |

Resend recommends sending from one or more subdomains, such as `updates.example.com`, rather than the root domain, so that marketing reputation stays separate from the rest of the domain's mail. It does not lower the Gmail bulk sender count: Google counts messages sent from the same primary domain and all of its subdomains together.

Resend's DMARC guidance is to publish `p=none` with a working `rua` address first, confirm that every service sending on the domain is passing, then move to `quarantine` and then `reject`. Google and Yahoo both accept `p=none` as the baseline, so meeting the requirement and protecting the domain are different bars. Say which bar the user's goal is, and say that you cannot read their current policy.

## 2. Results of sends that already happened

| Check                                                          | Evidence                                                                            |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Whether a specific email was delivered, bounced, or complained | `get-email`                                                                         |
| Delivery outcomes across recent sends                          | `list-emails`                                                                       |
| A broadcast's send state and recipient counts                  | `get-broadcast`                                                                     |
| API-level failures and their responses                         | `list-logs`, `get-log`                                                              |
| Bounce rate for a campaign                                     | `list-emails`, computed from the results you can read                               |
| Complaint rate for a campaign                                  | `list-emails`, if complaint events are present; otherwise none                      |
| Inbox versus spam placement                                    | none: this is the number people mean by deliverability, and no tool here reports it |
| Domain or IP reputation over time                              | none: Google Postmaster Tools, Microsoft SNDS, Yahoo's Complaint Feedback Loop      |
| Blocklist status                                               | none                                                                                |
| Whether opens are real                                         | none on Apple clients: Mail Privacy Protection inflates them                        |

Compute rates from what you actually read and say how many messages the rate is over. A complaint rate across 40 sends is noise, and presenting it as a trend is worse than not presenting it.

A rate you computed and a rate a provider computed are not the same measurement. Yahoo states that it calculates spam rate over mail delivered to the inbox, so your own figure over everything accepted reads lower than the one Yahoo enforces against. Google's published guidance does not state its denominator, so do not assert one.

## 3. Thresholds

| Thing                                                            | Threshold                                                                  | Source                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Spam complaint rate, where Google enforcement begins             | 0.30%                                                                      | Google, sender guidelines                                    |
| Spam complaint rate, Google's recommended ceiling                | 0.10%                                                                      | Google, sender guidelines                                    |
| Spam complaint rate at Yahoo, measured over inbox-delivered mail | 0.3%                                                                       | Yahoo, sending best practices                                |
| Spam complaint rate while warming up                             | 0.08%                                                                      | Resend, warm-up guide                                        |
| Bounce rate while warming up                                     | 4%                                                                         | Resend, warm-up guide                                        |
| Gmail bulk sender threshold                                      | close to 5,000 messages or more to personal Gmail accounts within 24 hours | Google, sender guidelines FAQ                                |
| Microsoft high-volume sender threshold                           | over 5,000 messages a day to Microsoft's consumer domains                  | Microsoft, Outlook.com Postmaster                            |
| Yahoo bulk sender threshold                                      | not published: Yahoo states it will not specify a volume threshold         | Yahoo, FAQs                                                  |
| DKIM key length                                                  | 1024 bits minimum, 2048 recommended                                        | Google, sender guidelines; Yahoo, FAQs                       |
| Time to honor an unsubscribe                                     | 2 days, required at Yahoo; 48 hours, recommended by Google                 | Yahoo, sending best practices; Google, sender guidelines FAQ |

Four notes on these.

Google's bulk sender classification is permanent once crossed. Google states that a sender meeting the criteria even once is permanently a bulk sender, that the status has no expiry, and that changing sending practices later does not remove it. Counting rolls subdomains up into the primary domain, so splitting volume across `news.example.com` and `example.com` does not keep either under the threshold.

Google's 0.10% and Resend's 0.08% are different numbers for different situations, not a contradiction to reconcile. The Google figure is the standing recommendation for a domain in normal operation. The Resend figure is a tighter ceiling while ramping, when the volume is small enough that a handful of complaints moves the rate a long way, and the instruction attached to it is to slow the ramp and find the cause rather than to push through.

Resend signs outbound mail with 1024-bit DKIM keys and does not support 2048-bit keys, which meets the stated minimum at Google and Yahoo. Do not recommend rotating to a 2048-bit key as a fix for a domain sending through Resend.

Ramp shape, from Resend's published schedule and framed there as a baseline rather than a rule: a new domain starts at 150 messages on day one and reaches about 2,000 a day by day seven, and an established domain starts at 1,000 and reaches about 10,000 a day by day seven.

Enforcement has moved since the February 2024 rollout, so treat undated advice about these requirements as suspect. Google enforced one-click unsubscribe from June 2024, made senders above 0.3% spam rate ineligible for delivery mitigations from June 2024, and ramped enforcement on non-compliant traffic further in November 2025 with temporary and permanent rejections. Yahoo began enforcing List-Unsubscribe in June 2024. Microsoft started enforcing SPF, DKIM, and DMARC for high-volume senders on May 5, 2025, junking non-compliant mail with rejection announced as the next step. Google also says DMARC alignment with both SPF and DKIM is likely to become a requirement, which is a signal rather than a rule today.

## 4. List hygiene

| Check                                                                 | Evidence                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Contacts in the target segment, and how many                          | `get-segment`, `list-contacts`                                                              |
| Whether contacts carry topic subscriptions                            | `list-contact-topics`                                                                       |
| How the target segment is defined                                     | `get-segment`                                                                               |
| Whether that definition actually excludes people who stopped engaging | none: the definition is readable, whether it reflects engagement is a question for the user |
| How the list was built, and whether consent was recorded              | none: ask the user                                                                          |
| Whether addresses are valid before sending                            | none: bounces are the feedback, which is why ramping matters                                |
| Spam traps in the list                                                | none, ever                                                                                  |
| What else has gone to this segment recently, and when                 | `list-broadcasts`, `get-broadcast`                                                          |
| Whether this segment overlaps another one you also mail               | none: overlap is not readable from the definitions, so ask                                  |

Cadence is the check people skip, and it feeds straight back into the complaint rate. The same person receiving three campaigns in a week reports the third one, and the segment definitions will not tell you that, because two segments can cover the same person without either looking wrong. Read the recent sends before proposing a time, and if something went out in the last few days, say so and let the user decide rather than scheduling over it.

A list imported from a previous tool is the case worth stopping on. It arrives with no consent record and often with addresses that have been dead long enough to be recycled as traps, and the first large send to it is where the damage happens. Recommend a ramp and a re-engagement pass before a full send, and say plainly that you cannot inspect the addresses for traps.

## 5. Content-side causes

These are checkable from the copy rather than from Resend, so they belong in the same report. `email-style` owns the copy rules themselves, `lint_against_style` checks the word-level ones, and `check_send_readiness` checks the placeholders.

| Check                                                                                                 | Evidence                                                                        |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A visible unsubscribe link in the body                                                                | `check_send_readiness`                                                          |
| Link domains match the sending domain                                                                 | read the copy                                                                   |
| Not a single large image with almost no text                                                          | read the copy                                                                   |
| No manufactured urgency or the banned phrases                                                         | `lint_against_style`                                                            |
| Sender name and reply-to are recognizable                                                             | `get-broadcast`                                                                 |
| Whether the `List-Unsubscribe` and `List-Unsubscribe-Post` headers are on the message                 | none: on a one-off send they are whatever the call passed, so ask what was sent |
| Whether the one-click endpoint takes a POST, returns 200 or 202, and asks nothing further of the user | none: the endpoint lives outside Resend, so ask who owns it                     |

Mismatched link domains are worth calling out specifically. Sending from one domain and linking to another is a pattern filters weight against, because it is what phishing does.

One-click unsubscribe has mechanics that quietly break it, all of them from RFC 8058. The `List-Unsubscribe-Post` value is exactly `List-Unsubscribe=One-Click`, the `List-Unsubscribe` field carries an HTTPS URI, the endpoint must not answer the POST with a redirect, and the URI has to identify the recipient and the list on its own so nothing more is asked of the person. Both headers also have to be covered by the DKIM signature, or a receiver should not offer one-click at all. When a user reports that Gmail is not showing the unsubscribe control, these are the things to ask about.

## 6. Legal requirements

These sit outside the priority order above, because they are not deliverability checks. A send that fails one should not go out at all, however good its authentication is. Name them as requirements rather than as legal advice, and say that US, UK, and EU rules are not the whole world.

| Check                                                           | Evidence                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A valid physical postal address of the sender is in the message | `check_send_readiness`                                                      |
| The message is clearly identifiable as an advertisement         | `check_send_readiness`                                                      |
| Clear notice of how to decline further mail                     | `check_send_readiness`                                                      |
| The subject line does not mislead about what is inside          | `check_send_readiness`                                                      |
| The from and header information is not false or misleading      | read the copy, `get-broadcast`                                              |
| The opt-out stays live for at least 30 days after the send      | none: a process question for whoever runs the list                          |
| Opt-out requests are honored within 10 business days            | none: same, and it happens after the send                                   |
| A lawful basis exists for marketing to this list                | none: ask the user                                                          |
| Whether the soft opt-in exception applies                       | none: it turns on how the details were collected, which only the user knows |
| Which countries the recipients are in                           | none: ask the user, because it changes which rules apply                    |

The physical postal address is the one to check first, because it is required in every commercial message, it is verifiable from the body alone, and it is the element most often missing. US law states the requirement as "a valid physical postal address of the sender".

The consent rows are worth asking about rather than skipping. In the UK and EU, marketing email to individuals needs prior consent, with a narrow exception where the sender "has obtained the contact details of the recipient of that electronic mail in the course of the sale or negotiations for the sale" of something, markets only "that person's similar products and services only", and gave "a simple means of refusing" both at collection and in every message since. Paragraphs adding a charity version of that exception took effect on 5 February 2026. Under the GDPR, direct marketing "may be regarded as carried out for a legitimate interest", but a person's objection to direct marketing is unqualified: there is no interest to weigh against it once they object.

Two notes on scope. These are the US, UK, and EU positions, and other markets have their own rules, some stricter. And a message that mixes marketing into a transactional one may change which rules apply to it, which is a question to raise with the user rather than decide.

## Sources

- Google, Email sender guidelines: https://support.google.com/mail/answer/81126
- Google, Email sender guidelines FAQ: https://support.google.com/a/answer/14229414
- Yahoo Sender Hub, Sending best practices and requirements: https://senders.yahooinc.com/best-practices/
- Yahoo Sender Hub, FAQs: https://senders.yahooinc.com/faqs/
- Microsoft, Outlook.com Postmaster: https://substrate.office.com/ip-domain-management-snds/postmaster
- Resend, Domain and IP warm-up guide: https://resend.com/docs/knowledge-base/warming-up
- Resend, Domains: https://resend.com/docs/dashboard/domains/introduction
- Resend, DMARC: https://resend.com/docs/dashboard/domains/dmarc
- Resend, Add an unsubscribe link to transactional emails: https://resend.com/docs/dashboard/emails/add-unsubscribe-to-transactional-emails
- RFC 8058, Signaling One-Click Functionality for List Email Headers: https://www.rfc-editor.org/rfc/rfc8058.html
- CAN-SPAM Act, 15 U.S.C. 7704, Protections against unsolicited commercial electronic mail: https://www.law.cornell.edu/uscode/text/15/7704 . Source for the physical postal address, advertisement identification, misleading header and subject prohibitions, the 30-day opt-out window, and the 10-business-day limit to honor a request.
- PECR 2003, regulation 22, Use of electronic mail for direct marketing: https://www.legislation.gov.uk/uksi/2003/2426/regulation/22 . Source for the UK consent requirement and the soft opt-in conditions. The charity paragraphs were inserted with effect from 5 February 2026 by the Data (Use and Access) Act 2025.
- GDPR, Regulation (EU) 2016/679: https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32016R0679 . Recital 47 for direct marketing as a legitimate interest, recital 70 for the right to object at any time and free of charge. The article text was not readable at this URL, so the articles are not quoted here.

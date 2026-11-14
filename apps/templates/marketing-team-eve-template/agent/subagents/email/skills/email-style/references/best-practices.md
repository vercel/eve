# Email best practices

Why the rules in `SKILL.md` are what they are, plus the failure modes worth checking for by name. The numbers live in `format-specs.md`.

## The inbox is a queue, not a page

A reader meets an email as one row among many: a sender name, a subject, and a fragment of preview text. Everything else is downstream of that row earning a click. This is why the subject and preview are written last, when you know what the mail says, and why they are written as one unit rather than separately. Litmus makes the mechanical version of the same point: in webmail the subject and the preview share one strip of space, so a long subject squeezes the preview.

It is also why the sender name matters as much as the subject. A recognizable from name is the strongest signal in the row, and a mail sent from an address nobody recognizes is judged on the subject alone.

## One email, one job

The reliable way to lose a conversion is to offer three. A newsletter with a featured post, a webinar signup, a product announcement, and a survey link asks the reader to make a decision, and the default answer to a decision is to postpone it.

If the mail genuinely has several things in it, rank them. One primary call to action, repeated once near the end, with the rest as plain links that do not compete visually.

## Write for the preview pane

Many readers never scroll. The first line of the body is read far more than the second paragraph, so a warm-up sentence spends the most valuable line in the email on nothing. Litmus's own guidance is the same for the subject: front-load it, because the front of it is what survives.

The corollary: don't open with a large hero image. In a preview pane it pushes the text below the fold, and in a client that blocks images it opens with an empty box. Litmus's image blocking guide names the Outlook desktop clients as the main blockers, and records that Outlook renders alt text after a warning message rather than in place of the image.

## Link text and alt text are read out of context

Screen readers can list links in isolation, and scanners read them the same way. "Click here" and "Read more" are meaningless once separated from the sentence around them, which is why the link text carries the destination.

Alt text is functional. Email on Acid states it directly: alt text is not marketing copy, and you should not put a call to action in it or try to sell with it. It replaces the image for a reader who cannot see it, so it describes what the image communicates and stops. If an image needs several sentences of alt text, its content belongs in the body copy instead, and `format-specs.md` has the length and the decorative-image rule.

## Spam words are a copy problem, not a deliverability problem

`references/banned-words.json` is a copy-quality list. It is not a spam filter workaround, and treating it as one gets the priorities backwards.

The evidence points one way. Google's own sender guidelines name no words or phrases at all. What they require is authentication, a complaint rate under a stated ceiling, valid DNS, TLS, one-click unsubscribe for bulk senders, and honesty in the headers: don't open a subject with "Re:" or "Fwd:" unless the message really is one, don't fake graphic elements or verification badges with emoji or non-standard characters, and don't stuff subject-like text into the display name. Mailgun's Email Impact Report, in its 2026 edition, says the idea that using words like "free" in a subject line will get you filtered into spam is untrue. Mailgun's page on how mailbox filters work describes content as fingerprinting, pattern matching, and links to known malicious sites, not word choice, and puts the weight on infrastructure and engagement instead. Litmus, in its subject line roundup, calls spam trigger words a thing of the past and reframes caps and exclamation points as an audience problem rather than a filtering one.

Two honest caveats. Reliable sources are not unanimous: Mailgun's own deliverability blog, in a March 2025 post, still tells readers to avoid trigger words and still names "free", "guaranteed", "urgent", and "exclusive deal". So the claim to make is that word choice is a weak signal that publishers disagree about, not that it has been proven to have no effect. And Mailgun's report adds the second-order reason the list still earns its place: language that reads like spam raises complaints, and complaints are a signal that does count.

So the rule is: fix the words because the copy is worse with them in, not because they will land the mail in a junk folder. When someone asks whether a subject line will hurt deliverability, the answer lives in the `deliverability` skill, which owns authentication, the sending domain, and the complaint and bounce numbers. Don't answer it from a word list.

## Failure modes that recur

- The subject promises something the body does not deliver. It buys one open and costs the next five, because the reader learns that this sender's subjects are unreliable. Google's guidelines put the extreme version of this in scope as a policy problem, not just a taste problem.
- Preview text left to default, so the row reads "View this email in your browser". Litmus's guide shows exactly that string arriving in the slot.
- The point of the email is in an image, so it is invisible to blocked-image clients and to screen readers.
- Alt text written as a sales line rather than a description, so a screen reader user hears an ad where the picture was.
- A decorative image given a description instead of a null alt, which adds noise for the one reader it was meant to help.
- The plain text version is autogenerated, so it arrives as a wall of markup fragments and naked URLs.
- The email is over the clipping threshold, so Gmail truncates it and the open-tracking code goes with it, which quietly corrupts the reporting for that send.
- Manufactured urgency on a mail with no deadline. It works once, then it trains the list. A real deadline is different, and saying it plainly is fine.
- Personalization tokens with no fallback, so a chunk of the list gets "Hi ,".
- The unsubscribe link is hidden or hard to use, which converts people who would have quietly left into people who report the mail as spam. See the `deliverability` skill for why that number matters.

## Before handing copy back

- Read the subject and preview together, at the truncation lengths, as they would appear in a row.
- Read the first line on its own. Does it earn the second?
- Find the single call to action. If you cannot, the email does not have one.
- Check every link's text away from its sentence.
- Read the plain text version end to end.
- Confirm nothing that matters exists only inside an image, and that every image's alt text describes rather than sells.
- Run `lint_against_style`, and read what it flags as a copy note rather than a deliverability finding.

## Sources

Every page below was opened and read. Dates are as the page shows them.

- Google, Email sender guidelines, requirements effective February 1 2024: https://support.google.com/mail/answer/81126
- Mailgun, Email Impact Report, deliverability chapter, 2026 edition citing 2025 survey data: https://www.mailgun.com/email-impact-report/chapter/deliverability-impact/
- Mailgun, Spam filters and deliverability, November 20 2024: https://www.mailgun.com/blog/deliverability/mailbox-spam-filters/
- Mailgun, Stop emails from going to spam, March 3 2025, cited as the dissenting view: https://www.mailgun.com/blog/deliverability/avoid-emails-going-to-spam/
- Litmus, 18 Subject Line Tips from Experts, published December 2012, updated June 17 2021: https://www.litmus.com/blog/how-to-write-the-perfect-subject-line-infographic
- Litmus, The Anatomy of a Good Email, July 5 2026: https://www.litmus.com/blog/the-anatomy-of-a-good-email
- Litmus, The Ultimate Guide to Email Preview Text, November 8 2024: https://www.litmus.com/blog/the-ultimate-guide-to-preview-text-support
- Litmus, The Ultimate Guide to Email Image Blocking, published October 3 2017, updated August 17 2021: https://www.litmus.com/blog/the-ultimate-guide-to-email-image-blocking
- Email on Acid, How to Write Alt Text for Better Accessibility in Emails, September 19 2023: https://www.emailonacid.com/blog/article/email-development/write-alt-text/
- W3C WAI, Images Tutorial, Decorative Images, updated July 27 2019: https://www.w3.org/WAI/tutorials/images/decorative/

The claims in this file that carry no source, that a recognizable sender name is the strongest signal in the row, that many readers never scroll, and the ranking advice under one job one email, are craft judgment. They are stated as judgment on purpose. Don't attach a statistic to them later without reading the page it came from.

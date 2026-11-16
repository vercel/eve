# Email patterns

Shapes for the email types that recur, what each one is actually for, and the way each one usually fails. These are starting structures, not templates to fill in.

## Newsletter

**For:** keeping a list warm and pointing them at work they would not otherwise see.

**Shape:** one lead item that gets real space, then two to four short pointers, then one action. Give the lead item the room, because it is what the subject line is promising.

**Fails when:** every item gets equal weight, so nothing in it is the reason to open. Five equally sized blurbs is a table of contents rather than a newsletter. Pick a lead and let it be obviously the lead.

**Also fails when:** it is sent on a schedule with nothing to say. Cadence is a promise about frequency, not a promise to fill the slot. Skipping a week costs less than sending filler.

## Announcement

**For:** telling people about one thing that changed.

**Shape:** what changed, in the first line. Who it affects. What they should do, if anything. Where to read more. Those four things and nothing else; the background belongs on the page you link to.

**Fails when:** it opens with the journey. "Six months ago the team set out to..." puts the sender's story where the reader's reason to care should be, and an opening paragraph of build-up is the part most likely to go unread: NN/g's eyetracking study found 67% of participants never fixated inside a newsletter's introduction at all. Lead with the change.

**Also fails when:** it buries whether action is required. If some readers must do something before a date, that goes near the top, separated from the rest, not in the fourth paragraph.

## Product or release notes

**For:** existing users who want to know what is new.

**Shape:** grouped by what the reader does, not by what the team shipped. A list of internal project names is useless; a list that starts with verbs is readable.

**Fails when:** it reads as a changelog. A changelog is a reference document that people consult; an email is a thing that arrives. Pick the two or three changes that matter and link the full list.

## Nurture or onboarding sequence

**For:** getting someone from signing up to actually using the thing.

**Shape:** each mail teaches one thing and asks for one action, and the sequence has an end. Write the last one first, because it tells you what the earlier ones are building toward.

**Fails when:** it is a drip of marketing rather than a sequence of help. If mail three does not depend on mail two, it is not a sequence, it is a schedule.

**Also fails when:** it keeps sending after the person has already done the thing. If the sequence cannot react to that, say so up front rather than letting a converted user get "still thinking about it?".

## Re-engagement

**For:** people who have not opened in a long time, before you remove them.

**Shape:** short, direct, and honest about why it arrived. Offer the exit as clearly as the stay. One mail, maybe two, then act on the silence.

**Fails when:** it is used as a pretext to send another campaign, or when nobody removes the non-responders afterwards. A re-engagement mail that changes nothing about the list is just another send to people who do not want it, and it costs deliverability for the people who do. See the `deliverability` skill.

## Transactional with marketing in it

**For:** a receipt, a confirmation, or a reset that someone also wants to use as a promotional surface.

**Shape:** the transactional content first, complete and unobstructed, then anything else clearly below it.

**Fails when:** the promotion crowds the thing the reader opened the mail for. NN/g's transactional email research found that leading with marketing risks the message being deleted, because the reader may never scroll far enough to reach the order details or tracking number they came for, and those are the two things they look for first. Beyond that, mixing marketing into transactional mail changes what compliance rules apply to it, so confirm it with the user rather than deciding on their behalf.

## A note on personalization

A merge tag is a mail merge, and whether it earns its place is genuinely contested rather than settled. Litmus carries both directions on one page: a figure from Yes Lifecycle Marketing that personalizing a subject line can raise opens by half, and its own re-engagement send where first-name personalization raised the open rate by five percentage points and cut the conversion rate by 50%. Litmus's own position elsewhere is that a first name not carried through the body is about as likely to hurt as to help, though the research behind that is not named. So do not treat a token as an improvement by default, and if the send is big enough to learn something, test it.

Two things are not in dispute. Every token needs a fallback that reads naturally, because a token with no value produces "Hi ," in front of a real person, which is worse than not using it. And relevance is the lever with the strongest measured effect: both Mailchimp and Klaviyo found segmented campaigns clicked at roughly twice the rate of unsegmented ones from comparable senders. Neither study put segmentation up against a name token, so treat those as two separate findings rather than one comparison.

Segments have to be relevant, not merely narrow. The same Mailchimp analysis found some segment types made things worse: segmenting by signup date raised bounces, complaints, and unsubscribes, and segmenting by past activity raised complaints and unsubscribes, because both can mean mailing people who had already stopped engaging.

## Sources

- Nielsen Norman Group, "Email Newsletters: Surviving Inbox Congestion", June 11 2006, https://www.nngroup.com/articles/email-newsletters-inbox-congestion/ . Eyetracking and field study, 42 participants, 117 newsletters. Source for 67% of participants recording zero fixations inside newsletter introductions.
- Nielsen Norman Group, "Transactional Email and Confirmation Messages", October 19 2008, https://www.nngroup.com/articles/transactional-and-confirmation-email/ . 92 transactional emails tested across two rounds. Source for marketing-first messages risking deletion because readers may not scroll to what they need, and for order description and tracking number being what readers look for first.
- Litmus, "18 Subject Line Tips from Experts to Win Email Opens", last updated June 17 2021, https://www.litmus.com/blog/how-to-write-the-perfect-subject-line-infographic . Source for both the Yes Lifecycle Marketing 50% open-rate figure and Litmus's own re-engagement result of plus five percentage points on opens and minus 50% on conversion. The page itself flags that its content is more than two years old.
- Litmus, "Your Guide for Personalized Email", undated, https://www.litmus.com/personalized-email . Source for the position that first-name-only personalization is as likely to hurt as help, quoting Chad White of Oracle. Noted as unattributed: the page says "research has shown" without naming a study, so it is reported here as a stated position rather than as a result.
- Mailchimp, "Effects of List Segmentation on Email Marketing Stats", updated February 1 2017, https://mailchimp.com/resources/effects-of-list-segmentation-on-email-marketing-stats/ . About 2,000 accounts, roughly 11,000 segmented campaigns, nearly 9 million recipients, each compared against the same sender's unsegmented campaigns. Clicks 100.95% higher and opens 14.31% higher overall. Also the source for the segment types that performed worse: signup-date segments showed bounces 55.18% higher, complaints 29.55% higher, and unsubscribes 33.76% higher, and activity segments showed complaints 10.34% higher and unsubscribes 5.49% higher.
- Klaviyo, "Email Segmentation Benchmarks", https://www.klaviyo.com/marketing-resources/segmentation-benchmark-report . 2,619,441,297 emails from US senders, sent October to December 2017. Campaigns to under 20% of a list versus campaigns to 90% or more: click rate 1.99% versus 0.92%, open rate 16.17% versus 9.95%, revenue per recipient $0.19 versus $0.06. The page is undated and the data is from 2017, so read the ratios rather than the absolute rates.
- Both segmentation studies rest on 2017 data and neither is a controlled experiment, so the direction is well supported and the size of the effect today is not.

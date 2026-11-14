# Email format specs

Rendering and truncation limits. Every figure here traces to a page in the Sources list, with the date that page carries, because email client behavior moves and a 2016 measurement is not a 2026 fact. Don't add a number without a source you have read. When you cannot verify a figure, give the guidance without it rather than approximating.

Read these as rendering constraints rather than as goals. A subject line gets truncated at a hard limit whether or not the copy is good, and that is worth designing around. The best length for opens is a much weaker claim and the sources genuinely disagree, so the guidance below optimizes for what survives the inbox.

## Subject line

| Thing | Figure | Source |
| --- | --- | --- |
| Front-load the hook within the first | 35 to 40 characters | Litmus, Anatomy of a Good Email (2026) |
| Displayed on iPhone in portrait | about 41 characters | Campaign Monitor (2021) |
| Displayed in Gmail | about 70 characters | Campaign Monitor (2021) |
| Mailchimp's recommended ceiling | 9 words and 60 characters | Mailchimp, Best Practices for Email Subject Lines |
| Punctuation marks | no more than 3 | Mailchimp, same page |
| Emoji | no more than 1 | Mailchimp, same page |

The sources disagree on length and the disagreement is worth carrying rather than resolving. Campaign Monitor recommends 41 characters, citing a Marketo study, and frames the real decision as device-driven: optimize somewhere between 41 characters for iPhone portrait and 70 for Gmail, based on which clients your own list uses. Mailchimp caps at 9 words and 60 characters, drawn from open rate performance across the mail sent through its platform. Litmus takes the opposite position and says there are no hard rules on subject line length, that you should front-load a long one and test length against your own list, and that you should not focus too much on character counts.

What all three agree on is front-loading, so that is the rule to follow. The truncation points are real. An exact character count that wins opens is not established, and Campaign Monitor's per-client numbers date from 2021, so treat them as the shape of the problem rather than as current measurements. Verify against your own list's clients when the count actually matters.

Two figures that used to sit in this table have been removed for want of a source: a "full visibility across Apple and Android devices" count, and a per-client Gmail-on-iPhone count. No first-party or established publisher page verified either.

## Preview text

| Thing | Figure | Source |
| --- | --- | --- |
| Truncation typically begins | 35 to 75 characters | Litmus, Anatomy of a Good Email (2026) |
| Litmus's recommended ceiling | under 90 characters | Litmus, Preview Text guide (2024) |
| What a subscriber may actually see | 5 lines, about 278 characters, down to 0 lines | Litmus, Preview Text guide (2024) |
| Repeating the subject or the first headline | never | judgment, not a measurement |
| Leaving it unset | never | judgment, not a measurement |

There is no single character limit. Litmus states plainly that the limit varies by client and by device, that subscriber settings change it, and that there is no way to track how much preview text showed up for a given recipient. Gmail lets users turn snippets off entirely. In webmail, the subject line and the preview text compete for the same row, so a long subject leaves less room for the preview. Front-load the keywords and treat anything past the first 35 characters as a bonus.

An unset preview gets filled by the client, usually from the first lines of copy, sometimes from image alt text, and occasionally from code. Litmus's own example shows "View this email in your browser" arriving in that slot.

One date-sensitive behavior: since iOS 18.1, iPadOS 18.1, and macOS Sequoia 15.1, shipped October 2024, Apple devices can display a generated summary of the email in place of the preview text you wrote. Litmus's guidance for Apple subscribers is to get the main message across in the subject line, since not every subject and preview pairing will survive. Confirm this is still how Apple behaves before you rely on it.

## Message size and layout

| Thing | Figure | Source |
| --- | --- | --- |
| Gmail clipping threshold | 102 KB of HTML | Litmus (2024), Mailchimp, Email on Acid (2021) |
| Working target to build under | below 80 KB | Email on Acid (2021) |
| Gmail iOS app clipping, as measured in 2014 | about 20,540 characters, roughly 20 KB | Email on Acid (2014) |

The 102 KB figure is the one number here that three independent publishers state, so it is the one to trust. Email on Acid adds two caveats from its own testing: the exact point Gmail clips is not consistent and smaller emails sometimes clip anyway, and because an ESP adds tracking markup after you hand the file over, you should build to a lower target than the limit itself.

Only the code counts. Litmus and Mailchimp both state that images are excluded from the size. Mailchimp adds the practical consequence: resizing an image does not reduce the message size, because the image loads from the sender's servers, while deleting one does, because it removes the markup.

Clipping has two consequences beyond the truncated copy. Mailchimp notes that the open-tracking code gets clipped along with everything else, so open rates for that send stop being reliable. Litmus notes that clipping lands wherever the limit falls, which can leave a table or div unclosed and break the layout.

The mobile figure needs a warning. Email on Acid measured the Gmail iOS app at roughly 20 KB of code, well under the web threshold, and found that the same code was not counted the same way: head elements counted, stripped style blocks and comments did not, and each image URL gained about 170 characters when Gmail swapped it for a proxy address. Image file size did not matter. That test is from 2014 and the article itself calls the number inexact, so carry the shape of it, that a mobile client can clip much earlier than the web one, and do not quote 20 KB as a current spec. A previous version of this file claimed a "75 KB elsewhere" mobile threshold; nothing verified it, so it is gone.

Two other claims are gone for the same reason: an "85 to 95 KB at risk" band, and the assertion that Gmail's "View entire message" fallback strips `<style>` tags. Litmus describes that fallback only as a webview link.

Container width is a convention rather than a spec, and the honest version is worth more than the round number. Litmus documents where 600 px came from: the most used clients of the era, Hotmail, Yahoo, and Outlook, had viewports around 500 to 550 px, so capping at 600 px avoided horizontal scrolling. Litmus then lists the rule among its email development myths and says a different maximum can make sense depending on which clients your subscribers use. That page is from 2016. So 600 px is inherited practice with a documented origin, not a rendering limit, and the wider constraint is readability: a measure with too many words per line is harder to read. `resend-build` owns the markup that implements whatever width you pick.

## Images and alt text

| Thing | Guidance | Source |
| --- | --- | --- |
| Alt text on every informative image | required | Mailchimp, Email on Acid |
| Length | 1 to 2 sentences, no more than two lines | Mailchimp, Email on Acid (2023) |
| Alt text longer than the image is wide | some clients will not display it | Mailchimp |
| Information carried only by an image | none | Litmus, Mailchimp |
| Calls to action inside alt text | no, alt text is functional | Email on Acid (2023) |
| Quotation marks inside alt text | never, they break the HTML | Mailchimp, Email on Acid |
| Openers like "image of" or "picture of" | cut them | Email on Acid (2023) |
| Punctuation inside longer alt text | keep it, screen readers use it to pause | Mailchimp, Email on Acid |
| `title` alongside `alt` | avoid | Mailchimp, Email on Acid (2023) |

Decorative images are a place the sources disagree, and the disagreement matters because the two answers produce opposite output for a screen reader. W3C's WAI images tutorial says a decorative image takes a null alt attribute, `alt=""`, so assistive technology ignores it, and says a description on such an image adds audible clutter or distracts. It also warns against dropping the attribute entirely, since some screen readers then announce the file name. Email on Acid agrees and recommends `alt=""`. Litmus says to leave alt text blank for decorative images. Mailchimp is the outlier: it tells you to state that the image is decorative, giving "Decorative image" as the sample value.

Follow W3C. It is the accessibility standard the other pages are approximating, three of the four sources point the same way, and a reader who hears "Decorative image" read aloud has been given nothing. An earlier version of this file followed Mailchimp here, which was wrong.

On the `title` attribute, the two sources describe different failures and both argue for the same action. Mailchimp says that on a linked image the title displays instead of the alt text. Email on Acid says a screen reader can read title and alt back to back, which confuses the listener. Set alt and leave title alone.

Image blocking is where the sourcing is oldest, so treat it as direction rather than as a current support matrix. Litmus's image blocking guide, published 2017 and last updated 2021, states that the biggest culprits today are the Outlook desktop clients, with AOL webmail the one webmail exception, and that neither Gmail nor Apple Mail blocks by default. Email on Acid, writing in 2023, names AOL Mail, Outlook, and Office 365. Litmus also records that Outlook 2007 through 2019 and desktop Office 365 render alt text after a warning message, and not styled, which is a second reason to keep descriptions short. Both pages predate 2024, so if a specific client's behavior is load-bearing for a build, check it rather than citing this file.

Live HTML beats alt text either way. Litmus's stated position is that the most accessible email is coded in live HTML: no text baked into graphics, buttons and headings as text, images used for images. Text can be read aloud, resized, and searched, and it weighs less than the markup around an image, so it helps with clipping at the same time. Litmus adds one small rule worth keeping: never tell the reader to download images, because anyone using a screen reader is being excluded by that sentence.

## Plain text

| Thing | Guidance |
| --- | --- |
| Plain text version | always written, never autogenerated |
| Link handling | full URLs written out, since there is no anchor text |
| Structure | keep the headings and the single call to action |

No figures here, by design. This is craft rather than a rendering limit, and nothing in the sources below puts a number on it.

## Sources

Every page below was opened and read. Dates are as the page shows them.

- Litmus, The Anatomy of a Good Email, July 5 2026: https://www.litmus.com/blog/the-anatomy-of-a-good-email
- Litmus, The Ultimate Guide to Email Preview Text, November 8 2024: https://www.litmus.com/blog/the-ultimate-guide-to-preview-text-support
- Litmus, How to Keep Gmail from Clipping Your Emails, February 29 2024: https://www.litmus.com/blog/how-to-keep-gmail-from-clipping-your-emails
- Litmus, 18 Subject Line Tips from Experts, published December 2012, updated June 17 2021: https://www.litmus.com/blog/how-to-write-the-perfect-subject-line-infographic
- Litmus, The Ultimate Guide to Email Image Blocking, published October 3 2017, updated August 17 2021: https://www.litmus.com/blog/the-ultimate-guide-to-email-image-blocking
- Litmus, 7 Myths of Email Development, October 25 2016: https://www.litmus.com/blog/7-myths-of-email-development
- Campaign Monitor, How to Optimize Your Email Subject Line Length, December 2 2021: https://www.campaignmonitor.com/blog/email-marketing/best-email-subject-line-length/
- Mailchimp, Best Practices for Email Subject Lines, undated: https://mailchimp.com/help/best-practices-for-email-subject-lines/
- Mailchimp, Gmail is clipping my email, undated: https://mailchimp.com/help/gmail-is-clipping-my-email/
- Mailchimp, Add Alt Text to Images, undated: https://mailchimp.com/help/add-alt-text-to-images/
- Email on Acid, Gmail Email Clipping and How to Avoid It, July 16 2021: https://www.emailonacid.com/blog/article/email-development/gmail-email-clipping/
- Email on Acid, The Gmail App Cuts Off My Emails, June 11 2014: https://www.emailonacid.com/blog/article/email-development/gmail-ios-app-email-clipping/
- Email on Acid, How to Write Alt Text for Better Accessibility in Emails, September 19 2023: https://www.emailonacid.com/blog/article/email-development/write-alt-text/
- W3C WAI, Images Tutorial, Decorative Images, updated July 27 2019: https://www.w3.org/WAI/tutorials/images/decorative/

Four of these pages carry their publisher's own staleness notice, and two of the Mailchimp help pages carry no date at all. Where a figure comes from a page older than about two years, this file says so next to the figure rather than in a footnote.

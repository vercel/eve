# Brand context template

## Skeleton

```markdown
# Brand context

## What the product is

[Two or three plain sentences: what it does, what it replaces. No category jargon.]

## Who it's for

Primary: [segment, specific enough to predict a problem and a buyer]
Also: [secondary segments, named as secondary]
Not for: [who should not buy, and why]

## Positioning

Real alternative: [what they'd do instead]
Differentiators:
- [claim]. Proof: [proof]. Grade: [proven | plausible | assumption]
- [claim]. Proof: [proof]. Grade: [grade]

## Messaging

Core message: [one sentence, repeatable after one read]
Pillars:
1. [benefit]. Mechanism: [mechanism]. Proof: [proof]. Grade: [grade]
2. [...]
3. [...]

## Voice

[Two or three sentences on how the team writes.]
Sounds like: [link or short quote from their own writing]
Never: [banned phrases, legal constraints, claims we can't support]

## Open questions

- [what isn't settled]. Would be settled by: [what would settle it]
```

The grades are load-bearing. Every specialist states whatever this document says, so an ungraded claim gets asserted flatly. `proven` means you could show a skeptic. `plausible` follows from how the product works. `assumption` is belief.

## Worked example

Illustrative, for shape and length rather than content.

```markdown
# Brand context

## What the product is

Ledger-native close software. Finance teams use it to close the books each month without exporting
anything to a spreadsheet, and without buying an ERP.

## Who it's for

Primary: Series B companies where one accountant runs the close, no ERP, closing in spreadsheets.
Also: Series A companies anticipating the same problem, though they buy later and churn more.
Not for: companies already on NetSuite, where this duplicates work they've paid for.

## Positioning

Real alternative: a shared spreadsheet plus a Slack channel. Rarely another product.
Differentiators:
- Reads the ledger over API, so there is no CSV step. Proof: one customer went from 9 days to 2.
  Grade: proven
- One accountant can run it, because rules are plain language not scripts. Proof: three customers
  run it with no finance engineer. Grade: plausible
- Auditors accept the trail, since adjustments keep their source record. Proof: one audit in
  progress. Grade: assumption

## Messaging

Core message: Close the books in two days without an ERP.
Pillars:
1. No CSV step. Reads the ledger directly. Proof: 9 days to 2 at one customer. Grade: proven
2. One person can run it. Plain-language rules. Proof: three customers, no engineer. Grade: plausible
3. Audit-ready trail. Adjustments keep their source. Proof: audit in progress. Grade: assumption

## Voice

Direct and specific, the way a good accountant writes. Numbers over adjectives. We say what breaks.
No "enterprise-grade", no "seamless", no exclamation points.
Sounds like: the changelog at /changelog, and the "How close actually works" post.
Never: claim SOC 2 before the audit closes. Never compare to [Competitor] on price.

## Open questions

- Primary segment not fully settled: the last six customers split between Series A and B. Six more
  months of cohort retention would decide it.
- Whether the audit-trail claim holds. The in-progress audit resolves it either way.
```

## What this example does deliberately

- Names a non-competitor as the real alternative, because that's usually the truth.
- Grades one pillar as an assumption instead of dropping it or asserting it.
- Includes a "Not for" line, which is what makes the segment real.
- Puts a genuine constraint in the voice section (`Never: claim SOC 2...`), which saves a review cycle every time someone writes about security.
- Leaves the segment question open rather than picking one to look finished.
- Fits on a page. Every specialist loads this on every task.

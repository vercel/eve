# Messaging formats

## Message hierarchy

```text
Core message
  [One sentence: what it does, for whom. Repeatable after one read.]

Pillar 1: [benefit, in the customer's terms]
  Mechanism: [why it's true, in one line]
  Proof:     [customer, number, or doc]
  Grade:     proven | plausible | assumption

Pillar 2: [...]
Pillar 3: [...]
```

Grades are not decoration. `proven` needs something external you could show a skeptic. `plausible` follows from the architecture but nothing confirms it. `assumption` is belief. Anything ungraded gets treated as proven by whoever reads this next, which is how unsupported claims reach production.

## Value proposition per audience

One block per audience. Stop at three or four audiences; past that the set stops being usable and starts being a filing system.

```text
Audience: [role, and the situation they're in]
Accountable for: [what they're measured on]
Today they: [the current workaround and what it costs them]
Lead with: [which pillar, and why this one]
In their words: [a phrase lifted from an interview or review, quoted]
Objection: [the one they raise first]
Do not say: [the phrasing that misfires with this audience]
```

The "in their words" line is the highest-value row and the one most often left blank. Internal language and customer language diverge fast, and the customer's version converts better.

## Objection handling

```text
Objection: "[what they actually say]"
Underneath: [the real concern, which is usually risk, effort, or credibility]
Response:   [the honest answer]
Proof:      [what backs the answer, or "none yet"]
```

Three underlying concerns cover most objections. Risk: what happens if this fails. Effort: how much work is this for me. Credibility: why should I believe you. Answering the surface question without the concern underneath rarely lands.

Keep the objections where the answer is "you're right, don't buy". Those define the segment, and they are the ones that make the rest believable.

## Words to use and avoid

```text
Use:      [terms customers use, the category term they search, the verbs from interviews]
Avoid:    [internal jargon, invented category names, the competitor's framing]
Never:    [claims we can't support, comparisons we won't make, phrases legal has excluded]
```

The `Never` row is the one that pays for the document. It's cheaper to write "we don't claim SOC 2 until the audit closes" once than to catch it in review five times.

## A worked example

Illustrative, for shape rather than content.

```text
Core message
  Close the books in two days without an ERP.

Pillar 1: No CSV step
  Mechanism: Reads the ledger over API, so there's no export or reconcile.
  Proof:     Named customer cut close from 9 days to 2.
  Grade:     proven

Pillar 2: One accountant can run it
  Mechanism: Rules are written in plain language, not scripts.
  Proof:     Three customers run it with no finance engineer.
  Grade:     plausible

Pillar 3: Auditors accept the trail
  Mechanism: Every adjustment keeps its source record.
  Proof:     None yet, one audit in progress.
  Grade:     assumption

Audience: Head of Finance at a Series B company
Accountable for: closing on time, clean audits
Today they: run close in spreadsheets with one accountant and a Slack channel
Lead with: Pillar 1, because the CSV step is where their time goes
In their words: "I spend the first week of every month chasing exports"
Objection: "We'll move to an ERP next year anyway"
Do not say: "enterprise-grade", which signals a price they don't want to hear

Objection: "We'll move to an ERP next year anyway"
Underneath: effort, they don't want to implement twice
Response:   Most customers keep this alongside the ERP for close specifically; the export path stays.
Proof:      Two customers running both. Grade: plausible.

Never: claim SOC 2 before the audit closes; compare to [Competitor] on price
```

Note what the example does that a weak set doesn't: it grades one pillar as an assumption rather than dropping it, keeps an objection it can only partly answer, and records a phrase in the customer's words rather than the company's.

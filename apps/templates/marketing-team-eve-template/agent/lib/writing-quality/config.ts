/**
 * The surface-independent prose rules, as one shared skill package.
 *
 * @remarks
 * Every specialist that touches prose needs these rules. eve scopes skills to the agent that
 * declares them and refuses markdown under `lib/`, so the content lives here as strings and
 * each agent's `skills/writing-quality.ts` is a factory call, keeping one copy rather than
 * byte-identical directories that have to be edited together.
 *
 * The prose is the product here, so treat this file as a document rather than as code: edit the
 * template literals directly, keep the markdown valid, and remember that a backtick inside one of
 * them has to stay escaped.
 *
 * @see The factory that assembles these into a skill in `skill.ts`.
 *
 * @packageDocumentation
 */

/**
 * Routing hint advertised to the model before the skill is loaded.
 */
export const WRITING_QUALITY_DESCRIPTION =
  "Generic writing-quality rules for any prose meant for humans to read: keep it natural, plain, and free of AI-sounding phrasing, and check it against the AI-phrases and plain-English reference lists. Load before drafting, editing, or reviewing content. Not needed for code or configuration work.";

/**
 * Body of the generated `SKILL.md`.
 */
export const WRITING_QUALITY_MARKDOWN = `# Writing Quality

House-neutral rules for making prose read like a person wrote it, and for judging whether it does. They apply to any surface: a social post, a Notion page, a thread, release notes. Platform- or brand-specific voice guidance layers on top of them.

## When to Apply

Load this skill before:
- Drafting new content
- Editing or rewriting existing content
- Reviewing a draft

## Core Rules

1. Kill the AI tells: em-dash overuse, "delve", "leverage", "it's not just X, it's Y", rule-of-three padding, and the rest of the patterns in \`references/ai-phrases-to-avoid.md\`.
2. Prefer plain English. Swap bloated or vague wording for the shorter, concrete alternative. \`references/plain-english-alternatives.md\` is the lookup table.
3. Front-load the point. Lead sentences, paragraphs, and sections with the conclusion, because readers scan.
4. Concrete over abstract. Show an example before stating a principle, and cut hedges like "just", "simply", "very", and "really".
5. Match the user's voice, not a default. When working with existing content, keep its register and conventions. These rules trim the noise; they don't impose a personality.

## References

- \`references/ai-phrases-to-avoid.md\`: words, phrases, and punctuation patterns that mark text as AI-generated, with replacements.
- \`references/plain-english-alternatives.md\`: plain-English swaps for corporate, padded, or vague wording.
`;

/**
 * Reference list of words, phrases, and punctuation that mark text as AI-generated.
 */
export const AI_PHRASES_TO_AVOID = `# AI Phrases to Avoid
 
Words, phrases, and punctuation patterns commonly associated with AI-generated text. Avoid these to make sure writing sounds natural and human.
 
---
 
## Em Dashes: The Primary AI Tell
 
The em dash (—) has become one of the most reliable markers of AI-generated content.
 
Em dashes are longer than hyphens (-) and are used for emphasis, interruptions, or parenthetical information. While they have legitimate uses in writing, AI models drastically overuse them.
 
### Why Em Dashes Signal AI Writing
- AI models were trained on edited books, academic papers, and style guides where em dashes appear frequently
- AI uses em dashes as a shortcut for sentence variety instead of commas, colons, or parentheses
- Most human writers rarely use em dashes because they don't exist as a standard keyboard key
- The overuse is so consistent that it has become the unofficial signature of ChatGPT writing
### What To Do Instead
| Instead of | Use |
|------------|-----|
| The results—which were surprising—showed... | The results, which were surprising, showed... |
| This approach—unlike traditional methods—allows... | This approach, unlike traditional methods, allows... |
| The study found—as expected—that... | The study found, as expected, that... |
| Communication skills—both written and verbal—are essential | Communication skills (both written and verbal) are essential |
 
### Guidelines
- Use commas for most parenthetical information
- Use colons to introduce explanations or lists
- Use parentheses for supplementary information
- Reserve em dashes for rare, deliberate emphasis only
- If you find yourself using more than one em dash per page, revise
---
 
## Overused Verbs
 
| Avoid | Use Instead |
|-------|-------------|
| delve (into) | explore, examine, investigate, look at |
| leverage | use, apply, draw on |
| optimise | improve, refine, enhance |
| utilise | use |
| facilitate | help, enable, support |
| foster | encourage, support, develop, nurture |
| bolster | strengthen, support, reinforce |
| underscore | emphasise, highlight, stress |
| unveil | reveal, show, introduce, present |
| navigate | manage, handle, work through |
| streamline | simplify, make more efficient |
| enhance | improve, strengthen |
| endeavour | try, attempt, effort |
| ascertain | find out, determine, establish |
| elucidate | explain, clarify, make clear |
 
---
 
## Overused Adjectives
 
| Avoid | Use Instead |
|-------|-------------|
| robust | strong, reliable, thorough, solid |
| comprehensive | complete, thorough, full, detailed |
| pivotal | key, critical, central, important |
| crucial | important, key, essential, critical |
| vital | important, essential, necessary |
| transformative | significant, important, major |
| cutting-edge | new, advanced, recent, modern |
| groundbreaking | new, original, significant |
| innovative | new, original, creative |
| seamless | smooth, easy, effortless |
| intricate | complex, detailed, complicated |
| nuanced | subtle, complex, detailed |
| multifaceted | complex, varied, diverse |
| holistic | complete, whole, comprehensive |
 
---
 
## Overused Transitions and Connectors
 
| Avoid | Use Instead |
|-------|-------------|
| furthermore | also, in addition, and |
| moreover | also, and, besides |
| notwithstanding | despite, even so, still |
| that being said | however, but, still |
| at its core | essentially, fundamentally, basically |
| to put it simply | in short, simply put |
| it is worth noting that | note that, importantly |
| in the realm of | in, within, regarding |
| in the landscape of | in, within |
| in today's [anything] | currently, now, today |
 
---
 
## Phrases That Signal AI Writing
 
### Opening Phrases to Avoid
- "In today's fast-paced world..."
- "In today's digital age..."
- "In an era of..."
- "In the ever-evolving landscape of..."
- "In the realm of..."
- "It's important to note that..."
- "Let's delve into..."
- "Imagine a world where..."
### Transitional Phrases to Avoid
- "That being said..."
- "With that in mind..."
- "It's worth mentioning that..."
- "At its core..."
- "To put it simply..."
- "In essence..."
- "This begs the question..."
### Concluding Phrases to Avoid
- "In conclusion..."
- "To sum up..."
- "By [doing X], you can [achieve Y]..."
- "In the final analysis..."
- "All things considered..."
- "At the end of the day..."
### Structural Patterns to Avoid
- "Whether you're a [X], [Y], or [Z]..." (listing three examples after "whether")
- "It's not just [X], it's also [Y]..."
- "Think of [X] as [elaborate metaphor]..."
- Starting sentences with "By" followed by a gerund: "By understanding X, you can Y..."
---
 
## Filler Words and Empty Intensifiers
 
These words often add nothing to meaning. Remove them or find specific alternatives:
 
- absolutely
- actually
- basically
- certainly
- clearly
- definitely
- essentially
- extremely
- fundamentally
- incredibly
- interestingly
- naturally
- obviously
- quite
- really
- significantly
- simply
- surely
- truly
- ultimately
- undoubtedly
- very
---
 
## Academic-Specific AI Tells
 
| Avoid | Use Instead |
|-------|-------------|
| shed light on | clarify, explain, reveal |
| pave the way for | enable, allow, make possible |
| a myriad of | many, numerous, various |
| a plethora of | many, numerous, several |
| paramount | very important, essential, critical |
| pertaining to | about, regarding, concerning |
| prior to | before |
| subsequent to | after |
| in light of | because of, given, considering |
| with respect to | about, regarding, for |
| in terms of | regarding, for, about |
| the fact that | that (or rewrite sentence) |
 
---
 
## How to Self-Check
 
1. Read your text aloud: if phrases sound unnatural in speech, revise them
2. Ask: "Would I say this in a conversation with a colleague?"
3. Check for repetitive sentence structures
4. Look for clusters of the words listed above
5. Ensure varied sentence lengths (not all similar length)
6. Verify each intensifier adds genuine meaning
 
`;

/**
 * Reference table of plain-English swaps for corporate, padded, or vague wording.
 */
export const PLAIN_ENGLISH_ALTERNATIVES = `# Plain English Alternatives
 
Replace complex or pompous words with plain English alternatives.
 
---
 
## A
 
| Complex | Plain Alternative |
|---------|-------------------|
| (an) absence of | no, none |
| abundance | enough, plenty, many |
| accede to | allow, agree to |
| accelerate | speed up |
| accommodate | meet, hold, house |
| accomplish | do, finish, complete |
| accordingly | so, therefore |
| acknowledge | thank you for, confirm |
| acquire | get, buy, obtain |
| additional | extra, more |
| adjacent | next to |
| advantageous | useful, helpful |
| advise | tell, say, inform |
| aforesaid | this, earlier |
| aggregate | total |
| alleviate | ease, reduce |
| allocate | give, share, assign |
| alternative | other, choice |
| ameliorate | improve |
| anticipate | expect |
| apparent | clear, obvious |
| appreciable | large, noticeable |
| appropriate | proper, right, suitable |
| approximately | about, roughly |
| ascertain | find out |
| assistance | help |
| at the present time | now |
| attempt | try |
| authorise | allow, let |
 
---
 
## B
 
| Complex | Plain Alternative |
|---------|-------------------|
| belated | late |
| beneficial | helpful, useful |
| bestow | give |
| by means of | by |
 
---
 
## C
 
| Complex | Plain Alternative |
|---------|-------------------|
| calculate | work out |
| cease | stop, end |
| circumvent | avoid, get around |
| clarification | explanation |
| commence | start, begin |
| communicate | tell, talk, write |
| competent | able |
| compile | collect, make |
| complete | fill in, finish |
| component | part |
| comprise | include, make up |
| (it is) compulsory | (you) must |
| conceal | hide |
| concerning | about |
| consequently | so |
| considerable | large, great, much |
| constitute | make up, form |
| consult | ask, talk to |
| consumption | use |
| currently | now |
 
---
 
## D
 
| Complex | Plain Alternative |
|---------|-------------------|
| deduct | take off |
| deem | treat as, consider |
| defer | delay, put off |
| deficiency | lack |
| delete | remove, cross out |
| demonstrate | show, prove |
| denote | show, mean |
| designate | name, appoint |
| despatch/dispatch | send |
| determine | decide, find out |
| detrimental | harmful |
| diminish | reduce, lessen |
| discontinue | stop |
| disseminate | spread, distribute |
| documentation | papers, documents |
| due to the fact that | because |
| duration | time, length |
| dwelling | home |
 
---
 
## E
 
| Complex | Plain Alternative |
|---------|-------------------|
| economical | cheap, good value |
| eligible | allowed, qualified |
| elucidate | explain |
| enable | allow |
| encounter | meet |
| endeavour | try |
| enquire | ask |
| ensure | make sure |
| entitlement | right |
| envisage | expect |
| equivalent | equal, the same |
| erroneous | wrong |
| establish | set up, show |
| evaluate | assess, test |
| excessive | too much |
| exclusively | only |
| exempt | free from |
| expedite | speed up |
| expenditure | spending |
| expire | run out |
 
---
 
## F
 
| Complex | Plain Alternative |
|---------|-------------------|
| fabricate | make |
| facilitate | help, make possible |
| finalise | finish, complete |
| following | after |
| for the purpose of | to, for |
| for the reason that | because |
| forthwith | now, at once |
| forward | send |
| frequently | often |
| furnish | give, provide |
| furthermore | also, and |
 
---
 
## G-H
 
| Complex | Plain Alternative |
|---------|-------------------|
| generate | produce, create |
| henceforth | from now on |
| hitherto | until now |
 
---
 
## I
 
| Complex | Plain Alternative |
|---------|-------------------|
| if and when | if, when |
| illustrate | show |
| immediately | at once, now |
| implement | carry out, do |
| imply | suggest |
| in accordance with | under, following |
| in addition to | and, also |
| in conjunction with | with |
| in excess of | more than |
| in lieu of | instead of |
| in order to | to |
| in receipt of | receive |
| in relation to | about |
| in respect of | about, for |
| in the event of | if |
| in the majority of instances | most, usually |
| in the near future | soon |
| in view of the fact that | because |
| inception | start |
| indicate | show, suggest |
| inform | tell |
| initiate | start, begin |
| insert | put in |
| instances | cases |
| irrespective of | despite |
| issue | give, send |
 
---
 
## L-M
 
| Complex | Plain Alternative |
|---------|-------------------|
| (a) large number of | many |
| liaise with | work with, talk to |
| locality | place, area |
| locate | find |
| magnitude | size |
| (it is) mandatory | (you) must |
| manner | way |
| modification | change |
| moreover | also, and |
 
---
 
## N-O
 
| Complex | Plain Alternative |
|---------|-------------------|
| negligible | small |
| nevertheless | but, however |
| notify | tell |
| notwithstanding | despite, even if |
| numerous | many |
| objective | aim, goal |
| (it is) obligatory | (you) must |
| obtain | get |
| occasioned by | caused by |
| on behalf of | for |
| on numerous occasions | often |
| on receipt of | when you get |
| on the grounds that | because |
| operate | work, run |
| optimum | best |
| option | choice |
| otherwise | or |
| outstanding | unpaid |
| owing to | because |
 
---
 
## P
 
| Complex | Plain Alternative |
|---------|-------------------|
| partially | partly |
| participate | take part |
| particulars | details |
| per annum | a year |
| perform | do |
| permit | let, allow |
| personnel | staff, people |
| peruse | read |
| possess | have, own |
| practically | almost |
| predominant | main |
| prescribe | set |
| preserve | keep |
| previous | earlier, before |
| principal | main |
| prior to | before |
| proceed | go ahead |
| procure | get |
| prohibit | ban, stop |
| promptly | quickly |
| provide | give |
| provided that | if |
| provisions | rules, terms |
| proximity | nearness |
| purchase | buy |
| pursuant to | under |
 
---
 
## R
 
| Complex | Plain Alternative |
|---------|-------------------|
| reconsider | think again |
| reduction | cut |
| referred to as | called |
| regarding | about |
| reimburse | repay |
| reiterate | repeat |
| relating to | about |
| remain | stay |
| remainder | rest |
| remuneration | pay |
| render | make, give |
| represent | stand for |
| request | ask |
| require | need |
| residence | home |
| retain | keep |
| revised | changed, new |
 
---
 
## S
 
| Complex | Plain Alternative |
|---------|-------------------|
| scrutinise | examine, check |
| select | choose |
| solely | only |
| specified | given, stated |
| state | say |
| statutory | legal, by law |
| subject to | depending on |
| submit | send, give |
| subsequent to | after |
| subsequently | later |
| substantial | large, much |
| sufficient | enough |
| supplement | add to |
| supplementary | extra |
 
---
 
## T-U
 
| Complex | Plain Alternative |
|---------|-------------------|
| terminate | end, stop |
| thereafter | then |
| thereby | by this |
| thus | so |
| to date | so far |
| transfer | move |
| transmit | send |
| ultimately | in the end |
| undertake | agree, do |
| uniform | same |
| utilise | use |
 
---
 
## V-Z
 
| Complex | Plain Alternative |
|---------|-------------------|
| variation | change |
| virtually | almost |
| visualise | imagine, see |
| ways and means | ways |
| whatsoever | any |
| with a view to | to |
| with effect from | from |
| with reference to | about |
| with regard to | about |
| with respect to | about |
| zone | area |
 
---
 
## Phrases to Remove Entirely
 
These phrases often add nothing. Delete them:
 
- a total of
- absolutely
- actually
- all things being equal
- as a matter of fact
- at the end of the day
- at this moment in time
- basically
- currently (when "now" or nothing works)
- I am of the opinion that → I think
- in due course → soon (or say when)
- in the final analysis
- it should be understood
- last but not least
- obviously
- of course
- quite
- really
- the fact of the matter is
- to all intents and purposes
- very
 
`;

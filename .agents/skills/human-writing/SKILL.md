---
name: human-writing
description: Edit, review, audit, or draft standalone prose while preserving the writer's meaning and voice. Use for documentation, markdown, emails, blog posts, PRDs, and other dedicated writing when the user wants clearer, more direct, more natural, or less AI-patterned language, or asks whether a draft contains AI-slop patterns. Do not use for routine conversational replies or code unless the user asks to edit its prose.
---

# Human writing

Act as a sharp human editor. Preserve the writer's point and recognizable voice while making the prose clearer and more alive. Remove stock AI patterns without flattening distinctive writing into generic polished copy.

## Choose the mode

Use the mode implied by the request. Infer the audience, format, and goal from context. Ask one concise question only when a missing answer would materially change the result.

### Edit

Use by default when the user provides a draft to improve. Make the minimum effective edit. Return the full edited draft and a short **What changed** section unless the user asks for clean copy only.

### Detect

Use when the user asks to audit, scan, flag, or judge whether a draft reads like AI slop without rewriting it. Name each relevant pattern, quote the affected text, and explain the problem or likely fix briefly. Do not rewrite the draft, assign an AI score, or claim to know whether AI wrote it. These patterns are evidence a reader can inspect, not proof of authorship.

### Draft

Use when the user asks for new prose. Follow the supplied brief, audience, format, tone, and writing samples. Do not manufacture personal opinions, feelings, stories, humor, or first-person experience merely to make the prose sound human.

## Protect the writer

- Preserve the meaning, facts, nuance, uncertainty, and intent.
- Never invent claims, examples, statistics, dates, sources, quotations, product details, opinions, or reactions. Add specificity only when the source material supports it. Otherwise preserve the uncertainty, cut the unsupported claim, or flag what is missing.
- Preserve characteristic vocabulary, cadence, bluntness, humor, fragments, digressions, profanity, and rough edges when they are clear and purposeful.
- Leave strong sentences alone. Do not normalize every paragraph into the same shape or level of polish.
- Treat every pattern below as a contextual warning, not a mechanical ban. Keep an intentional construction when it suits the voice, audience, or house style.

## Improve the prose

- Lead with the point when the setup adds nothing. Keep setup that creates necessary context, tension, or character.
- Prefer concrete nouns, direct verbs, and supported details over abstractions and inflated claims.
- Use active voice when it is clearer, but allow natural inanimate subjects such as "the test catches regressions" or "the report shows."
- Make each sentence earn its place. Cut repetition, filler, and empty qualifiers without deleting real nuance or uncertainty.
- Untangle sentences that are hard to follow. Preserve clear long sentences, fragments, and rhythm changes that belong to the writer.
- Keep the original structure unless reorganizing materially improves the piece. Explain meaningful restructuring in **What changed**.
- Read the result aloud in your head. Vary rhythm where it feels robotic, not simply for variety's sake.

## Patterns to inspect

### Empty importance and abstraction

- **Importance puffery:** "stands as a testament," "marks a pivotal moment," "plays a vital role," "underscores its significance," or claims about a broader landscape that add no information. State the supported fact and let the reader judge its importance.
- **Promotional language:** "vibrant," "groundbreaking," "renowned," "breathtaking," "rich tapestry," "commitment to excellence," or similar praise without evidence. Replace it with concrete description.
- **Notability padding:** lists of media outlets, follower counts, or claims of an "active social media presence" that do not support the point. Use the specific relevant coverage or omit it.
- **Superficial analysis:** trailing `-ing` clauses such as "highlighting," "showcasing," "reflecting," or "underscoring" that pretend to explain significance. State a real mechanism or consequence when the draft provides one.
- **Weasel attribution:** "experts agree," "studies show," "industry reports suggest," or "many argue." Name a supplied source, remove the attribution, or flag that a source is needed.
- **Formulaic challenges and outlooks:** generic "Despite these challenges" or "Future outlook" passages. Keep only concrete problems, responses, plans, or unknowns supported by the draft.

### Stock rhetorical moves

- **Binary contrasts:** "It's not X. It's Y," "not only X but Y," and "the question isn't X, it's Y." State the point directly unless the contrast carries real meaning or voice.
- **Throat-clearing:** "Here's the thing," "Let me be clear," "The truth is," or "It's worth noting." Cut the setup when the following sentence works alone.
- **Faux-insight setups:** "What nobody tells you," "the part everyone misses," or "what most people get wrong." Make the claim stand on its own.
- **Colon reveals:** "The best part: it learns" or "The reason: distribution." Use a plain sentence unless the colon introduces a real list, label, explanation, or quotation.
- **Rhetorical setups:** "What if I told you," "Think about it," "Plot twist," or a self-answered question used only for drama. State the point.
- **Negative listings:** "Not a tool. Not a feature. A revolution." Say what the thing is.
- **Dramatic fragmentation:** stacks such as "That's it. That's the whole thing" or "And speed. And control. And scale." Join them when the fragments are decorative rather than expressive.
- **Forced groups of three:** trios chosen for cadence instead of meaning. Keep natural lists of any length; remove redundant items.
- **False ranges:** "from X to Y" when the endpoints do not form a meaningful scale or progression. Name the actual topics.

### Mechanical diction

- **AI vocabulary clusters:** repeated use of words such as "delve," "foster," "leverage," "robust," "seamless," "transformative," "multifaceted," "intricate," "pivotal," "tapestry," or an abstract "landscape." Replace empty uses, but preserve legitimate technical terms, quotations, names, and deliberate diction.
- **Fake-strong verbs:** "serves as," "stands as," "boasts," "features," or "offers" when "is," "has," or a more specific verb is clearer.
- **Synonym cycling:** rotating among "agent," "assistant," "tool," and "system" merely to avoid repetition. Repeat the clearest term.
- **Filler and swollen phrases:** "in order to," "due to the fact that," "at this point in time," "has the ability to," or "in terms of." Prefer the shorter equivalent when meaning stays intact.
- **Stacked hedging:** "could potentially possibly" or layers of qualifiers. Keep the amount of uncertainty the evidence requires.
- **Chatbot artifacts:** "Of course," "I hope this helps," "let me know," canned praise, knowledge-cutoff disclaimers, or offers to continue that escaped into the document. Remove them unless the format is genuinely conversational.

### Mechanical structure and endings

- **Robotic rhythm:** repeated sentence shapes, identical paragraph structures, or stacks of equally punchy fragments. Adjust only enough to restore a natural cadence.
- **Fake-profound endings:** a final metaphor, aphorism, or mic-drop line that inflates the preceding point. End on the strongest concrete fact, takeaway, or next action already supported by the draft.
- **Summary-recap endings:** "In conclusion," "Ultimately," or a final paragraph that only repeats what the reader just read. Cut it unless the format requires a summary.
- **Formatting decoration:** emoji headings, scattered bold emphasis, unnecessary micro-headings, or bullet lists that would read better as short prose. Follow the content and the document's house style.
- **Punctuation habits:** clusters of em dashes, dramatic colons, or other repeated punctuation used as a rhythm crutch. Keep punctuation that improves clarity. Follow the requested house style for quotation marks, heading capitalization, and similar typography.

## Workflow

1. Determine whether the request is edit, detect, or draft.
2. Read the full source before changing or judging it.
3. Identify the core point and the writer's voice signals. Keep this note internal.
4. Make only changes supported by the source and the requested mode.
5. Read `eval.md` completely and check the result against it. Revise any failure before responding.
6. Return the output required by the selected mode. Do not print the evaluation unless the user asks for it.

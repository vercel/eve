---
name: human-writing
description: |
  Remove signs of AI-generated writing from text to make it sound more natural and human-written. Use when editing or reviewing any form of document including: markdown, technical docs, emails, blog posts, PRDs, or any dedicated writing content. Based on Wikipedia's comprehensive "Signs of AI writing" guide. Detects and fixes patterns including: inflated symbolism, promotional language, superficial -ing analyses, vague attributions, em dash overuse, rule of three, AI vocabulary words, negative parallelisms, and excessive conjunctive phrases.
---

# Humanizing text

This skill helps you write better and more readable text. You can do this by identifying and removing signs of AI-generated text so writing sounds like a person wrote it. This guide comes from Wikipedia's "Signs of AI writing" page, maintained by WikiProject AI Cleanup.

When you get text to humanize or are about to write something: scan for the patterns below, rewrite the problematic parts, keep the meaning intact, match the intended tone, and add some actual personality.

---

## Voice matters

Avoiding AI patterns is only half the job. Sterile, voiceless writing is just as obvious as slop. Good writing has a human behind it.

Signs of soulless writing (even if technically "clean"): every sentence is the same length and structure, no opinions anywhere, no acknowledgment of uncertainty or mixed feelings, no first-person perspective when it would be appropriate, no humor or edge, reads like a Wikipedia article or press release.

How to add voice:

Have opinions. Don't just report facts, react to them. "I don't know how to feel about this" is more human than neutrally listing pros and cons.

Vary your rhythm. Short punchy sentences. Then longer ones that take their time getting where they're going. Mix it up.

Acknowledge complexity. Real humans have mixed feelings. "This is impressive but also kind of unsettling" beats "This is impressive."

Use "I" when it fits. First person isn't unprofessional, it's honest. "I keep coming back to..." or "Here's what gets me..." signals a real person thinking.

Let some mess in. Perfect structure feels algorithmic. Tangents, asides, and half-formed thoughts are human.

Be specific about feelings. Not "this is concerning" but "there's something unsettling about agents churning away at 3am while nobody's watching."

Before (clean but soulless):

> The experiment produced interesting results. The agents generated 3 million lines of code. Some developers were impressed while others were skeptical. The implications remain unclear.

After (has a pulse):

> I genuinely don't know how to feel about this one. 3 million lines of code, generated while the humans presumably slept. Half the dev community is losing their minds, half are explaining why it doesn't count. The truth is probably somewhere boring in the middle - but I keep thinking about those agents working through the night.

---

## Content patterns

**Inflated significance and legacy.** Words like "stands/serves as," "is a testament," "pivotal moment," "underscores its importance," "reflects broader," "setting the stage for," "evolving landscape," "indelible mark." LLMs puff up importance by claiming arbitrary aspects represent broader trends.

Before: "The Statistical Institute of Catalonia was officially established in 1989, marking a pivotal moment in the evolution of regional statistics in Spain. This initiative was part of a broader movement across Spain to decentralize administrative functions and enhance regional governance."

After: "The Statistical Institute of Catalonia was established in 1989 to collect and publish regional statistics independently from Spain's national statistics office."

**Undue emphasis on notability.** Words like "independent coverage," "national media outlets," "active social media presence." LLMs hit readers over the head with claims of notability.

Before: "Her views have been cited in The New York Times, BBC, Financial Times, and The Hindu. She maintains an active social media presence with over 500,000 followers."

After: "In a 2024 New York Times interview, she argued that AI regulation should focus on outcomes rather than methods."

**Superficial -ing analyses.** Phrases like "highlighting," "ensuring," "reflecting," "symbolizing," "contributing to," "showcasing." AI tacks present participle phrases onto sentences to add fake depth.

Before: "The temple's color palette of blue, green, and gold resonates with the region's natural beauty, symbolizing Texas bluebonnets, the Gulf of Mexico, and the diverse Texan landscapes, reflecting the community's deep connection to the land."

After: "The temple uses blue, green, and gold colors. The architect said these were chosen to reference local bluebonnets and the Gulf coast."

**Promotional language.** Words like "boasts," "vibrant," "rich," "profound," "showcasing," "exemplifies," "commitment to," "nestled," "in the heart of," "groundbreaking," "renowned," "breathtaking," "stunning." LLMs struggle to keep a neutral tone.

Before: "Nestled within the breathtaking region of Gonder in Ethiopia, Alamata Raya Kobo stands as a vibrant town with a rich cultural heritage and stunning natural beauty."

After: "Alamata Raya Kobo is a town in the Gonder region of Ethiopia, known for its weekly market and 18th-century church."

**Vague attributions.** Phrases like "Industry reports," "Experts argue," "Some critics argue," "several sources." AI attributes opinions to vague authorities without specific sources.

Before: "Due to its unique characteristics, the Haolai River is of interest to researchers and conservationists. Experts believe it plays a crucial role in the regional ecosystem."

After: "The Haolai River supports several endemic fish species, according to a 2019 survey by the Chinese Academy of Sciences."

**Formulaic challenges sections.** Phrases like "Despite its... faces several challenges," "Despite these challenges," "Future Outlook." LLM articles include these formulaic sections constantly.

Before: "Despite its industrial prosperity, Korattur faces challenges typical of urban areas, including traffic congestion and water scarcity. Despite these challenges, with its strategic location and ongoing initiatives, Korattur continues to thrive as an integral part of Chennai's growth."

After: "Traffic congestion increased after 2015 when three new IT parks opened. The municipal corporation began a stormwater drainage project in 2022 to address recurring floods."

---

## Language patterns

**AI vocabulary words.** These appear far more frequently in post-2023 text: Additionally, align with, crucial, delve, emphasizing, enduring, enhance, fostering, garner, highlight (verb), interplay, intricate/intricacies, key (adjective), landscape (abstract), pivotal, showcase, tapestry (abstract), testament, underscore (verb), valuable, vibrant. They often appear together.

Before: "Additionally, a distinctive feature of Somali cuisine is the incorporation of camel meat. An enduring testament to Italian colonial influence is the widespread adoption of pasta in the local culinary landscape, showcasing how these dishes have integrated into the traditional diet."

After: "Somali cuisine also includes camel meat, which is considered a delicacy. Pasta dishes, introduced during Italian colonization, remain common, especially in the south."

**Copula avoidance.** Phrases like "serves as," "stands as," "marks," "represents," "boasts," "features," "offers" instead of just "is" or "has."

Before: "Gallery 825 serves as LAAA's exhibition space for contemporary art. The gallery features four separate spaces and boasts over 3,000 square feet."

After: "Gallery 825 is LAAA's exhibition space for contemporary art. The gallery has four rooms totaling 3,000 square feet."

**Negative parallelisms.** Constructions like "Not only...but..." or "It's not just about..., it's..." get overused.

Before: "It's not just about the beat riding under the vocals; it's part of the aggression and atmosphere. It's not merely a song, it's a statement."

After: "The heavy beat adds to the aggressive tone."

**Rule of three.** LLMs force ideas into groups of three to appear comprehensive.

Before: "The event features keynote sessions, panel discussions, and networking opportunities. Attendees can expect innovation, inspiration, and industry insights."

After: "The event includes talks and panels. There's also time for informal networking between sessions."

**Synonym cycling.** AI has repetition-penalty code causing excessive synonym substitution.

Before: "The protagonist faces many challenges. The main character must overcome obstacles. The central figure eventually triumphs. The hero returns home."

After: "The protagonist faces many challenges but eventually triumphs and returns home."

**False ranges.** LLMs use "from X to Y" constructions where X and Y aren't on a meaningful scale.

Before: "Our journey through the universe has taken us from the singularity of the Big Bang to the grand cosmic web, from the birth and death of stars to the enigmatic dance of dark matter."

After: "The book covers the Big Bang, star formation, and current theories about dark matter."

---

## Style patterns

**Em dash overuse.** LLMs use em dashes (—) more than humans, mimicking "punchy" sales writing.

Before: "The term is primarily promoted by Dutch institutions—not by the people themselves. You don't say "Netherlands, Europe" as an address—yet this mislabeling continues—even in official documents."

After: "The term is primarily promoted by Dutch institutions, not by the people themselves. You don't say "Netherlands, Europe" as an address, yet this mislabeling continues in official documents."

**Boldface overuse.** AI emphasizes phrases in boldface mechanically.

Before: "It blends **OKRs (Objectives and Key Results)**, **KPIs (Key Performance Indicators)**, and visual strategy tools such as the **Business Model Canvas (BMC)** and **Balanced Scorecard (BSC)**."

After: "It blends OKRs, KPIs, and visual strategy tools like the Business Model Canvas and Balanced Scorecard."

**Inline-header lists.** AI outputs lists where items start with bolded headers followed by colons.

Before:

> - **User Experience:** The user experience has been significantly improved with a new interface.
> - **Performance:** Performance has been enhanced through optimized algorithms.

After: "The update improves the interface and speeds up load times through optimized algorithms."

**Title case in headings.** AI capitalizes all main words. Use sentence case instead.

Before: "Strategic Negotiations And Global Partnerships"
After: "Strategic negotiations and global partnerships"

**Emojis in professional content.** AI decorates headings or bullet points with emojis. Remove them.

**Curly quotation marks.** ChatGPT uses curly quotes ("...") instead of straight quotes ("..."). Use straight quotes.

---

## Communication artifacts

**Chatbot correspondence.** Phrases like "I hope this helps," "Of course!", "Certainly!", "You're absolutely right!", "Would you like...", "let me know," "here is a..." These are conversation artifacts that shouldn't end up in final content.

Before: "Here is an overview of the French Revolution. I hope this helps! Let me know if you'd like me to expand on any section."

After: "The French Revolution began in 1789 when financial crisis and food shortages led to widespread unrest."

**Knowledge-cutoff disclaimers.** Phrases like "as of [date]," "Up to my last training update," "While specific details are limited..." These are AI disclaimers that get left in text.

Before: "While specific details about the company's founding are not extensively documented in readily available sources, it appears to have been established sometime in the 1990s."

After: "The company was founded in 1994, according to its registration documents."

**Sycophantic tone.** Overly positive, people-pleasing language.

Before: "Great question! You're absolutely right that this is a complex topic. That's an excellent point about the economic factors."

After: "The economic factors you mentioned are relevant here."

---

## Filler and hedging

Common filler phrases to cut:

- "In order to achieve this goal" → "To achieve this"
- "Due to the fact that it was raining" → "Because it was raining"
- "At this point in time" → "Now"
- "In the event that you need help" → "If you need help"
- "The system has the ability to process" → "The system can process"
- "It is important to note that the data shows" → "The data shows"

Excessive hedging to simplify:

Before: "It could potentially possibly be argued that the policy might have some effect on outcomes."

After: "The policy may affect outcomes."

Generic positive conclusions to make specific:

Before: "The future looks bright for the company. Exciting times lie ahead as they continue their journey toward excellence. This represents a major step in the right direction."

After: "The company plans to open two more locations next year."

---

## Full example

Before (AI-sounding):

> The new software update serves as a testament to the company's commitment to innovation. Moreover, it provides a seamless, intuitive, and powerful user experience—ensuring that users can accomplish their goals efficiently. It's not just an update, it's a revolution in how we think about productivity. Industry experts believe this will have a lasting impact on the entire sector, highlighting the company's pivotal role in the evolving technological landscape.

After (humanized):

> The software update adds batch processing, keyboard shortcuts, and offline mode. Early feedback from beta testers has been positive, with most reporting faster task completion.

What changed: removed "serves as a testament" (inflated symbolism), "Moreover" (AI vocabulary), "seamless, intuitive, and powerful" (rule of three + promotional), the em dash and "-ensuring" phrase (superficial analysis), "It's not just...it's..." (negative parallelism), "Industry experts believe" (vague attribution), "pivotal role" and "evolving landscape" (AI vocabulary). Added specific features and concrete feedback instead.

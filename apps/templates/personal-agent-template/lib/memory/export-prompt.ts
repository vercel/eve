export const MEMORY_EXPORT_PROMPT = `Export all of my stored memories and any context you've learned about me from past conversations. Preserve my words verbatim where possible, especially for instructions and preferences.

## Categories (output in this order):

1. **Work Context**: Current role, company, location, technical focus, and professional activities.

2. **Personal Context**: Location, preferences (dietary, communication style), habits, life context, family, relationships, languages, and personal interests.

3. **Active Focus**: What I'm currently working on, problems I'm solving, and decisions I'm making right now.

4. **Instructions & Preferences**: Rules I've explicitly asked you to follow — tone, format, style, "always do X", "never do Y", opinions, tastes, and working-style preferences. Only include rules from stored memories, not from conversations.

5. **Project History**: Projects I've meaningfully built or worked on, past and present. Include what each does, its status, and key decisions. Use the project name or a short descriptor as the first words of the entry.

## Format:

- Use section headers for each category.
- Write in flowing prose paragraphs, not bullet points.
- Within each section, organize chronologically when possible.
- Include any dates or timeframes you know.

## Output:

- Wrap the entire export in a single code block for easy copying.
- After the code block, state whether this is the complete set or if more remain.`;

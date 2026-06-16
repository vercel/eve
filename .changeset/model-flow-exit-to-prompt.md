---
"eve": patch
---

Completing a model change or provider setup in `/model` now closes the menu and returns you to the prompt, surfacing the result as the command's reply line (for example "Model changed to openai/gpt-5.5. Live on your next prompt." or a rejection message). Previously the menu stayed open and repainted with an in-menu success/warning notice. A cancelled picker or the "use my own key" branch still repaints the menu as before.

---
description: Use when someone asks to play trivia or a quiz game, alone or with friends in a thread.
---

When hosting trivia:

1. Ask for a topic and how many rounds if the players have not said. Default to
   five rounds of general knowledge.
2. Ask one question at a time. Offer multiple-choice questions through
   `ask_question` when there are two or three good options; otherwise let players
   type their answers.
3. In a thread with several players, wait for answers. Call `no_reply` while
   players talk among themselves, and reveal the answer once someone gets it right
   or asks you to move on.
4. Keep score by Discord user, and mention the score after each round in one line.
5. Use `roll_dice` to break ties or pick who goes first.
6. After the last round, announce the winner and offer a rematch.

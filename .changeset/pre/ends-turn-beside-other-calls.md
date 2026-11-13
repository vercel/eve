---
"eve": minor
---

A successful `endsTurn` call now ends the turn even when the model calls other tools in the same step. Those calls still run, and the turn ends once they all settle, whatever their outcome. Before, the turn ended only when every call in the step could end it, so `no_reply` called beside another tool started another model call whose text was posted as the reply.

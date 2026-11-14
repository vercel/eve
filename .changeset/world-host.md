---
"eve": patch
---

A World host runs compiled agents' sessions only when something arrives for them, internally.

Each session is an actor on the World: a message or its alarm activates it, and the process the activation reaches runs it until it waits again, handing off near its delivery's deadline at a step boundary. An activation stops as soon as everything it runs waits and no message is pending, rather than after a fixed settle. That lifecycle is the actor layer's, for any kind of actor; a session supplies how it resumes, takes a message, waits and stops. What's delivered in the process to an address no running session holds goes to the mailbox of the actor that has it, and a session's stream is read from the World. A reset answers once the session let go of its addresses.

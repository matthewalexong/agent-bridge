# Agent Bridge shopping target: user-visible research trails

The panel must show useful progress and preserve a compact audit history
without exposing hidden chain-of-thought.

The success contract is to:

1. publish a concrete plan before non-trivial shopping research begins;
2. publish new updates only at material search, inspection, verification,
   comparison, or decision milestones—not for every click or heartbeat;
3. represent each update as a bounded phase, concise summary, up to five
   supportable evidence facts, an optional next step, and a timestamp;
4. exclude generic “thinking” or “research in progress” placeholders from the
   durable trail;
5. bound, sanitize, and deduplicate progress so it cannot become an unbounded
   transcript or markup-injection surface;
6. show the current trail live in the transient working bubble;
7. attach the same safe updates automatically to the final answer as a
   collapsible research trail;
8. clear current progress after the answer and before the next user turn so
   evidence never leaks across requests;
9. retain the trail when a transient status is cleared before the final answer;
10. keep credentials, secrets, raw personal data, private scratch work,
    unsupported hypotheses, internal model messages, and hidden chain-of-
    thought out of every update;
11. keep the final answer concise rather than duplicating the trail; and
12. let Hermes or OpenClaw—not Gemma—choose material milestones, evidence, and
    conclusions.

Gemma may format bounded already-returned nonsensitive fields after the main
brain selects them. It cannot infer evidence, create conclusions, choose what
is safe to reveal, expose private reasoning, or control the research trail.

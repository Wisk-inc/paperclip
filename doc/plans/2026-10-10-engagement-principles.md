# Engagement principles for the Automa phone app

Date: 2026-10-10. Status: applied in 1.4.2; keep this page when touching the phone UI.

The ask was "make it addicting, appeal to the brain, predictable". Automa is a
tool people run their work through, so the target is *habit-forming because it
is dependable*, never tricks: no fake urgency, no infinite feeds, no streak
guilt. The principles below come from the literature on habit loops and
cognitive load; each one maps to something concrete in the app.

## What the research says

1. **Habit loop (trigger → action → reward → investment)** — Nir Eyal's Hook
   model. A habit forms when a clear trigger leads to an easy action with a
   satisfying, slightly variable reward, and the person invests something that
   makes the next loop more valuable.
2. **Make the action easy** — B. J. Fogg's behaviour model: behaviour happens
   when motivation, ability and a prompt meet. Raising ability (fewer steps,
   bigger targets, no surprises) beats raising motivation.
3. **Reduce cognitive load; one primary action per screen** — progressive
   disclosure (Nielsen): show the essentials first, details on request. Fewer
   competing elements mean faster, more confident decisions.
4. **Consistency and predictability** — the same menu in the same place, the
   same gesture meaning the same thing. Unpredictable UI is the fastest way to
   lose trust and the habit with it.
5. **Immediate, legible feedback** — every tap answers within 100 ms (haptic,
   state change), and completed work is celebrated in proportion.

Sources consulted: a summary of the Hook model and variable rewards
(whizzoe.substack.com, appcues.com), progressive disclosure and cognitive load
guides (uxcel.com, logrocket.com, thisisglance.com). The Hook model and
progressive disclosure are the primary ideas; the rest are practitioner
summaries.

## How Automa applies them

| Principle | In the app |
|---|---|
| Trigger | The bell counts only what arrived since you last looked; Home opens on "Needs you" with only the queues that actually have something. |
| Easy action | Bottom tab bar never hides while scrolling; menus open the same way everywhere; dialogs fit the screen; one tap to attach a file to the AI. |
| Reward | Mascot reacts (cheering when caught up, excited when something waits); haptic ticks on every action; success toasts say what happens next. |
| Investment | API keys, agents, skills and routines persist and compound: each one makes the next task cheaper to start. |
| Load | Skills show product logos and plain names, not slugs; Audit hides read receipts and raw codes by default; Studio takes the whole screen. |
| Predictability | The drawer is always the company menu; the tour explains every section once, with Skip; "Pick up where you left off" on Home. |
| Feedback | The brand mascot is a still with a float on phones (measured: the live character cost about a quarter of the idle main thread under a 4x CPU throttle); agents' characters run at 30 fps and pause while the page scrolls; blur removed from fixed bars. |

## What we deliberately do not do

- No streaks, countdowns, or manufactured scarcity.
- No notifications that are not about the person's own work.
- No hiding costs: Usage sits on Home.

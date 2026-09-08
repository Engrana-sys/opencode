# Goals, loops and system models

Three features this fork adds to ordinary sessions. All three are usable today.

## The problem they solve

A long coding session forgets what it is for. Compaction summarises the
conversation through a model, and each cycle folds the previous summary into the
next one — a photocopy of a photocopy. The objective drifts, and nobody notices
until the agent is confidently working on the wrong thing.

Durable todos had the mirror-image problem: they were written to SQLite and never
injected back, so after a compaction the model only knew whatever the summary
happened to keep.

Both are fixed the same way. Goals, loops and todos are **Context Sources**:
re-rendered verbatim from the database at the start of every Context Epoch. They
survive compaction word for word instead of being paraphrased, and a change to
any of them emits one mid-conversation system message.

## Goals

A goal is a **stopping condition**: the session keeps working until it holds.

At a real resting point — once no user input is pending — an evaluator reads the
recent transcript and decides whether the condition is met. If it is not, one
continuation is admitted and the session carries on.

Two properties matter:

- **The judge is not the model that did the work.** A model asked whether its
  own work is correct reliably says yes. The evaluator is configured separately,
  and a small fast model is enough.
- **A judge that cannot run stops the session.** If the evaluator's chain is
  unreachable, the session stops rather than looping blind. Burning a budget on
  a loop nobody is grading is worse than stopping early.

Every goal carries an iteration budget — 20 continuations by default. Reaching it
settles the goal as `exhausted`.

### Using it

Through the `goal` tool, in plain language:

> Work until `bun test` passes in packages/core.

Or explicitly: `goal` with `action: "set"` and a condition, `action: "show"` to
see the current one, `action: "clear"` to stop pursuing it.

**Write conditions that are checkable from the transcript.** "The tests pass" is
good — a test run appears in the transcript with its output. "The code is clean"
is not: the evaluator has nothing to look at, and will keep answering NOT_MET.

### Configuration

```jsonc
{
  "goal": {
    "budget": 20        // continuations before it gives up
  }
}
```

## Loops

A loop re-runs a prompt on a cadence. Use it for work driven by the clock —
polling a deploy, re-checking a build — and a goal when the session should stop
on proof rather than on a schedule. They are orthogonal and combine.

```
loop { action: "start", prompt: "check whether the deploy finished", intervalSeconds: 300 }
```

Omit `intervalSeconds` and the loop is **self-paced**: the model picks each delay
with the `loop_schedule` tool, based on what is actually happening. Delays are
clamped to between 60 seconds and one hour.

A loop is **durable state, not a held timer**. Kill the process halfway through a
five-minute interval, come back, and the next tick finds the iteration overdue
and runs it. Iterations are admitted to the queue rather than forced, so one
waits for whatever the session is already doing instead of interrupting it.

Default budget: 100 iterations. `loop` with `action: "stop"` ends it.

## System models

Some model calls are infrastructure rather than a user's choice: judging a goal,
classifying something, generating a title. When one of those cannot reach a
model, the feature it supports stops working.

So each such role takes an **ordered chain** rather than a single model:

```jsonc
{
  "system_models": {
    "goal_evaluator": [
      "mistral/codestral-latest",
      "anthropic/claude-haiku-4-5",
      "openai/gpt-5-mini"
    ]
  }
}
```

The runtime walks the chain until one answers. A model that is unavailable is
skipped; **so is one that answers with something unreadable** — an unusable
answer is that model's failure, not the chain's. If the whole chain is exhausted
the caller falls back to the session's own model, and only then gives up.

Put the cheapest adequate model first and a differently hosted one after it: two
models at the same provider go down together.

Roles are open — a chain can be configured for any key, and the runtime resolves
`goal_evaluator` itself today.

### One caveat worth stating

A fallback here is currently **logged, not recorded**. Inside a job, a model
substitution becomes a ledger event carrying what was requested, what ran, and
why. Outside one it is a warning in the log. Closing that gap is tracked in
[`../specs/v2/harness-plan.md`](../specs/v2/harness-plan.md) as phase 3 work.

## What is not built yet

`/goal` and `/loop` exist as **tools the model calls**, not as native slash
commands in the TUI. Asking for them in plain language works today; typing
`/goal` does not. Wiring the slash commands needs the SDK regenerated and is
tracked as phase 5.

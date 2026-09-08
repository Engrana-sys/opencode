# Fork documentation

This is a fork of [opencode](https://github.com/sst/opencode) that adds a durable
harness for long agentic work. Upstream's own documentation still applies to
everything else and lives in `packages/docs`; this directory documents only what
the fork adds.

## What the fork adds

Upstream opencode is organised around **sessions** — conversations with an agent.
The fork adds two things around that:

**Sessions that hold their objective.** Persistent goals with an independent
evaluator, durable loops, and context that survives compaction verbatim instead
of being paraphrased into vagueness. Usable today.

**Jobs: work that outlives the conversation.** A durable entity beside Session,
built on the event ledger opencode already had, with a scheduler, per-worker
worktrees, per-invocation model selection, crash recovery, budgets and a
deterministic verifier. The core is working; nothing creates jobs in a production
path yet.

The organising idea is one line:

> **Session ≠ Job ≠ Worker ≠ Attempt ≠ Model.**

A session converses. A job represents durable work. A worker executes a role.
An attempt records one try. A model is a replaceable dependency. Conflating any
two of them is what makes long agentic work unauditable.

## Documents

| Document | What it covers |
| --- | --- |
| [install-linux.md](./install-linux.md) | Building and running the fork from source on Debian and Arch/CachyOS, where it keeps state, how to verify the install and how to merge upstream |
| [goals-and-loops.md](./goals-and-loops.md) | Persistent goals, durable loops and system-model chains — the parts usable today |
| [jobs.md](./jobs.md) | The job subsystem: ledger, workers and attempts, scheduling, recovery, isolation, permissions and verification |

Design material, kept separate because it describes intent rather than
behaviour:

| Document | What it covers |
| --- | --- |
| [../specs/v2/harness.md](../specs/v2/harness.md) | Target architecture, what already exists in opencode, and the full backlog |
| [../specs/v2/harness-plan.md](../specs/v2/harness-plan.md) | Phased implementation plan, the nine invariants each phase is held to, and what each phase must prove |
| [../CONTEXT.md](../CONTEXT.md) | Upstream's session runtime vocabulary — Context Sources, Context Epochs, compaction |

## Reading order

Installing: [install-linux.md](./install-linux.md).

Using it: [goals-and-loops.md](./goals-and-loops.md) — that is what works end to
end today.

Working on the harness: [jobs.md](./jobs.md) first for the model, then
[harness-plan.md](../specs/v2/harness-plan.md) for the invariants. Those
invariants are not style preferences; each is written so a test can fail on it,
and several already do.

## Honest status

| Piece | State |
| --- | --- |
| Persistent goals, loops, compaction-proof context | Working |
| System-model chains with fallthrough | Working |
| Job aggregate, ledger, projections proved replayable | Working |
| Workers, attempts, per-invocation models | Working |
| Scheduler: rolling pool, admission limits, retry, budgets | Working |
| Crash recovery via leases | Working |
| Per-worker worktrees | Working |
| Capability clamping | Computed and stored; **not yet enforced inside a worker's session** |
| Deterministic verifier | Working |
| Attempts running as sessions | Working |
| Sandbox backends | Not started |
| Workflow engine, human gates | Not started |
| Jobs TUI and public API | Not started |
| Anything creating jobs in production | Not started |
| `/goal` and `/loop` as native slash commands | Not started — they work as tools the model calls |

Where a gap exists it is written into the module it affects, not only here.

## What has been independently reviewed

Worth stating plainly, because it is a property of the code that nothing else
records: **most of the harness was written in one session by one author, and its
tests were written by that same author.** Tests like that share the author's
blind spots — a passing suite proves the code does what its author believed it
should, which is a weaker claim than it looks.

| Area | Review state |
| --- | --- |
| `job/projector.ts` — the wall-clock start time | Reviewed independently; a defect was found and fixed |
| `job/projector.ts`, `job/store.ts` — the lease window | Reviewed independently; a defect was found and fixed |
| Everything else in the harness | **Not independently reviewed** |

Both fixed defects were the same shape: a comment describing an invariant the
code did not implement. The start time was re-stamped on every entry into
`running` though its comment said "first"; the lease was granted one durable
write after the status that required it. Neither showed up in the suite, because
the tests encoded the same assumption as the code.

A wider audit — seven areas, four lenses each, adversarially verified — is
planned but has not yet completed a run.

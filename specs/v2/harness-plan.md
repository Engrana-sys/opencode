# Harness Implementation Plan

Companion to `harness.md`. That document says what to build; this one says in
what order, under which invariants, and how each phase is proved before the
next one starts.

## Why this order

The dependency chain is real, not stylistic. Workers cannot be scheduled before
attempts exist to schedule; attempts cannot record a model before per-invocation
resolution exists; recovery cannot reclaim work before leases exist; a TUI
cannot show a tree that nothing writes. Each phase below unblocks the next, and
skipping ahead produces code that has to be rewritten once its foundation
arrives.

Two phases are ordered against instinct on purpose:

- **Phase 0 comes first even though it builds nothing.** Every phase after it
  changes shared machinery — the event bus, the runner loop, permissions. Without
  a regression net, the first sign that ordinary OpenCode broke will be a user
  noticing, and by then several phases will be built on the break.
- **Security comes before the TUI.** A visible harness is tempting to demo and
  hard to hold back. Confinement retrofitted after people are using it is
  confinement that never lands.

## Invariants

These hold from the first commit and are never traded for progress. Each is
written so a test can fail on it.

1. **The ledger is append-only.** Nothing updates or deletes a row in `event`.
   State lives in projections, which may be dropped and rebuilt at any time.
2. **Projections are replayable.** Every projection handler is idempotent or
   keyed by an identifier the event carries. Replaying an event twice produces
   the same rows.
3. **History is never overwritten.** A retried worker gains an attempt; it does
   not mutate the previous one. A terminal job stays terminal — re-running means
   a new job.
4. **Requested and resolved models are separate facts.** Both are persisted.
   Every divergence emits an event naming what was asked for, what ran, and why.
5. **Permissions intersect, never union.** A child's effective permissions are
   the intersection of its parent's effective set, its own request, and the
   workflow's grant. Widening requires explicit human approval.
6. **A worker writing to disk owns a worktree.** Read-only workers share the base
   checkout. Two writing workers never share a directory.
7. **Every live worker holds a lease.** A worker with no valid lease is not
   running, whatever its status column says. Recovery trusts the lease.
8. **Budgets are enforced, not advisory.** Exhausting a budget settles the work;
   it does not log and continue.
9. **Ordinary OpenCode keeps working.** Sessions without a job behave exactly as
   before at every phase boundary.

## Phase 0 — Regression net

**Deliverable.** Coverage over the paths the later phases disturb: the session
drain loop, event publication and projection, compaction and context epochs,
permission evaluation, tool settlement, model resolution.

**Why.** Every later phase edits `session/runner/llm.ts`, `event.ts` or the
permission engine. The suite is what makes those edits safe to attempt.

**Done when.** The suite passes on a clean checkout, and deliberately breaking
each invariant above fails at least one test. A net that passes when the code is
broken is not a net.

**Verify.** `bun test` in `packages/core`. Record the baseline: which tests fail
before any change, so a real regression is never mistaken for pre-existing noise.

## Phase 1 — Durable jobs

**Deliverable.** `Job`, `Step`, `Worker`, `Attempt`, `Artifact` as a durable
aggregate on the existing ledger, with projections, a store, and a service whose
writes are all events.

**Anchors.** `Event.define({ durable: { aggregate: "jobID" } })` in
`packages/schema/src/job-event.ts`; `events.project(...)` in
`packages/core/src/job/projector.ts`, following `session/projector.ts`.

**Risk — aggregate scope.** Jobs are global; most core services are
Location-scoped. `SessionLoopScheduler` already hit this: a Location node
depending on the unbound `SessionExecution` seam breaks graph compilation.
Decide once, here: **the job aggregate is global, and Location-scoped work is
reached through `LocationServiceMap.get(location)`.** Every later phase follows
that shape.

**Done when.** A job can be created, moved through its states, given workers and
attempts, and settled; dropping the five projection tables and replaying the
ledger reproduces them exactly.

**Verify.** Unit tests over transitions (legal ones succeed, illegal ones fail),
plus a replay test that truncates projections, replays, and diffs the result.

## Phase 2 — Background fleet *(in progress)*

**Deliverable.** A scheduler that runs workers in parallel under limits, with a
rolling pool, retry with backoff and jitter, timeouts, cancellation, heartbeats,
leases, and a startup recovery scan.

**Landed.** The deterministic halves, each pure and tested without a provider:
`job/retry.ts` (what is worth retrying and when), `job/recovery.ts` (reclaiming
work whose lease lapsed), `job/admission.ts` (which queued workers fit the
limits), `job/budget.ts` (whether a job may keep spending).

**Remaining.** The loop that joins them, and the executor that gives an attempt a
session, a model and its permissions. That half is not deterministic: it is where
the fleet meets the runner, and it needs decisions about how a worker obtains its
session and inherits permissions.

**Anchors.** `SessionRunCoordinator` already serialises per key and coalesces
wakeups. `EventSequenceTable.owner_id` already carries aggregate ownership — the
lease primitive exists. `SessionLoopScheduler` is the tick pattern.

**Risk — retry policy without a taxonomy.** Retrying everything burns budget on
permission denials; retrying nothing wastes a recoverable rate limit. `ExitReason`
and `Job.isRetryable` land in Phase 1 so this phase has something to branch on.

**Done when.** Four slots keep four workers busy — a finished worker's slot is
taken immediately, not at batch end. Killing the process mid-run leaves no
worker permanently `running`: the next start reclassifies expired leases.

**Verify.** A scheduler test with fake clocks asserting slot occupancy over time,
and a recovery test that writes a `running` worker with a lapsed lease and
asserts it is reclassified.

## Phase 3 — Model correctness

**Deliverable.** Model chosen per invocation, requested and resolved both
persisted, and every fallback recorded as ledger events.

**Anchors.** `SessionRunnerModel.resolveNamed` resolves one catalog model by
identity. `SessionSystemModel.attempt` walks a chain. `JobEvent.ModelResolved`
already carries `requested`, `resolved`, `fellBack` and `reason`.

**Known debt to settle here.** `system-model.ts` currently falls through its
chain and only logs. Within a job that becomes ledger events. The two rules are
reconcilable and the distinction is worth stating: **a fallback is permitted but
never silent.** Where policy forbids one, the attempt fails with
`model_unavailable` instead.

**Done when.** No code path reaches a model without recording which one, and a
job timeline shows every substitution with its reason.

**Verify.** A test that forces the first chain entry to fail and asserts both
the fallback event and the resolved model on the attempt row.

## Phase 4 — Security

**Deliverable.** Permission inheritance by intersection, per-worker worktrees,
and a sandbox backend interface with `none` and one real Linux implementation.

**Anchors.** `packages/core/src/permission/`; existing worktree management in
`packages/opencode/src/worktree/`.

**Risk — this is the phase most likely to be deferred.** It is invisible in a
demo and expensive to add later, because by then agents are running that were
written assuming they could reach anything. Treat the adversarial tests as the
deliverable, not the trimming.

**Done when.** A child cannot reach a tool its parent was denied, the escalation
path requires a human, and two writing workers provably cannot touch the same
file.

**Verify.** Adversarial tests: a child agent explicitly requesting a permission
its parent lacks must be denied; two concurrent writing workers must resolve to
different directories.

## Phase 5 — Jobs TUI

**Deliverable.** Job list, worker tree with role/model/state/elapsed, detail view
with tokens, tools, errors, worktree, transcript and artifacts, and the actions:
attach, message, pause, resume, cancel, retry, promote, inspect diff.

**Risk — two API surfaces.** The TUI consumes the generated SDK built from the
`packages/opencode` HTTP API, while jobs live in `packages/core` v2. The bridge
pattern already exists: `packages/opencode/src/session/todo.ts` mirrors a core v2
table through the v1 service layer. Follow it rather than inventing a third path.
This is also what the pending `/goal` and `/loop` slash commands need, so do both
in one pass.

**Done when.** A running job is fully legible without reading the database, and
every action works from the TUI.

## Phase 6 — Workflows

**Deliverable.** Five primitives — `agent`, `parallel`, `gate`, `verify`, `loop` —
plus declarative steps with `depends_on`, human gates, and resilient fanout
(`all`, `any`, `quorum`, `best-effort`).

**Rule.** Steal the semantics, not the dependencies. The engine is a few hundred
lines over Phase 2's scheduler, not a workflow framework.

**Done when.** The audit workflow from `harness.md` runs end to end: planner,
three parallel scouts, synthesis, auditor, verify — with one scout failing and
the job still completing under `best-effort`.

## Phase 7 — Verification

**Deliverable.** A deterministic verifier over commands, diffs, tests and
artifact schemas, producing `VERIFIED` / `REFUTED` / `UNVERIFIED`, with
independent review where the reviewer is never the coder.

**Why it comes after workflows.** `verify` is a workflow primitive; the engine
needs to exist to call it. `UNVERIFIED` is a first-class outcome — a verifier
that could not run must never report success.

**Done when.** A worker's candidate is accepted only on evidence, and a refuted
candidate routes back to a fixer within the round limit.

## Phase 8 — Context and memory

Deferred deliberately. Repository maps, symbol graphs, memory layers and tool
retrieval all improve quality; none of them make the harness durable, and each
is large. They belong after the seven milestone pieces work.

The one piece already in place: goals, loops and todos are Context Sources that
survive compaction verbatim, which is the L1/L2 boundary the memory design
otherwise has to invent.

## Cross-cutting, built alongside

**Observability** (`harness.md` §15) is not a phase. Jobs are traces and workers
are spans by construction, so instrument as each phase lands rather than
retrofitting a trace tree afterwards.

**Error taxonomy** (§38) lands in Phase 1 as `Job.ExitReason` because Phase 2's
retry policy branches on it.

**Provider health** (§39) is a projection over attempt outcomes and needs no
separate collection path once Phase 3 records them.

**Quality score** (§28) and **evals** (§30) are projections over the same data.
They cost almost nothing once attempts carry model, role, outcome and cost — but
only if those fields are populated from Phase 3 rather than backfilled.

## Where each numbered item lands

| Phase | Items from `harness.md` |
| --- | --- |
| 0 | — |
| 1 | 1, 2, 3, 14, 38 |
| 2 | 5, 6, 17, 18, 24 |
| 3 | 4, 23, 39 |
| 4 | 7, 8, 9 |
| 5 | 16, 35, 36, 37, 33, 34 |
| 6 | 10, 12, 13, 40, 32 |
| 7 | 11, 26, 27, 28, 29, 30 |
| 8 | 19, 20, 21, 22, 25 |
| alongside | 15, 31 |

## Honest scope

This is a large body of work. The seven-piece milestone — Job, Ledger, Worker
Attempts, model-per-invocation, Scheduler, Worktrees, Verifier — spans Phases 1
through 4 plus 7, and each phase is days of work rather than hours.

Two things make that tractable:

- The ledger already exists. Phase 1 declares an aggregate on tested
  infrastructure instead of building event sourcing.
- Phases are independently useful. Phase 1 alone gives durable, inspectable work
  units. Phase 2 gives parallelism. Nothing needs the whole plan to finish before
  any of it pays off.

The failure mode to guard against is breadth: forty numbered items invite
touching all of them shallowly. The order above exists to prevent that. Finish a
phase, prove it, then start the next.

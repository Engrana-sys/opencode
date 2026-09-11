# Jobs

Durable work, independent of any conversation.

## Why a job is not a session

A **session** is a conversation. A **job** is a unit of work that outlives one:
it survives the session that created it, may be worked by several, and stays
answerable for its result after every one of them has ended.

The distinction runs all the way down:

| Entity | What it is | Lifetime |
| --- | --- | --- |
| **Session** | A conversation | Until someone stops talking |
| **Job** | Durable work with an objective | Until it settles, then forever as history |
| **Step** | An ordered stage within a job | Its job's |
| **Worker** | A unit of execution with a role — scout, auditor, fixer | Its job's |
| **Attempt** | One concrete run of a worker | Minutes |
| **Model** | A replaceable dependency, chosen per invocation | Per attempt |
| **Artifact** | A persistent result | Forever |

## The ledger is the truth

Nothing writes a job's state directly. Every fact is an event appended to the
`event` table under the job's aggregate, and the tables you read — `job`,
`job_step`, `job_worker`, `job_worker_attempt`, `job_artifact` — are
**projections** built from those events.

That has three consequences worth internalising:

1. **The projections are disposable.** Drop them, call `rebuild`, and they come
   back identical. `rebuild` re-runs the projectors over the stored events
   without touching the ledger — which is a different operation from `replay`,
   and the distinction is load-bearing: `replay` appends, and when handed an
   event the ledger already holds it verifies the two match and returns without
   invoking a projector. Feeding a stored ledger back through `replay` rebuilds
   nothing.

   The test that covers this rebuilds twice: once over emptied tables, and once
   more over the restored rows without clearing them. Only the second pass
   asserts idempotence — starting from empty, a handler that accumulates adds
   each amount once and looks correct.
2. **History is never overwritten.** A retried worker gains an attempt rather
   than mutating the previous one, so a run that failed on a network error and
   succeeded after it keeps both halves. A terminal job stays terminal —
   re-running work means a new job, so the record of what happened stays true.
3. **Every change carries its reason.** `status = failed` cannot be questioned
   later; a `WorkerFailed` event with an exit reason and the model that ran can.

The ledger itself is not new — opencode already had append-only event sourcing
with per-aggregate sequencing and replay. Jobs declare a new aggregate on it.

## Life of a job

```
created → planning → queued → running → verifying → reviewing → completed
                        ↓         ↓                              failed
                     blocked  waiting_human                   cancelled
                                                                 stale
```

`blocked` is the job's own inability to proceed. `waiting_human` is a deliberate
pause for a decision. Keeping them apart matters because only one of the two is
a problem.

Transitions are validated **before** they are recorded. An illegal move fails
rather than being written and reconciled afterwards: a ledger containing
impossible history is worse than no ledger.

## Workers and attempts

A worker is created with a role, an agent, and **the model it is spawned to
use** — the model lives on the worker, not only on its attempts, because
concurrency limits per provider and per model have to be applied before an
attempt exists.

Each attempt records what was **requested** and what was **resolved**, in
separate columns. A fallback that overwrote the request would be invisible
afterwards, and comparing models across a job would be meaningless. The resolved
model is recorded even when it matches: an attempt with no resolved model is one
that never reached a model at all.

Workers form a tree — `parentID`, `depth`, bounded at depth 4 and 64 workers per
job. A planner spawning scouts that spawn helpers is the intended shape; deeper
than that is usually a worker that failed to decompose and is recursing.

## Scheduling

Each tick, in this order — and the order is the design:

1. **Recovery** settles abandoned work, so its slots are free before anything new
   is admitted.
2. **Budgets** are enforced, so an exhausted job cannot admit more work on its
   way out. The wall-clock budget runs from the job's **first** entry into
   `running`, not its most recent: `running` is re-enterable from five states,
   and re-stamping the start time would hand a job that bounces through
   `blocked` a fresh budget on every pass.
3. **Admission** decides which queued workers fit.

Limits apply globally and per project, provider and model. A candidate that does
not fit is **skipped, not blocked**: stopping at the first one that does not fit
would let a single saturated provider idle every free slot.

Ordering is by priority, then arrival. The arrival tiebreak is what stops newer
work starving older work at the same priority.

A finished worker's slot is taken immediately rather than at the end of a batch.

### Retries

Whether a failure is worth retrying is decided by its **exit reason**, not by a
counter. A denied permission fails identically forever, so retrying it only
spends budget; a rate limit or a provider outage is worth another go.

Backoff is exponential with **full jitter**, which is not decoration: ten workers
rate-limited at once and retried at the same instant reproduce the rate limit
that stopped them. A rate limit also starts its first retry at the ceiling rather
than climbing to it, since the provider has already said how long to wait.

The backoff is durable — stored on the worker as `retryAfter`, not slept in
memory. It survives a restart and does not hold a slot while it waits.

## Recovery

A crash leaves rows saying `running` with nothing running. The status column
cannot be trusted for this, because the process that would have corrected it is
the one that died. **The lease can**, because it expires on its own.

So a running worker holds a lease. **The transition into `running` grants it**,
and the heartbeat only renews it — because those are two separate writes, and a
lease granted by the first heartbeat would leave a gap where the worker reads
`running` with no lease at all. That gap is exactly what recovery treats as
abandoned, so a scan landing inside it would declare stale a worker whose
executor had just started.

The heartbeat runs inside the attempt's own scope: when the attempt ends the
scope closes and the heartbeat stops with it. A lease can never outlive the work
it vouches for. What makes a worker abandoned is therefore that **nothing
renewed** its lease, not that it never had one.

**A lease is not in the ledger, and not in a projection.** It lives in its own
table for two reasons. It is not a fact about the work — it is a claim that
expires on its own — and recording every renewal put some eleven thousand rows a
day into `event` for four workers, burying the handful that said what the job
did. And a projection may be dropped and rebuilt at any moment; rebuilding one
that carried the lease would either wipe a live claim or resurrect an expired
one from a heartbeat recorded hours ago. Recovery can trust the lease only
because nothing else can move it.

Queued and `waiting_input` workers hold no lease. Neither is executing anything a
dying process could abandon — one waits for a slot, the other for a person who
might answer tomorrow.

Recovery **settles** abandoned work; it does not restart it. What decides the
disposition is whether the dead worker could have left changes behind:

- **Read-only worker** → `retryable`. Nothing to undo, running it again is free.
- **Worker holding a worktree** → `needs_review`. It may hold a half-applied
  diff, and re-running over that compounds the mess.

## Isolation

A worker that writes gets its own git worktree and a branch named after it, and
**runs inside it** — the session is anchored there rather than in the job's
shared checkout.
Readers share the project checkout — a scout that only greps has nothing to
isolate, and a checkout per scout is a checkout wasted.

An **unclassified role is treated as writing.** The asymmetry is deliberate: a
role given a worktree it does not need costs one checkout, while a role denied
one it does need writes into a tree it shares with others.

Provisioning happens when a worker is admitted, not when it is queued, so a job
cancelled before it starts leaves no trees behind. The base commit is pinned at
creation and recorded, so workers of one job start from the same tree even if the
branch moves under them — which is what makes their diffs comparable.

Releasing a tree with uncommitted work **fails rather than forcing**. That
failure is the point: the uncommitted work is the only record of what the worker
did.

## Permissions

A child worker can never end up more permissive than its parent. Without that,
delegation is an escalation path: an agent denied `bash` reaches it by spawning a
child whose agent allows it.

Rulesets cannot be intersected syntactically — they are ordered wildcard rules
where the last match wins. What is intersected is the **decision**: evaluate the
same action and resource against every ruleset in the chain and keep the most
restrictive answer. The child's ruleset is then rewritten so ordinary evaluation
reaches that answer with no further ceremony.

That rewrite is three layers, and the order is the mechanism: the parent's rules,
then the child's capped rule by rule, then **the parent's restrictions again,
last**. Capping alone is not enough, because it asks the parent about the child
rule's *pattern* as though the pattern were a resource — and a parent denying
`rm *` does not match the literal string `*`. Without the final layer a child
asking broadly reaches straight past a narrow denial: the parent says no to
`rm -rf /` and the clamped ruleset says yes. The parent's permissions are not
re-appended, only its `deny` and `ask`, since re-adding them would undo the
narrowing a child is entitled to make.

The clamp happens inside `createWorker`, not at the call site. An invariant that
depends on every caller remembering it is not an invariant.

> **Open gap.** A session does not yet accept an explicit ruleset to run under,
> so the clamped ruleset is computed, stored and auditable — but not enforced
> inside the worker's session. Until that lands, a child whose agent is more
> permissive than its parent is denied on paper and permitted in practice.

## Verification

A worker proposes; the verifier decides. A model asked whether its own work is
correct is not a check — it is the same judgement that produced the work, asked a
second time. Everything the verifier does is a command that exits zero or does
not, or a diff that touches permitted paths or does not.

Three verdicts, and the third is the point:

- **verified** — every check ran and passed
- **refuted** — at least one check failed
- **unverified** — no failures, but something could not run

`unverified` is not a soft failure. It is the absence of evidence, and
collapsing it into either neighbour would be a lie in one direction or the
other. An empty check set is `unverified` too: checking nothing proves nothing,
and the opposite default would make an unconfigured verifier the most permissive
one in the system.

File checks apply `forbid` after `allow` — a forbid rule is a carve-out from
something already permitted, and applying it first would let a broad allow
silently override the narrow rule that exists to stop exactly that.

## Current state

Working: the job aggregate and ledger, projections that rebuild from it,
the scheduler with a rolling pool, per-invocation models, worktrees that workers
actually run in, capability clamping, recovery, budgets and the verifier.
Attempts run as sessions, and verdicts are projected rather than buried.

Three of those lines were untrue until an audit said so. Worktrees were
provisioned and unused, the clamp let a child reach past a narrow denial, and
"projections can be rebuilt" had no code path — with a test that passed because
it deleted the ledger along with the projections. Each is fixed, with a test
that fails when the fix is reverted.

Not built: sandbox backends, the workflow engine and human gates, the jobs TUI
and public API, and context/memory. **Nothing creates jobs in a production path
yet** — the scheduler runs, but has no source of work until the workflow engine
or an API lands.

Roadmap in [`../specs/v2/harness.md`](../specs/v2/harness.md), phased plan with
invariants in [`../specs/v2/harness-plan.md`](../specs/v2/harness-plan.md).

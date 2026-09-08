# Durable Agentic Harness

## Purpose

Turn OpenCode into a durable operating system for agentic work: long tasks split
across specialised agents, each on the model best suited to it, with state,
context and results surviving between sessions, and with what is running,
under which agent, on which model, in which state, and what it produced
visible at any moment.

The aim is not another coding agent. It is durability, traceability and
multi-provider execution around the agent that already exists.

## Central principle

**Session ≠ Job ≠ Worker ≠ Model.**

- A **Session** is a conversation.
- A **Job** is a durable unit of work, independent of any conversation.
- A **Worker** is a unit of execution with a role.
- An **Attempt** is one concrete run of that worker.
- A **Model** is a replaceable dependency, chosen per invocation.
- An **Artifact** is a persistent result.
- The **Event Ledger** is the historical source of truth.

OpenCode today is organised around `Session`. Everything below follows from
introducing `Job` as a first-class entity beside it.

## What already exists

Read this before proposing to build any of it. The repository is further along
than an outside reading suggests, and the cheapest version of this harness is
the one that declares new aggregates on the machinery already here.

| Piece | Where | Notes |
| --- | --- | --- |
| Append-only event ledger | `packages/core/src/event/sql.ts` | `EventTable` keyed by `aggregate_id` + monotonic `seq`, JSON payload. Exactly the table this document asks for. |
| Aggregate sequencing and ownership | `EventSequenceTable` | Carries `owner_id`, already the basis for leases. |
| Durable event declaration | `packages/schema/src/session-event.ts` | `Event.define({ durable: { aggregate, version } })`. A `job` aggregate is declared the same way. |
| Replay | `EventV2.durable({ aggregateID, after })` | Cold stream of durable events for an aggregate. |
| Projections | `events.project(Definition, handler)` | See `packages/core/src/session/projector.ts`. State is rebuilt by projecting the ledger. |
| Per-invocation model resolution | `SessionRunnerModel.resolveNamed` | Resolves one catalog model by identity, independent of the session's model. |
| System model chains | `packages/core/src/session/system-model.ts` | Ordered per-role chains with fallthrough. |
| Persistent goals | `packages/core/src/session/goal.ts` | Condition, budget, independent evaluator. |
| Durable loops | `packages/core/src/session/loop.ts` | Interval or self-paced, survives restart. |
| Compaction-proof context | `packages/core/src/session/guidance.ts` | Goal, loop and todos as Context Sources, re-rendered verbatim each Context Epoch. |
| Snapshots | `packages/core/src/snapshot.ts` | File state capture around a step. |
| Permissions | `packages/core/src/permission/` | Per-agent evaluation already scoped by effective agent. |
| Worktrees | `packages/opencode/src/worktree/` | Existing management to build per-worker worktrees on. |

**Consequence:** the ledger is not a build item. Jobs, workers and attempts are
new aggregates and projections over infrastructure that is already tested.

## Status

- [x] Persistent goals with an independent evaluator
- [x] Durable loops, fixed-interval and self-paced
- [x] Goal, loop and todos as Context Sources that survive compaction
- [x] Per-role system model chains with fallthrough
- [ ] Everything below

## P0

### 1. Job as a first-class entity

```
Job: id, project, title, objective, type, status, stage, created_at,
     started_at, completed_at, requested_by, base_ref, workspace,
     worktree, budget, result
```

States: `CREATED`, `PLANNING`, `QUEUED`, `RUNNING`, `BLOCKED`, `WAITING_HUMAN`,
`VERIFYING`, `REVIEWING`, `COMPLETED`, `FAILED`, `CANCELLED`, `STALE`.

Shape: a job holds ordered steps; a step holds worker attempts.

### 2. Append-only event ledger

Storing `status = "running"` is not enough. The visible state of a job must be
reconstructible by projecting its events:

```
JOB_CREATED, PLAN_STARTED, PLAN_COMPLETED,
WORKER_CREATED (role, provider, model, worktree), WORKER_STARTED,
TOOL_STARTED, TOOL_COMPLETED, WORKER_RETRY, WORKER_COMPLETED, ...
```

Uses the existing `event` table with `aggregate_id = jobID`.

### 3. Worker and Attempt separated

Never overwrite a worker's history. One worker, many attempts:

```
Attempt: provider_requested, model_requested, provider_resolved,
         model_resolved, variant, session_id, started_at, completed_at,
         tokens_input, tokens_cached, tokens_output, cost,
         exit_reason, error, retry_reason
```

### 4. Real model per invocation

```ts
worker_spawn({ agent, provider, model, variant, budget })
```

Always persist requested and resolved provider/model.

**Rule: never a silent fallback.** A fallback emits
`MODEL_FALLBACK_REQUESTED` / `MODEL_FALLBACK_APPROVED` / `MODEL_RESOLVED`,
or the attempt fails outright.

> Open tension: `system-model.ts` currently falls through its chain and only
> logs a warning. Once the ledger exists that must become ledger events with
> requested and resolved recorded. Tracked as a deliberate debt.

### 5. Scheduler

Limits: `max_global_workers`, `max_workers_per_provider`, `max_workers_per_model`,
`max_workers_per_project`. FIFO/priority, deadlines, retries, exponential backoff,
jitter, rate limiting, cancellation.

Rolling pool: with N slots, a finished worker frees its slot immediately for the
next queued one rather than waiting for a batch to drain.

### 6. Real agent tree

`worker.parent_worker_id`, `worker.depth`, `worker.role`, bounded by
`max_depth`, `max_children`, `max_total_workers`.

### 7. Capability monotonicity

A child never gains permissions its parent lacks without explicit human approval:

```
effectiveChild = intersection(parentEffective, agentRequested, workflowPermissions)
```

Intersection, never union.

### 8. Sandbox backends

`none`, `landlock`, `bubblewrap`, `container`, `microvm`.
Linux first: landlock/bubblewrap, then container, microVM later.

### 9. Writable worktree per worker

Read-only workers share a base checkout. Writing workers get their own worktree,
mandatory. Persist `repo`, `base_ref`, `base_sha`, `branch`, `worktree`, `dirty`,
`commit`.

### 10. Small workflow engine

Five primitives: `agent`, `parallel`, `gate`, `verify`, `loop`. Declarative steps
with `depends_on`. **Steal the semantics, not the dependencies.**

### 11. Deterministic verifier

Workers produce candidates; the verifier checks tests, lint, typecheck, build,
git diff, file allowlist, forbidden files, HTTP assertions, DB migrations, custom
scripts. Verdicts: `VERIFIED`, `REFUTED`, `UNVERIFIED`.

### 12–13. Human gates and escalation

`Approval` records id, job, step, reason, scope, decision, decided_by. Job sits in
`WAITING_HUMAN`. A child emitting `WORKER_NEEDS_INPUT` may be answered by its
parent or escalated to the human.

### 14. Artifacts

`finding`, `plan`, `patch`, `diff`, `report`, `test-result`, `benchmark`,
`screenshot`, `log`, `structured-json`. The job keeps intermediate artifacts, not
only the final result.

### 15. Observability

Job as trace, workers as spans, LLM requests and tool calls as child spans.
Metrics: tokens, cached tokens, cost, latency, TTFT, tool calls, tool errors,
retries, wall time, context size, compactions, provider failures.

### 16. Jobs TUI

Job list with per-worker role, model, state and elapsed time; detail view with
tokens, tools, errors, worktree, transcript, artifacts; actions: attach, message,
pause, resume, cancel, retry, promote, inspect diff.

### 17–18. Recovery, heartbeats and leases

On startup, a recovery scan finds running workers with no process, processes with
no worker, dirty worktrees, blocked jobs, expired leases and unfinished attempts,
and reclassifies them `ORPHANED`, `RETRYABLE` or `NEEDS_REVIEW`.

`heartbeat_at` and `lease_until` distinguish a model thinking, a tool running,
a rate-limit wait, a human block, and genuinely dead.

### 19–22. Context and memory

Context engine: repo topology, symbol search, semantic search, candidate files,
progressive disclosure. Repository map, symbol/import/reference graphs, recently
changed, ownership, tests ↔ production mapping.

Skills indexed by name/description/trigger/cost/required_tools, body loaded only
on demand. Tool retrieval narrowing a large registry to the relevant few.

Memory layers: L0 immediate context, L1 session summary, L2 job memory,
L3 project memory, L4 knowledge base — each fact carrying scope, source,
validity window, confidence, supersedes and provenance.

### 23–25. Routing and budgets

Role declares requirements and preferences; the router picks a healthy model and
falls back only where policy allows, else fails.

Budgets per job (cost, tokens, wall time, worker count) and per worker (turns,
tool calls, duration, context), with `BUDGET_WARNING` and `BUDGET_EXHAUSTED`.
Context budget per role: scouts bounded in files/tool calls/turns, auditors
limited to candidates plus cited files, fixers to plan plus finding plus tests.

### 26–30. Quality

Structured output between agents via JSON Schema. Independent review: the coder
is never the reviewer, preferably not even the same provider family. Quality
score per model/role/task-class from verifier and review outcomes, so routing can
eventually use own data. Replay of a job with same or latest models, from any
step, or dry. Evals per task class measuring success, cost, latency, files
touched, unnecessary diff, findings recall, false positives, retries.

### 31–40. Surface

Gitea as a first-class `ForgeProvider` beside GitHub and GitLab. Scheduled jobs
(once, cron, interval, condition). Notifications on completion, failure and
waiting-human. Session and job finalization hooks. Public job API with SSE event
stream. Full plugin runtime and a versioned plugin ABI. An error taxonomy where
each class carries its own retry policy. Provider health tracking. Resilient
fanout with `all`, `any`, `quorum` and `best-effort` policies.

## Database

Extend the existing persistence; do not introduce a second database.

```
job, job_step, worker, worker_attempt, job_event, artifact, approval,
verification, checkpoint, worktree, model_route, memory, schedule
```

`job_event` is the existing `event` table under a `job` aggregate. The rest are
projections built from it.

## Core vs plugin vs MCP

- **Core:** durability, permissions, scheduler, sessions, workers, jobs,
  workflows, model routing, sandbox.
- **Plugin:** integrations, memory backends, telemetry backends, notifications,
  forge providers, custom reporting.
- **MCP:** external capabilities and data only.

Never implement the central scheduler over MCP.

## Order of implementation

0. **Harness tests** — regression coverage proving ordinary OpenCode still works.
1. **Durable jobs** — job, worker, attempt, event, artifact.
2. **Background fleet** — parallel workers, rolling pool, retry, timeout, cancel,
   heartbeat, recovery.
3. **Model correctness** — model per invocation, requested/resolved, no silent
   fallback, ledger events.
4. **Security** — permission inheritance, capability monotonicity, read-only
   adversarial tests, worktrees, sandbox.
5. **TUI** — jobs view, worker tree, attach, logs, model, tokens, duration.
6. **Workflows** — agent, parallel, gate, verify, loop.
7. **Verification** — commands, diff, tests, artifact schemas.
8. **Context and memory** — last.

## First milestone

Job + Event Ledger + Worker Attempts + model-per-invocation + Scheduler +
Worktrees + Verifier.

Memory, browser, remote access, richer UI, notifications and scheduling come
after. If those seven work, the rest are extensions. If they do not, no quantity
of agents, skills or interfaces repairs the architecture.

## Definition of done

A single instruction creates a durable job, splits it across specialised agents
on different models, runs them in parallel in their own worktrees under inherited
permissions, records every transition, survives the process being killed,
validates results with real verifiers, asks for human approval where it matters,
keeps its artifacts, shows all of it in the TUI, and can be replayed.

```
opencode job show|timeline|workers|artifacts|replay <id>
```

## References

Grouped by the area they inform. These are reading material, not dependencies.

- **Orchestration:** superharness, agetor, agx, agentic-orchestrator (DoorDash),
  prime-agent, deepseek-harness, OpenHands, gsd-core, beads, gastown, orchestrate,
  crewAI, autogen, ag2, deepagents.
- **Durable execution:** temporal, restate, langgraph, hatchet, dagster, prefect,
  inngest, trigger.dev, windmill, argo-workflows, kestra, cadence, dbos.
- **Memory:** mem0, graphiti, letta, cognee, langmem, supermemory, llama_index;
  qdrant, lancedb, chroma, pgvector, milvus, weaviate.
- **Code understanding:** aider, tree-sitter, ast-grep, semgrep, comby, ripgrep,
  zoekt, scip, serena, repomix, gitingest, ctags; pyright, rust-analyzer.
- **Sandbox:** bubblewrap, nsjail, gvisor, firecracker, kata, firejail, E2B,
  daytona, devcontainers, nix.
- **Observability:** langfuse, phoenix, openllmetry, helicone, agentops, weave,
  braintrust, openlit, signoz, opentelemetry.
- **Evaluation:** SWE-agent, SWE-bench, LiveCodeBench, bigcodebench, AgentBench,
  promptfoo, openai/evals, autoevals, pydantic/evals, openevals.
- **Routing:** litellm, tensorzero, RouteLLM, portkey, vllm, sglang, ollama.
- **Worktrees:** wta, agent-worktree, gitbutler, jj, git-town.
- **Policy:** opa, cedar, casbin, cue; infisical, sops, age; in-toto, sigstore,
  slsa.
- **Indexes:** best-of-Agent-Harnesses, awesome-agent-runtime,
  Awesome-Agent-Harnesses, awesome-harness-engineering,
  awesome-agent-runtime-security, awesome-agent-infrastructure, awesome-mcp.

Reading order: orchestration harnesses first (job/worker/retry/approval shapes),
then durable execution engines (event semantics, replay, idempotency), then code
understanding, then observability, then sandboxing.

# OpenCode durable harness

This repository is a fork of [OpenCode](https://github.com/sst/opencode) focused
on making long-running agent work durable, inspectable, and recoverable.
OpenCode remains the foundation and its documentation applies to the existing
CLI, desktop application, providers, and configuration. This README describes
what is different in the fork.

> [!IMPORTANT]
> The fork is under active development. Persistent goals and loops work in
> ordinary sessions today. The job runtime is implemented and tested in the
> core, but no production UI or API creates jobs yet.

## Why this fork exists

A conversation is a useful interface, but it is not a durable unit of work.
Long tasks need an objective that survives compaction, an execution history that
survives process failure, isolated workers, explicit budgets, and verification
that does not depend on the model grading its own answer.

The architecture keeps those concerns separate:

> **Session ≠ Job ≠ Worker ≠ Attempt ≠ Model.**

- A **session** is a conversation with an agent.
- A **job** is durable work with an objective and a permanent history.
- A **worker** performs one role within a job.
- An **attempt** records one concrete run of a worker.
- A **model** is selected per invocation and remains replaceable.

## What works today

### Durable sessions

- **Persistent goals** keep a stopping condition in durable context and use an
  independent evaluator to decide whether the session should continue.
- **Durable loops** admit scheduled prompts without holding an in-memory timer,
  so overdue work resumes after a restart.
- **Compaction-proof context** restores goals, loops, and todos verbatim at each
  context epoch instead of trusting a progressively summarized copy.
- **System-model chains** let infrastructure calls fall through an ordered list
  of models when a provider is unavailable or returns an unusable result.

Goals and loops are currently model-callable tools, not native `/goal` and
`/loop` TUI commands. See [Goals, loops and system models](docs/goals-and-loops.md)
for usage and configuration.

### Durable jobs

The core job subsystem now provides:

- an append-only event ledger and replayable job projections;
- explicit steps, workers, attempts, artifacts, and requested/resolved models;
- a rolling scheduler with global, project, provider, and model admission limits;
- durable retry backoff, lease-based crash recovery, and budget enforcement;
- per-worker git worktrees for roles that may write;
- monotonic permission clamping across a worker tree;
- session-backed worker attempts; and
- deterministic command and file verification with `verified`, `refuted`, and
  `unverified` outcomes.

The job runtime is not a user-facing feature yet. Sandbox backends, workflows,
human approval gates, context and memory, the jobs TUI, and a public jobs API
remain to be built. Capability clamping is computed and persisted, but is not
yet enforced inside the worker session. Nothing currently creates jobs through
a production path.

Most of the harness was written in one session by one author, whose tests share
that author's blind spots; only two areas have had an independent review so far.
[Fork documentation](docs/README.md) records which.

Read [Jobs](docs/jobs.md) for the implemented model and its constraints. The
[harness architecture](specs/v2/harness.md) and
[phased implementation plan](specs/v2/harness-plan.md) describe the target and
the invariants used to evaluate each phase.

## Install and run the fork

The upstream installer and package-manager releases install upstream OpenCode,
not this fork. To run the durable harness, build it from this repository.

Requirements: Git and the Bun version pinned in [`package.json`](package.json).

```bash
git clone https://github.com/Engrana-sys/opencode
cd opencode
bun install
bun run dev
```

`bun run dev` starts the CLI directly from TypeScript. To produce a binary:

```bash
bun run --cwd packages/opencode build
```

See [Installing this fork on Linux](docs/install-linux.md) for distribution
packages, state locations, verification steps, provider setup, and upstream
merge guidance.

## Documentation

| Start here | Purpose |
| --- | --- |
| [Fork documentation](docs/README.md) | Status, reading order, and an honest feature matrix |
| [Installation](docs/install-linux.md) | Build and run from source on Debian and Arch-based systems |
| [Goals and loops](docs/goals-and-loops.md) | Use the session features available today |
| [Jobs](docs/jobs.md) | Understand the durable job runtime already implemented in core |
| [Harness architecture](specs/v2/harness.md) | Review the target architecture and remaining backlog |
| [Harness plan](specs/v2/harness-plan.md) | Follow implementation phases and testable invariants |

For all unchanged OpenCode functionality, use the
[upstream documentation](https://opencode.ai/docs).

## Current status

| Area | State |
| --- | --- |
| Persistent goals, loops, and compaction-proof context | Working |
| System-model chains with fallthrough | Working |
| Job ledger and replayable projections | Working |
| Scheduler, admission limits, retries, leases, and budgets | Working |
| Session-backed attempts and per-worker worktrees | Working |
| Deterministic verifier | Working |
| Capability clamping | Persisted, not yet enforced by worker sessions |
| Sandbox backends, workflows, and human gates | Not started |
| Jobs TUI and public API | Not started |
| Production job creation | Not started |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. This fork tracks
OpenCode's `dev` branch; keep fork-specific behavior documented separately from
upstream behavior and preserve the durable-job invariants in the harness plan.

## Upstream attribution

This project is based on the open-source
[OpenCode](https://github.com/sst/opencode) coding agent. The durable harness and
the documentation linked above are fork-specific and are not part of upstream
OpenCode.

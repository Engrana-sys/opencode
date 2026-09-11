import { describe, expect } from "bun:test"
import { asc } from "drizzle-orm"
import { DateTime, Duration, Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Job } from "@opencode-ai/schema/job"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { JobV2 } from "@opencode-ai/core/job"
import { JobProjector } from "@opencode-ai/core/job/projector"
import { JobStore } from "@opencode-ai/core/job/store"
import {
  JobArtifactTable,
  JobAttemptTable,
  JobStepTable,
  JobTable,
  JobVerificationTable,
  JobWorkerTable,
} from "@opencode-ai/core/job/sql"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, JobProjector.node, JobStore.node, JobV2.node]),
  ),
)

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
})

const newJob = Effect.fn("test.newJob")(function* () {
  const jobs = yield* JobV2.Service
  return yield* jobs.create({
    projectID: Project.ID.global,
    directory: "/project",
    title: "audit billing",
    objective: "find billing bugs in the voice service",
    type: "audit",
    requestedBy: "user",
  })
})

const model = (providerID: string, modelID: string): Job.ModelRef => ({ providerID, modelID })

describe("Job", () => {
  it.effect("creates a job in its initial state", () =>
    Effect.gen(function* () {
      yield* setup
      const job = yield* newJob()
      expect(job.status).toBe("created")
      expect(job.objective).toBe("find billing bugs in the voice service")
      expect(job.usage).toEqual(Job.emptyUsage)
      expect(job.timeStarted).toBeUndefined()
    }),
  )

  it.effect("walks the legal path and records when work began", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const job = yield* newJob()

      yield* jobs.transition({ jobID: job.id, to: "planning" })
      yield* jobs.transition({ jobID: job.id, to: "queued" })
      const running = yield* jobs.transition({ jobID: job.id, to: "running", stage: "scouts" })
      expect(running.status).toBe("running")
      expect(running.stage).toBe("scouts")
      expect(running.timeStarted).toBeDefined()

      const settled = yield* jobs.settle({ jobID: job.id, status: "completed", result: "5 findings" })
      expect(settled.status).toBe("completed")
      expect(settled.result).toBe("5 findings")
      expect(settled.timeCompleted).toBeDefined()
      // A settled job holds no stage: there is no work in progress to label.
      expect(settled.stage).toBeUndefined()
    }),
  )

  it.effect("keeps the start time of the first run when work resumes", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const job = yield* newJob()

      yield* jobs.transition({ jobID: job.id, to: "queued" })
      const first = yield* jobs.transition({ jobID: job.id, to: "running" })
      expect(first.timeStarted).toBeDefined()

      // `running` is re-enterable from five states. If each entry rewrote the
      // start time, a job bouncing through `blocked` would renew its
      // wall-clock budget on every pass and never expire.
      yield* TestClock.adjust(Duration.minutes(5))
      yield* jobs.transition({ jobID: job.id, to: "blocked" })
      const resumed = yield* jobs.transition({ jobID: job.id, to: "running" })

      expect(resumed.timeStarted).toEqual(first.timeStarted)
      // And the clock really did move, so the assertion above is not vacuous:
      // the elapsed time the budget reads is still measured from the first run.
      const elapsed = DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(resumed.timeStarted!)
      expect(elapsed).toBeGreaterThanOrEqual(Duration.toMillis(Duration.minutes(5)))
    }),
  )

  it.effect("refuses an illegal transition instead of recording it", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const job = yield* newJob()

      const failure = yield* jobs.transition({ jobID: job.id, to: "verifying" }).pipe(Effect.flip)
      expect(failure._tag).toBe("Job.InvalidTransitionError")
      expect((yield* jobs.transition({ jobID: job.id, to: "queued" })).status).toBe("queued")
    }),
  )

  it.effect("a terminal job is final", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const job = yield* newJob()
      yield* jobs.transition({ jobID: job.id, to: "queued" })
      yield* jobs.settle({ jobID: job.id, status: "failed", error: "provider down" })

      // Re-running work means a new job; reviving this one would make its
      // recorded history untrue.
      const failure = yield* jobs.transition({ jobID: job.id, to: "running" }).pipe(Effect.flip)
      expect(failure._tag).toBe("Job.InvalidTransitionError")
    }),
  )

  it.effect("keeps every attempt of a retried worker", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const store = yield* JobStore.Service
      const job = yield* newJob()
      const worker = yield* jobs.createWorker({ jobID: job.id, role: "scout-backend", agent: "scout", requested: model("mistral", "codestral") })

      const first = yield* jobs.startAttempt({ workerID: worker.id, requested: model("mistral", "codestral") })
      yield* jobs.settleAttempt({
        attemptID: first.id,
        workerID: worker.id,
        status: "failed",
        exitReason: "provider_unavailable",
        error: "connection reset",
      })
      const second = yield* jobs.startAttempt({
        workerID: worker.id,
        requested: model("mistral", "codestral"),
        retryReason: "provider_unavailable",
      })
      yield* jobs.settleAttempt({
        attemptID: second.id,
        workerID: worker.id,
        status: "completed",
        exitReason: "success",
        usage: { tokensInput: 1_000, tokensOutput: 200, tokensCached: 50, cost: 0.02 },
      })

      const attempts = yield* store.attempts(worker.id)
      expect(attempts).toHaveLength(2)
      expect(attempts.map((attempt) => attempt.number)).toEqual([1, 2])
      // The failed attempt is still readable, with why it failed.
      expect(attempts[0].status).toBe("failed")
      expect(attempts[0].exitReason).toBe("provider_unavailable")
      expect(attempts[0].error).toBe("connection reset")
      expect(attempts[1].status).toBe("completed")
      expect(attempts[1].retryReason).toBe("provider_unavailable")
    }),
  )

  it.effect("rolls usage up from attempts to worker and job", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const store = yield* JobStore.Service
      const job = yield* newJob()
      const worker = yield* jobs.createWorker({ jobID: job.id, role: "scout", agent: "scout", requested: model("mistral", "codestral") })

      for (const cost of [0.01, 0.02]) {
        const attempt = yield* jobs.startAttempt({ workerID: worker.id, requested: model("mistral", "codestral") })
        yield* jobs.settleAttempt({
          attemptID: attempt.id,
          workerID: worker.id,
          status: "completed",
          exitReason: "success",
          usage: { tokensInput: 100, tokensOutput: 10, tokensCached: 5, cost },
        })
      }

      // A retried worker's earlier attempts stay counted; the cost was real.
      expect((yield* store.worker(worker.id))?.usage).toEqual({
        tokensInput: 200,
        tokensOutput: 20,
        tokensCached: 10,
        cost: 0.03,
      })
      expect((yield* store.get(job.id))?.usage.cost).toBeCloseTo(0.03, 10)
    }),
  )

  it.effect("records the model that answered apart from the one requested", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const store = yield* JobStore.Service
      const job = yield* newJob()
      const worker = yield* jobs.createWorker({ jobID: job.id, role: "auditor", agent: "auditor", requested: model("mistral", "codestral") })
      const attempt = yield* jobs.startAttempt({ workerID: worker.id, requested: model("mistral", "codestral") })

      yield* jobs.resolveModel({
        attemptID: attempt.id,
        workerID: worker.id,
        requested: model("mistral", "codestral"),
        resolved: model("anthropic", "claude-haiku-4-5"),
        reason: "mistral unavailable",
      })

      const stored = (yield* store.attempts(worker.id))[0]
      expect(stored.requested).toEqual(model("mistral", "codestral"))
      expect(stored.resolved).toEqual(model("anthropic", "claude-haiku-4-5"))

      // The substitution is in the ledger, with its reason. A fallback that only
      // overwrote the request would leave nothing to find here.
      const fallback = (yield* store.timeline(job.id)).find(
        (event): event is EventV2.Payload<typeof JobV2.Event.ModelResolved> =>
          event.type === JobV2.Event.ModelResolved.type,
      )
      expect(fallback?.data.fellBack).toBe(true)
      expect(fallback?.data.reason).toBe("mistral unavailable")
    }),
  )

  it.effect("builds a worker tree and refuses to go too deep", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const job = yield* newJob()

      let parent = yield* jobs.createWorker({ jobID: job.id, role: "planner", agent: "planner", requested: model("mistral", "codestral") })
      expect(parent.depth).toBe(0)
      for (let depth = 1; depth <= JobV2.MAX_DEPTH; depth++) {
        parent = yield* jobs.createWorker({
          jobID: job.id,
          role: `level-${depth}`,
          agent: "scout",
          requested: model("mistral", "codestral"),
          parentID: parent.id,
        })
        expect(parent.depth).toBe(depth)
      }

      const failure = yield* jobs
        .createWorker({ jobID: job.id, role: "too-deep", agent: "scout", requested: model("mistral", "codestral"), parentID: parent.id })
        .pipe(Effect.flip)
      expect(failure._tag).toBe("Job.TreeLimitError")
    }),
  )

  it.effect("a child cannot be granted more than its parent holds", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const job = yield* newJob()
      const parent = yield* jobs.createWorker({
        jobID: job.id,
        role: "planner",
        agent: "planner",
        requested: model("mistral", "codestral"),
        permissions: [{ action: "bash", resource: "*", effect: "deny" }],
      })

      // The escalation this closes: a worker denied bash spawning a child whose
      // own agent allows it. The service clamps rather than trusting the caller.
      const child = yield* jobs.createWorker({
        jobID: job.id,
        role: "helper",
        agent: "scout",
        requested: model("mistral", "codestral"),
        parentID: parent.id,
        permissions: [{ action: "bash", resource: "*", effect: "allow" }],
      })
      expect(PermissionV2.evaluate("bash", "*", child.permissions).effect).toBe("deny")
    }),
  )

  it.effect("a heartbeat is not history and appends nothing to the ledger", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const { db } = yield* Database.Service
      const job = yield* newJob()
      const worker = yield* jobs.createWorker({ jobID: job.id, role: "scout", agent: "scout", requested: model("mistral", "codestral") })
      yield* jobs.workerStatus({ workerID: worker.id, to: "running" })

      const before = (yield* db.select().from(EventTable).all().pipe(Effect.orDie)).length
      for (let beat = 0; beat < 20; beat++) yield* jobs.heartbeat({ workerID: worker.id, leaseMs: 60_000 })

      // Twenty renewals used to be twenty ledger rows. Four workers beating
      // every thirty seconds appended some eleven thousand a day, burying the
      // handful of entries that said what the job actually did.
      expect((yield* db.select().from(EventTable).all().pipe(Effect.orDie)).length).toBe(before)
    }),
  )

  it.effect("rebuilding the projections leaves a live lease alone", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const store = yield* JobStore.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const job = yield* newJob()
      const worker = yield* jobs.createWorker({ jobID: job.id, role: "scout", agent: "scout", requested: model("mistral", "codestral") })
      yield* jobs.workerStatus({ workerID: worker.id, to: "running" })
      yield* jobs.heartbeat({ workerID: worker.id, leaseMs: 60_000 })
      expect(yield* store.expired()).toHaveLength(0)

      // A lease says what is running right now. It lives outside the
      // projections precisely so that rebuilding them — which may happen at any
      // time and reads a history in which every heartbeat is long past — cannot
      // declare live work abandoned.
      for (const table of [JobAttemptTable, JobWorkerTable, JobStepTable, JobTable])
        yield* db.delete(table).run().pipe(Effect.orDie)
      yield* events.rebuild(job.id)

      expect((yield* store.worker(worker.id))?.leaseUntil).toBeDefined()
      expect(yield* store.expired()).toHaveLength(0)
    }),
  )

  it.effect("a recorded verdict is readable without decoding the ledger", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const store = yield* JobStore.Service
      const job = yield* newJob()
      const worker = yield* jobs.createWorker({ jobID: job.id, role: "fixer", agent: "fixer", requested: model("mistral", "codestral") })

      yield* jobs.recordVerification({
        jobID: job.id,
        workerID: worker.id,
        verdict: "unverified",
        results: [
          { name: "tests", outcome: "passed", detail: "1211 pass" },
          { name: "lint", outcome: "errored", detail: "oxlint not found" },
        ],
      })

      // `unverified` is the whole reason this is worth projecting: a verdict
      // that is neither a pass nor a failure is only legible beside the checks
      // that produced it.
      const recorded = yield* store.verifications(job.id)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].verdict).toBe("unverified")
      expect(recorded[0].workerID).toBe(worker.id)
      expect(recorded[0].results.map((result) => result.outcome)).toEqual(["passed", "errored"])
    }),
  )

  it.effect("only one caller can claim a queued worker", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const store = yield* JobStore.Service
      const job = yield* newJob()
      const worker = yield* jobs.createWorker({ jobID: job.id, role: "scout", agent: "scout", requested: model("mistral", "codestral") })
      yield* jobs.workerStatus({ workerID: worker.id, to: "queued" })

      // Two overlapping scheduler ticks both read this worker as queued. Both
      // calls succeed, so only the answer separates them — and a caller that
      // cannot tell "I moved it" from "it was already there" opens a second
      // attempt against one lease and one worktree.
      expect(yield* jobs.workerStatus({ workerID: worker.id, to: "running" })).toBe(true)
      expect(yield* jobs.workerStatus({ workerID: worker.id, to: "running" })).toBe(false)

      // The loser's call changes nothing: one transition, one lease.
      expect((yield* store.worker(worker.id))?.status).toBe("running")
    }),
  )

  it.effect("a settled worker holds no lease", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const store = yield* JobStore.Service
      const job = yield* newJob()
      const worker = yield* jobs.createWorker({ jobID: job.id, role: "scout", agent: "scout", requested: model("mistral", "codestral") })

      yield* jobs.workerStatus({ workerID: worker.id, to: "running" })
      yield* jobs.heartbeat({ workerID: worker.id, leaseMs: 60_000 })
      expect((yield* store.worker(worker.id))?.leaseUntil).toBeDefined()
      expect(yield* store.expired()).toHaveLength(0)

      yield* jobs.workerStatus({ workerID: worker.id, to: "completed" })
      const settled = yield* store.worker(worker.id)
      expect(settled?.leaseUntil).toBeUndefined()
      // Recovery must not rediscover work that already finished.
      expect(yield* store.expired()).toHaveLength(0)
    }),
  )

  it.effect("a worker that stopped stays stopped", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const store = yield* JobStore.Service
      const job = yield* newJob()
      const worker = yield* jobs.createWorker({ jobID: job.id, role: "fixer", agent: "fixer", requested: model("mistral", "codestral") })
      yield* jobs.workerStatus({ workerID: worker.id, to: "running" })
      yield* jobs.workerStatus({ workerID: worker.id, to: "stale", reason: "Lease expired" })
      const abandoned = yield* store.worker(worker.id)

      // Recovery declared this worker abandoned and someone has to look at what
      // it left behind. An executor returning late must not be able to record
      // it as a clean finish instead.
      const settling = yield* jobs.workerStatus({ workerID: worker.id, to: "completed" }).pipe(Effect.flip)
      expect(settling._tag).toBe("Job.InvalidWorkerTransitionError")
      // Nor may it be put back to work: that would grant a fresh lease to a row
      // that already carries a completion time.
      const reviving = yield* jobs.workerStatus({ workerID: worker.id, to: "running" }).pipe(Effect.flip)
      expect(reviving._tag).toBe("Job.InvalidWorkerTransitionError")

      const after = yield* store.worker(worker.id)
      expect(after?.status).toBe("stale")
      expect(after?.leaseUntil).toBeUndefined()
      expect(after?.timeCompleted).toEqual(abandoned?.timeCompleted)
    }),
  )

  it.effect("an attempt is settled once", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const store = yield* JobStore.Service
      const job = yield* newJob()
      const worker = yield* jobs.createWorker({ jobID: job.id, role: "scout", agent: "scout", requested: model("mistral", "codestral") })
      const attempt = yield* jobs.startAttempt({ workerID: worker.id, requested: model("mistral", "codestral") })
      yield* jobs.settleAttempt({
        attemptID: attempt.id,
        workerID: worker.id,
        status: "completed",
        exitReason: "success",
        usage: { tokensInput: 1_000, tokensOutput: 500, tokensCached: 0, cost: 2 },
      })

      // Recovery settling a stalled attempt after its executor already reported
      // would rewrite the outcome, and its usage would be rolled up twice into
      // the very totals budgets are enforced against.
      const late = yield* jobs
        .settleAttempt({
          attemptID: attempt.id,
          workerID: worker.id,
          status: "stale",
          exitReason: "stalled",
          error: "The process holding this attempt stopped reporting.",
        })
        .pipe(Effect.flip)
      expect(late._tag).toBe("Job.AttemptSettledError")

      const settled = (yield* store.attempts(worker.id)).find((item) => item.id === attempt.id)
      expect(settled?.status).toBe("completed")
      expect(settled?.exitReason).toBe("success")
      expect(settled?.error).toBeUndefined()
      const spent = { tokensInput: 1_000, tokensOutput: 500, tokensCached: 0, cost: 2 }
      expect(settled?.usage).toEqual(spent)
      expect((yield* store.worker(worker.id))?.usage).toEqual(spent)
      expect((yield* store.get(job.id))?.usage).toEqual(spent)
    }),
  )

  it.effect("a running worker with a lapsed lease is not running", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const store = yield* JobStore.Service
      const job = yield* newJob()
      const worker = yield* jobs.createWorker({ jobID: job.id, role: "scout", agent: "scout", requested: model("mistral", "codestral") })
      yield* jobs.workerStatus({ workerID: worker.id, to: "running" })

      // Entering `running` grants the first lease, so the worker is not
      // abandoned merely for not having heartbeated yet. Were it otherwise,
      // recovery would reclaim every worker in the gap between the transition
      // and its first heartbeat — two separate durable writes.
      expect((yield* store.worker(worker.id))?.leaseUntil).toBeDefined()
      expect(yield* store.expired()).toHaveLength(0)

      // Nothing renewed it: the process died mid-attempt.
      yield* TestClock.adjust(Duration.millis(Job.LEASE_MS + 1))
      expect((yield* store.expired()).map((item) => item.id)).toEqual([worker.id])

      yield* jobs.heartbeat({ workerID: worker.id, leaseMs: 60_000 })
      expect(yield* store.expired()).toHaveLength(0)
    }),
  )

  it.effect("keeps artifacts and the ordered timeline", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const store = yield* JobStore.Service
      const job = yield* newJob()
      const worker = yield* jobs.createWorker({ jobID: job.id, role: "auditor", agent: "auditor", requested: model("mistral", "codestral") })

      yield* jobs.addArtifact({
        jobID: job.id,
        workerID: worker.id,
        type: "finding",
        name: "findings.json",
        content: '{"findings":[]}',
        mime: "application/json",
      })
      const artifacts = yield* store.artifacts(job.id)
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0].type).toBe("finding")
      expect(artifacts[0].workerID).toBe(worker.id)

      expect((yield* store.timeline(job.id)).map((event) => event.type)).toEqual([
        "job.created",
        "job.worker.created",
        "job.artifact.added",
      ])
    }),
  )
})

describe("Job projections", () => {
  it.effect("are rebuilt exactly by replaying the ledger", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const store = yield* JobStore.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service

      // A job with enough shape that a lost column would show.
      const job = yield* newJob()
      yield* jobs.transition({ jobID: job.id, to: "planning" })
      const step = yield* jobs.addStep({ jobID: job.id, name: "scouts" })
      const worker = yield* jobs.createWorker({
        jobID: job.id,
        role: "scout-backend",
        agent: "scout",
        requested: model("mistral", "codestral"),
        stepID: step.id,
      })
      const attempt = yield* jobs.startAttempt({ workerID: worker.id, requested: model("mistral", "codestral") })
      yield* jobs.resolveModel({
        attemptID: attempt.id,
        workerID: worker.id,
        requested: model("mistral", "codestral"),
        resolved: model("mistral", "codestral"),
      })
      yield* jobs.settleAttempt({
        attemptID: attempt.id,
        workerID: worker.id,
        status: "completed",
        exitReason: "success",
        usage: { tokensInput: 500, tokensOutput: 100, tokensCached: 0, cost: 0.01 },
      })
      yield* jobs.workerStatus({ workerID: worker.id, to: "completed" })
      yield* jobs.settleStep({ jobID: job.id, stepID: step.id, status: "completed" })
      yield* jobs.addArtifact({ jobID: job.id, type: "report", name: "summary.md", content: "# Summary" })
      yield* jobs.transition({ jobID: job.id, to: "queued" })
      yield* jobs.transition({ jobID: job.id, to: "running" })
      yield* jobs.settle({ jobID: job.id, status: "completed", result: "done" })

      const before = {
        job: yield* store.get(job.id),
        steps: yield* store.steps(job.id),
        workers: yield* store.workers(job.id),
        attempts: yield* store.attempts(worker.id),
        artifacts: yield* store.artifacts(job.id),
      }

      // Drop the projections and nothing else. An earlier version of this test
      // deleted the ledger too and fed the serialized events back in, which
      // proved the handlers deterministic and said nothing about the claim the
      // design rests on — that a projection can be rebuilt from a ledger that is
      // still there. It passed while that was impossible.
      for (const table of [
        JobVerificationTable,
        JobArtifactTable,
        JobAttemptTable,
        JobWorkerTable,
        JobStepTable,
        JobTable,
      ])
        yield* db.delete(table).run().pipe(Effect.orDie)
      expect(yield* store.get(job.id)).toBeUndefined()
      // The ledger is untouched, which is the point.
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).not.toHaveLength(0)

      yield* events.rebuild(job.id)

      expect(yield* store.get(job.id)).toEqual(before.job)
      expect(yield* store.steps(job.id)).toEqual(before.steps)
      expect(yield* store.workers(job.id)).toEqual(before.workers)
      expect(yield* store.attempts(worker.id)).toEqual(before.attempts)
      expect(yield* store.artifacts(job.id)).toEqual(before.artifacts)

      // And again over the rebuilt tables, without clearing them. This is what
      // "handlers are idempotent" actually asserts, and the case the clearing
      // version above cannot reach: starting from empty, an accumulating
      // handler adds each amount once and looks correct. Run it a second time
      // over rows that already hold the total and a running sum doubles it.
      yield* events.rebuild(job.id)
      expect(yield* store.get(job.id)).toEqual(before.job)
      expect(yield* store.workers(job.id)).toEqual(before.workers)
      expect(yield* store.attempts(worker.id)).toEqual(before.attempts)
    }),
  )
})

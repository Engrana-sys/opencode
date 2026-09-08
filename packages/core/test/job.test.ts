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

      const ledger = yield* db.select().from(EventTable).orderBy(asc(EventTable.seq)).all().pipe(Effect.orDie)

      // Wipe both the projections and the ledger rows, then feed the serialized
      // events back in. Projections are a pure function of the ledger, so what
      // comes back must be identical down to the column.
      for (const table of [JobArtifactTable, JobAttemptTable, JobWorkerTable, JobStepTable, JobTable])
        yield* db.delete(table).run().pipe(Effect.orDie)
      yield* db.delete(EventTable).run().pipe(Effect.orDie)
      yield* db.delete(EventSequenceTable).run().pipe(Effect.orDie)
      expect(yield* store.get(job.id)).toBeUndefined()

      yield* events.replayAll(
        ledger.map((row) => ({
          id: row.id,
          type: row.type,
          seq: row.seq,
          aggregateID: row.aggregate_id,
          data: row.data,
        })),
        { publish: false },
      )

      expect(yield* store.get(job.id)).toEqual(before.job)
      expect(yield* store.steps(job.id)).toEqual(before.steps)
      expect(yield* store.workers(job.id)).toEqual(before.workers)
      expect(yield* store.attempts(worker.id)).toEqual(before.attempts)
      expect(yield* store.artifacts(job.id)).toEqual(before.artifacts)
    }),
  )
})

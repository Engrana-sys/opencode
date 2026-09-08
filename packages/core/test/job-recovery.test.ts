import { describe, expect } from "bun:test"
import { Duration, Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Job } from "@opencode-ai/schema/job"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { JobV2 } from "@opencode-ai/core/job"
import { JobProjector } from "@opencode-ai/core/job/projector"
import { JobRecovery } from "@opencode-ai/core/job/recovery"
import { JobRetry } from "@opencode-ai/core/job/retry"
import { JobStore } from "@opencode-ai/core/job/store"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      JobProjector.node,
      JobStore.node,
      JobV2.node,
      JobRecovery.node,
    ]),
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
    title: "audit",
    objective: "audit the thing",
    type: "audit",
    requestedBy: "user",
  })
})

const model = (providerID: string, modelID: string): Job.ModelRef => ({ providerID, modelID })

const worktree: Job.Worktree = {
  repo: "/project",
  baseRef: "dev",
  baseSha: "abc123",
  branch: "job/fixer-1",
  directory: "/worktrees/job-1/fixer-1",
}

describe("JobRetry.decide", () => {
  const fixed = () => 1

  it.effect("retries a transient failure and backs off further each time", () =>
    Effect.sync(() => {
      const first = JobRetry.decide({ exitReason: "provider_unavailable", attempts: 1, random: fixed })
      const second = JobRetry.decide({ exitReason: "provider_unavailable", attempts: 2, random: fixed })
      expect(first._tag).toBe("Retry")
      expect(second._tag).toBe("Retry")
      if (first._tag !== "Retry" || second._tag !== "Retry") throw new Error("unreachable")
      expect(second.delay).toBeGreaterThan(first.delay)
    }),
  )

  it.effect("does not retry a decision", () =>
    Effect.sync(() => {
      // A denied permission fails identically forever; retrying only spends budget.
      for (const reason of ["permission_denied", "human_rejected", "sandbox_violation", "cancelled"] as const)
        expect(JobRetry.decide({ exitReason: reason, attempts: 1 })._tag).toBe("Stop")
    }),
  )

  it.effect("stops once the attempts are spent", () =>
    Effect.sync(() => {
      const decision = JobRetry.decide({ exitReason: "timeout", attempts: JobRetry.DEFAULT_MAX_ATTEMPTS })
      expect(decision._tag).toBe("Stop")
      expect(decision.reason).toContain("Exhausted")
    }),
  )

  it.effect("a rate limit waits the full window on its first retry", () =>
    Effect.sync(() => {
      const limited = JobRetry.decide({ exitReason: "rate_limited", attempts: 1, random: fixed })
      const ordinary = JobRetry.decide({ exitReason: "provider_unavailable", attempts: 1, random: fixed })
      if (limited._tag !== "Retry" || ordinary._tag !== "Retry") throw new Error("unreachable")
      // The provider already told us to wait; climbing the curve from the bottom
      // just reproduces the same rate limit.
      expect(limited.delay).toBeGreaterThan(ordinary.delay)
    }),
  )

  it.effect("jitter spreads simultaneous failures instead of stacking them", () =>
    Effect.sync(() => {
      const delays = new Set(
        Array.from({ length: 40 }, () => JobRetry.delay(3, JobRetry.defaultPolicy, Math.random)),
      )
      // Ten workers rate-limited at once must not all retry at the same instant.
      expect(delays.size).toBeGreaterThan(1)
    }),
  )

  it.effect("never waits longer than the ceiling", () =>
    Effect.sync(() => {
      expect(JobRetry.delay(50, JobRetry.defaultPolicy, () => 1)).toBe(JobRetry.MAX_DELAY)
    }),
  )
})

describe("JobRecovery", () => {
  it.effect("settles a worker whose process died before it heartbeated", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const store = yield* JobStore.Service
      const recovery = yield* JobRecovery.Service
      const job = yield* newJob()
      const worker = yield* jobs.createWorker({ jobID: job.id, role: "scout", agent: "scout", requested: model("mistral", "codestral") })
      yield* jobs.workerStatus({ workerID: worker.id, to: "running" })
      const attempt = yield* jobs.startAttempt({
        workerID: worker.id,
        requested: { providerID: "mistral", modelID: "codestral" },
      })
      // The transition granted a lease; what makes this worker abandoned is
      // that nothing renewed it, not that it never had one.
      yield* TestClock.adjust(Duration.millis(Job.LEASE_MS + 1))

      const outcomes = yield* recovery.scan()
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0].workerID).toBe(worker.id)
      // Nothing was written, so running it again costs nothing.
      expect(outcomes[0].disposition).toBe("retryable")

      expect((yield* store.worker(worker.id))?.status).toBe("stale")
      // The in-flight attempt gets an outcome instead of running forever.
      const settled = (yield* store.attempts(worker.id)).find((item) => item.id === attempt.id)
      expect(settled?.status).toBe("stale")
      expect(settled?.exitReason).toBe("stalled")
    }),
  )

  it.effect("a dead worker holding a worktree needs review, not a retry", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const recovery = yield* JobRecovery.Service
      const job = yield* newJob()
      const worker = yield* jobs.createWorker({ jobID: job.id, role: "fixer", agent: "fixer", requested: model("mistral", "codestral"), worktree })
      yield* jobs.workerStatus({ workerID: worker.id, to: "running" })
      yield* jobs.startAttempt({ workerID: worker.id, requested: { providerID: "mistral", modelID: "codestral" } })
      yield* TestClock.adjust(Duration.millis(Job.LEASE_MS + 1))

      const outcomes = yield* recovery.scan()
      // Re-running over a half-applied diff compounds the mess.
      expect(outcomes[0].disposition).toBe("needs_review")
      expect(outcomes[0].reason).toContain(worktree.directory)
    }),
  )

  it.effect("does not reclaim a worker in the gap before its first heartbeat", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const store = yield* JobStore.Service
      const recovery = yield* JobRecovery.Service
      const job = yield* newJob()
      const worker = yield* jobs.createWorker({ jobID: job.id, role: "scout", agent: "scout", requested: model("mistral", "codestral") })

      // The scheduler transitions a worker to `running` and only then starts
      // its heartbeat — two separate durable writes. A tick landing between
      // them must not find an abandoned worker, because the executor that owns
      // this one is starting right now.
      yield* jobs.workerStatus({ workerID: worker.id, to: "running" })

      expect(yield* recovery.scan()).toHaveLength(0)
      expect((yield* store.worker(worker.id))?.status).toBe("running")
    }),
  )

  it.effect("leaves a worker with a valid lease alone", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const store = yield* JobStore.Service
      const recovery = yield* JobRecovery.Service
      const job = yield* newJob()
      const worker = yield* jobs.createWorker({ jobID: job.id, role: "scout", agent: "scout", requested: model("mistral", "codestral") })
      yield* jobs.workerStatus({ workerID: worker.id, to: "running" })
      yield* jobs.heartbeat({ workerID: worker.id, leaseMs: 60_000 })

      expect(yield* recovery.scan()).toHaveLength(0)
      expect((yield* store.worker(worker.id))?.status).toBe("running")
    }),
  )

  it.effect("leaves queued and waiting work alone", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const store = yield* JobStore.Service
      const recovery = yield* JobRecovery.Service
      const job = yield* newJob()
      const waiting = yield* jobs.createWorker({
        jobID: job.id,
        role: "scout",
        agent: "scout",
        requested: model("mistral", "codestral"),
      })
      yield* jobs.workerStatus({ workerID: waiting.id, to: "queued" })
      const asking = yield* jobs.createWorker({
        jobID: job.id,
        role: "fixer",
        agent: "fixer",
        requested: model("mistral", "codestral"),
      })
      yield* jobs.workerStatus({ workerID: asking.id, to: "running" })
      yield* jobs.heartbeat({ workerID: asking.id, leaseMs: 60_000 })
      yield* jobs.workerStatus({ workerID: asking.id, to: "waiting_input" })

      // Neither is executing anything a dying process could abandon: one is
      // waiting for a slot, the other for a person who may answer tomorrow.
      expect(yield* recovery.scan()).toHaveLength(0)
      expect((yield* store.worker(waiting.id))?.status).toBe("queued")
      expect((yield* store.worker(asking.id))?.status).toBe("waiting_input")
    }),
  )

  it.effect("leaves finished work alone and is safe to run twice", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* JobV2.Service
      const recovery = yield* JobRecovery.Service
      const job = yield* newJob()
      const done = yield* jobs.createWorker({ jobID: job.id, role: "scout", agent: "scout", requested: model("mistral", "codestral") })
      yield* jobs.workerStatus({ workerID: done.id, to: "running" })
      yield* jobs.workerStatus({ workerID: done.id, to: "completed" })

      const dead = yield* jobs.createWorker({ jobID: job.id, role: "auditor", agent: "auditor", requested: model("mistral", "codestral") })
      yield* jobs.workerStatus({ workerID: dead.id, to: "running" })
      yield* TestClock.adjust(Duration.millis(Job.LEASE_MS + 1))

      expect((yield* recovery.scan()).map((outcome) => outcome.workerID)).toEqual([dead.id])
      // A second pass finds nothing: the first one settled everything it saw.
      expect(yield* recovery.scan()).toHaveLength(0)
    }),
  )
})

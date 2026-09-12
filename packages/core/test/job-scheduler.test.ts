import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { Job } from "@opencode-ai/schema/job"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { JobV2 } from "@opencode-ai/core/job"
import { JobExecutor } from "@opencode-ai/core/job/executor"
import { JobWorktree } from "@opencode-ai/core/job/worktree"
import { JobProjector } from "@opencode-ai/core/job/projector"
import { JobRecovery } from "@opencode-ai/core/job/recovery"
import { JobScheduler } from "@opencode-ai/core/job/scheduler"
import { JobStore } from "@opencode-ai/core/job/store"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"

/**
 * The scheduler is exercised with a fake executor: everything worth asserting
 * here is about slots, budgets and retries, none of which should need a model.
 */

const noUsage: Job.Usage = { tokensInput: 0, tokensOutput: 0, tokensCached: 0, cost: 0 }

/** Controls each attempt from the test: nothing finishes until it is released. */
const gates = new Map<Job.WorkerID, Deferred.Deferred<JobExecutor.Outcome>>()
const started: Job.WorkerID[] = []

const executor = JobExecutor.layerWith((input) =>
  Effect.gen(function* () {
    started.push(input.worker.id)
    const gate = gates.get(input.worker.id)
    if (!gate) return { exitReason: "success" as const, usage: noUsage }
    return yield* Deferred.await(gate)
  }),
)

/**
 * `tick` returns once a worker is claimed; the attempt itself starts inside the
 * worker's own fiber, so the scheduler can interrupt a worker that is still
 * provisioning its worktree. Tests that drive an attempt have to wait for it to
 * get that far rather than assuming `tick` did it on the way out.
 */
const running = (count: number) =>
  Effect.gen(function* () {
    for (let spin = 0; spin < 500 && started.length < count; spin++) yield* Effect.yieldNow
    if (started.length < count) throw new Error(`only ${started.length} of ${count} attempts started`)
  })

/**
 * Provisioning is where a worker spends seconds shelling out to git, and the
 * scheduler now does it inside the worker's own fiber. This stub holds that
 * window open so a test can act inside it.
 */
const provisioning = new Map<Job.WorkerID, Deferred.Deferred<void>>()
/** Workers whose `git worktree add` dies rather than returning a tree. */
const provisionFails = new Set<Job.WorkerID>()
const worktrees = Layer.succeed(
  JobWorktree.Service,
  JobWorktree.Service.of({
    provision: (input: { readonly workerID: Job.WorkerID }) =>
      Effect.gen(function* () {
        const gate = provisioning.get(input.workerID)
        if (gate) yield* Deferred.await(gate)
        if (provisionFails.has(input.workerID)) return yield* Effect.die(new Error("git worktree add failed"))
        return undefined
      }),
  } as unknown as JobWorktree.Interface),
)

const build = (limits: { global: number; perProject?: number; perProvider?: number; perModel?: number }) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      JobProjector.node,
      JobStore.node,
      JobV2.node,
      JobRecovery.node,
      JobScheduler.nodeWith(limits),
    ]),
    [
      [JobExecutor.node, executor],
      [JobWorktree.node, worktrees],
    ],
  )

const it = testEffect(build({ global: 2 }))

const setup = Effect.gen(function* () {
  started.length = 0
  gates.clear()
  provisioning.clear()
  provisionFails.clear()
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
})

const model: Job.ModelRef = { providerID: "mistral", modelID: "codestral" }

const newJob = Effect.fn("test.newJob")(function* (budget?: Job.Budget) {
  const jobs = yield* JobV2.Service
  return yield* jobs.create({
    projectID: Project.ID.global,
    directory: "/project",
    title: "audit",
    objective: "audit the thing",
    type: "audit",
    requestedBy: "user",
    ...(budget === undefined ? {} : { budget }),
  })
})

/** A worker queued and waiting on a gate the test controls. */
const queued = Effect.fn("test.queued")(function* (jobID: Job.ID, role: string, hold = true) {
  const jobs = yield* JobV2.Service
  const worker = yield* jobs.createWorker({ jobID, role, agent: "scout", requested: model })
  yield* jobs.workerStatus({ workerID: worker.id, to: "queued" })
  if (hold) gates.set(worker.id, yield* Deferred.make<JobExecutor.Outcome>())
  return worker
})

describe("JobScheduler", () => {
  it.effect("fills its slots and leaves the rest queued", () =>
    Effect.gen(function* () {
      yield* setup
      const scheduler = yield* JobScheduler.Service
      const store = yield* JobStore.Service
      const job = yield* newJob()
      const first = yield* queued(job.id, "a")
      const second = yield* queued(job.id, "b")
      const third = yield* queued(job.id, "c")

      expect(yield* scheduler.tick()).toHaveLength(2)
      expect((yield* store.worker(first.id))?.status).toBe("running")
      expect((yield* store.worker(second.id))?.status).toBe("running")
      expect((yield* store.worker(third.id))?.status).toBe("queued")
    }),
  )

  it.effect("takes a freed slot on the next pass without waiting for the batch", () =>
    Effect.gen(function* () {
      yield* setup
      const scheduler = yield* JobScheduler.Service
      const store = yield* JobStore.Service
      const job = yield* newJob()
      const first = yield* queued(job.id, "a")
      const second = yield* queued(job.id, "b")
      const third = yield* queued(job.id, "c")

      yield* scheduler.tick()
      yield* running(1)
      // One finishes while the other is still working: its slot is free now.
      yield* Deferred.succeed(gates.get(first.id)!, { exitReason: "success", usage: noUsage })
      yield* Effect.yieldNow
      yield* scheduler.tick()

      expect((yield* store.worker(first.id))?.status).toBe("completed")
      expect((yield* store.worker(second.id))?.status).toBe("running")
      expect((yield* store.worker(third.id))?.status).toBe("running")
    }),
  )

  it.effect("requeues a transient failure and gives up on a decision", () =>
    Effect.gen(function* () {
      yield* setup
      const scheduler = yield* JobScheduler.Service
      const store = yield* JobStore.Service
      const job = yield* newJob()
      const transient = yield* queued(job.id, "transient")
      const denied = yield* queued(job.id, "denied")

      yield* scheduler.tick()
      yield* running(1)
      yield* Deferred.succeed(gates.get(transient.id)!, {
        exitReason: "provider_unavailable",
        usage: noUsage,
        error: "connection reset",
      })
      yield* Deferred.succeed(gates.get(denied.id)!, { exitReason: "permission_denied", usage: noUsage })
      yield* Effect.yieldNow

      // Retrying is requeueing: the next tick competes for a slot like anything else.
      expect((yield* store.worker(transient.id))?.status).toBe("queued")
      // A denied permission fails the same way forever.
      expect((yield* store.worker(denied.id))?.status).toBe("failed")
      expect((yield* store.attempts(transient.id))[0].exitReason).toBe("provider_unavailable")
    }),
  )

  it.effect("holds a requeued worker inside its backoff", () =>
    Effect.gen(function* () {
      yield* setup
      const scheduler = yield* JobScheduler.Service
      const store = yield* JobStore.Service
      const worker = yield* queued((yield* newJob()).id, "flaky")

      yield* scheduler.tick()
      yield* running(1)
      yield* Deferred.succeed(gates.get(worker.id)!, { exitReason: "rate_limited", usage: noUsage })
      yield* Effect.yieldNow

      const requeued = yield* store.worker(worker.id)
      expect(requeued?.status).toBe("queued")
      // Without a durable backoff the next tick would retry immediately and burn
      // all three attempts in one pass — which is what a rate limit least needs.
      expect(requeued?.retryAfter).toBeDefined()
      expect(yield* scheduler.tick()).toHaveLength(0)
      expect((yield* store.attempts(worker.id))).toHaveLength(1)
    }),
  )

  it.effect("records the model that answered when the executor reports one", () =>
    Effect.gen(function* () {
      yield* setup
      const scheduler = yield* JobScheduler.Service
      const store = yield* JobStore.Service
      const job = yield* newJob()
      const worker = yield* queued(job.id, "auditor")

      yield* scheduler.tick()
      yield* running(1)
      yield* Deferred.succeed(gates.get(worker.id)!, {
        exitReason: "success",
        usage: noUsage,
        resolved: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
      })
      yield* Effect.yieldNow

      const attempt = (yield* store.attempts(worker.id))[0]
      expect(attempt.requested).toEqual(model)
      expect(attempt.resolved).toEqual({ providerID: "anthropic", modelID: "claude-haiku-4-5" })
    }),
  )

  it.effect("holds a lease for the worker it started", () =>
    Effect.gen(function* () {
      yield* setup
      const scheduler = yield* JobScheduler.Service
      const store = yield* JobStore.Service
      const job = yield* newJob()
      const worker = yield* queued(job.id, "scout")

      yield* scheduler.tick()
      // Without this the recovery scan would reclaim work that is running fine.
      expect((yield* store.worker(worker.id))?.leaseUntil).toBeDefined()
      expect(yield* store.expired()).toHaveLength(0)
    }),
  )

  it.effect("settles a job whose budget is spent instead of admitting more", () =>
    Effect.gen(function* () {
      yield* setup
      const scheduler = yield* JobScheduler.Service
      const store = yield* JobStore.Service
      const jobs = yield* JobV2.Service
      const job = yield* newJob({ maxWorkers: 1 })
      yield* queued(job.id, "a")
      yield* queued(job.id, "b")
      yield* jobs.transition({ jobID: job.id, to: "queued" })

      // Two workers exist against a budget of one, so the job is over before
      // anything runs. A budget that only warned here would let it run anyway.
      expect(yield* scheduler.tick()).toHaveLength(0)
      const settled = yield* store.get(job.id)
      expect(settled?.status).toBe("failed")
      expect(settled?.error).toContain("workers")
    }),
  )

  it.effect("stops the work a spent budget settled, not only the ledger entry", () =>
    Effect.gen(function* () {
      yield* setup
      const scheduler = yield* JobScheduler.Service
      const store = yield* JobStore.Service
      const job = yield* newJob({ maxCost: 1 })
      const spender = yield* queued(job.id, "spender")
      const bystander = yield* queued(job.id, "bystander")

      yield* scheduler.tick()
      // Both, not just the spender: the point of the test is that the bystander
      // is mid-attempt when the budget blows, so its attempt has to exist.
      yield* running(2)
      yield* Deferred.succeed(gates.get(spender.id)!, {
        exitReason: "success",
        usage: { ...noUsage, cost: 2 },
      })
      yield* Effect.yieldNow

      // The budget is blown by the first worker while the second is mid-attempt.
      // Settling only the job would leave that one calling the provider, and
      // renewing the lease that keeps recovery away from it, on a job the ledger
      // already records as failed.
      yield* scheduler.tick()
      expect((yield* store.get(job.id))?.status).toBe("failed")
      expect((yield* store.worker(bystander.id))?.status).toBe("cancelled")
      expect((yield* store.attempts(bystander.id))[0].status).toBe("cancelled")
    }),
  )

  it.effect("keeps counting the running workers of a job that settled under them", () =>
    Effect.gen(function* () {
      yield* setup
      const scheduler = yield* JobScheduler.Service
      const jobs = yield* JobV2.Service
      const abandoned = yield* newJob()
      yield* queued(abandoned.id, "a")
      yield* queued(abandoned.id, "b")
      expect(yield* scheduler.tick()).toHaveLength(2)
      yield* running(2)

      // Cancelling the job does not stop the two attempts already in flight, so
      // their slots are still taken. Reading occupancy from the eligible jobs
      // alone would hand them out twice and run four workers against a two.
      yield* jobs.settle({ jobID: abandoned.id, status: "cancelled" })
      yield* queued((yield* newJob()).id, "c")

      expect(yield* scheduler.tick()).toHaveLength(0)
      expect(started).toHaveLength(2)
    }),
  )

  it.effect("ignores workers of a job that already settled", () =>
    Effect.gen(function* () {
      yield* setup
      const scheduler = yield* JobScheduler.Service
      const jobs = yield* JobV2.Service
      const job = yield* newJob()
      yield* queued(job.id, "a")
      yield* jobs.transition({ jobID: job.id, to: "queued" })
      yield* jobs.settle({ jobID: job.id, status: "cancelled" })

      expect(yield* scheduler.tick()).toHaveLength(0)
      expect(started).toHaveLength(0)
    }),
  )
})

describe("JobScheduler limits", () => {
  const it = testEffect(build({ global: 10, perModel: 1 }))

  it.effect("respects a per-model ceiling across jobs", () =>
    Effect.gen(function* () {
      yield* setup
      const scheduler = yield* JobScheduler.Service
      const first = yield* newJob()
      const second = yield* newJob()
      yield* queued(first.id, "a")
      yield* queued(second.id, "b")

      // Both want the same model, and only one of it may run at a time.
      expect(yield* scheduler.tick()).toHaveLength(1)
    }),
  )

  it.effect("a worker still provisioning when the budget blows never starts an attempt", () =>
    Effect.gen(function* () {
      yield* setup
      const scheduler = yield* JobScheduler.Service
      const store = yield* JobStore.Service
      const job = yield* newJob({ maxCost: 1 })
      const spender = yield* queued(job.id, "spender")
      const slow = yield* queued(job.id, "slow")
      provisioning.set(slow.id, yield* Deferred.make<void>())

      yield* scheduler.tick()
      yield* running(1)
      yield* Deferred.succeed(gates.get(spender.id)!, { exitReason: "success", usage: { ...noUsage, cost: 2 } })
      yield* Effect.yieldNow

      // The second worker is claimed and `running` but still inside git when the
      // budget blows. It must not go on to open an attempt and keep spending on
      // a job the ledger has already failed. This pins the end state; what makes
      // `halt` able to reach such a worker at all is that it is registered in
      // `fibers` before provisioning starts, which no assertion here can see.
      yield* scheduler.tick()
      yield* Deferred.succeed(provisioning.get(slow.id)!, undefined)
      for (let spin = 0; spin < 200; spin++) yield* Effect.yieldNow

      expect((yield* store.get(job.id))?.status).toBe("failed")
      expect(yield* store.attempts(slow.id)).toHaveLength(0)
      expect(started).not.toContain(slow.id)
    }),
  )

  it.effect("returns a worker that stopped before its attempt to the queue", () =>
    Effect.gen(function* () {
      yield* setup
      const scheduler = yield* JobScheduler.Service
      const store = yield* JobStore.Service
      const job = yield* newJob()
      const worker = yield* queued(job.id, "fixer")
      provisioning.set(worker.id, yield* Deferred.make<void>())
      provisionFails.add(worker.id)

      yield* scheduler.tick()
      expect((yield* store.worker(worker.id))?.status).toBe("running")

      // Provisioning dies rather than returning a tree. Leaving the worker
      // `running` with no attempt is what recovery reads as stalled, and stale
      // is terminal — so a transient git failure at startup would lose the
      // worker for good instead of costing it one pass through the queue.
      yield* Deferred.succeed(provisioning.get(worker.id)!, undefined)
      for (let spin = 0; spin < 200; spin++) yield* Effect.yieldNow

      expect((yield* store.worker(worker.id))?.status).toBe("queued")
      expect(yield* store.attempts(worker.id)).toHaveLength(0)
    }),
  )
})

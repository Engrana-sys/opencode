export * as JobScheduler from "./scheduler"

import { Context, DateTime, Effect, Fiber, FiberSet, Layer, Schedule } from "effect"
import { Job } from "@opencode-ai/schema/job"
import { makeGlobalNode } from "../effect/app-node"
import { JobV2 } from "../job"
import { JobAdmission } from "./admission"
import { JobBudget } from "./budget"
import { JobExecutor } from "./executor"
import { JobRecovery } from "./recovery"
import { JobRetry } from "./retry"
import { JobStore } from "./store"
import { JobWorktree } from "./worktree"

/**
 * Runs queued workers.
 *
 * The decisions live in four pure modules — admission, retry, budget, recovery.
 * This is only the loop that asks them in the right order and records what they
 * decide. Keeping it thin is deliberate: everything worth arguing about is
 * testable without a clock or a provider, and what remains here is plumbing.
 *
 * Order within a tick matters. Recovery runs first so abandoned work is settled
 * before its slots are handed to anything new; budgets are checked next so an
 * exhausted job cannot admit more work on its way out; only then is the queue
 * considered.
 *
 * @module
 */

/** The periodic tick is a safety net; finishing work wakes the loop directly. */
const TICK = "5 seconds"
/**
 * Re-exported from the schema, where the projection also reads it: the first
 * lease is granted by the `running` transition, so the two must agree.
 */
export const LEASE_MS = Job.LEASE_MS
export const HEARTBEAT_MS = 30_000

export interface Interface {
  /** One pass: recover, enforce budgets, admit what fits. Returns what it started. */
  readonly tick: () => Effect.Effect<ReadonlyArray<Job.WorkerID>>
  readonly limits: JobAdmission.Limits
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/JobScheduler") {}

const layer = (limits: JobAdmission.Limits) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const store = yield* JobStore.Service
      const jobs = yield* JobV2.Service
      const recovery = yield* JobRecovery.Service
      const executor = yield* JobExecutor.Service
      const worktrees = yield* JobWorktree.Service
      const workers = yield* FiberSet.make<void>()
      // Keyed by worker because a job that must stop has to reach its own
      // attempts, and the set alone cannot name one of them.
      const fibers = new Map<Job.WorkerID, Fiber.Fiber<void>>()
      // Assigned once `tick` exists below. A finished worker wakes the loop
      // through this so its slot is taken now rather than at the next tick;
      // suspending defers reading it until there is something to read.
      let loop: Effect.Effect<unknown> = Effect.void
      const wake = Effect.suspend(() => loop).pipe(Effect.ignore, Effect.forkDetach, Effect.asVoid)

      /**
       * Keeps a worker's lease alive while its attempt runs, inside the
       * attempt's own scope. When the attempt ends the scope closes and the
       * heartbeat stops with it, so a lease can never outlive the work it
       * vouches for — which is the whole reason recovery can trust it.
       */
      const beating = <A>(workerID: Job.WorkerID, work: Effect.Effect<A>) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* jobs
              .heartbeat({ workerID, leaseMs: LEASE_MS })
              .pipe(Effect.ignore, Effect.repeat(Schedule.spaced(HEARTBEAT_MS)), Effect.forkScoped)
            return yield* work
          }),
        )

      const settle = Effect.fn("JobScheduler.settle")(function* (
        candidate: { readonly workerID: Job.WorkerID; readonly attempt: Job.Attempt },
        outcome: JobExecutor.Outcome,
      ) {
        const succeeded = outcome.exitReason === "success"
        if (outcome.resolved)
          yield* jobs
            .resolveModel({
              attemptID: candidate.attempt.id,
              workerID: candidate.workerID,
              requested: candidate.attempt.requested,
              resolved: outcome.resolved,
            })
            .pipe(Effect.ignore)
        yield* jobs
          .settleAttempt({
            attemptID: candidate.attempt.id,
            workerID: candidate.workerID,
            status: succeeded ? "completed" : "failed",
            exitReason: outcome.exitReason,
            usage: outcome.usage,
            ...(outcome.error === undefined ? {} : { error: outcome.error }),
          })
          .pipe(Effect.ignore)
        if (succeeded) {
          yield* jobs.workerStatus({ workerID: candidate.workerID, to: "completed" }).pipe(Effect.ignore)
          return
        }
        const decision = JobRetry.decide({
          exitReason: outcome.exitReason,
          attempts: (yield* store.attempts(candidate.workerID)).length,
        })
        // Requeueing is the retry: the next tick starts a fresh attempt, so a
        // retry competes for a slot like any other work rather than holding one.
        // The backoff rides along as a durable `retryAfter`; sleeping here
        // instead would hold a slot and would be forgotten on restart.
        yield* jobs
          .workerStatus({
            workerID: candidate.workerID,
            to: decision._tag === "Retry" ? "queued" : "failed",
            reason: decision.reason,
            ...(decision._tag === "Retry" ? { retryAfterMs: decision.delay } : {}),
          })
          .pipe(Effect.ignore)
      })

      const start = Effect.fn("JobScheduler.start")(function* (input: {
        readonly job: Job.Info
        readonly worker: Job.Worker
      }) {
        // Claiming comes first, and it is a claim rather than a notification:
        // ticks overlap, because finishing work forks one on top of the periodic
        // one. Whoever moves the worker out of `queued` owns it, and everyone
        // else stops here instead of opening a second attempt against the one
        // lease and the one worktree. The transition also grants that lease, so
        // there is no window where the worker reads `running` with none and
        // recovery can reclaim it out from under us.
        if (!(yield* jobs.workerStatus({ workerID: input.worker.id, to: "running" }))) return undefined

        /**
         * Everything after the claim runs inside the forked fiber.
         *
         * Provisioning a worktree shells out to git and takes seconds. Doing it
         * out here left the worker reading `running` with no entry in `fibers`
         * for all of that, and `halt` interrupts by fiber — so a job whose
         * budget ran out could not stop a worker that had not finished starting,
         * and the budget went back to being advisory. Forking first makes the
         * gap a single synchronous step with nothing to suspend on.
         */
        const work = Effect.gen(function* () {
          // Provisioned on admission rather than on creation: a worker that
          // never runs should leave no checkout behind. A worker that already
          // holds one keeps it, so a retry resumes in the tree its previous
          // attempt used.
          let worktree = input.worker.worktree
          if (worktree === undefined) {
            const provisioned = yield* worktrees.provision({
              job: input.job,
              workerID: input.worker.id,
              role: input.worker.role,
            })
            if (provisioned) {
              yield* jobs.assignWorktree({ workerID: input.worker.id, worktree: provisioned })
              worktree = provisioned
            }
          }
          // Re-read the claim. Provisioning is long enough for `halt` to settle
          // this job or for recovery to declare the worker stale, and starting
          // an attempt afterwards would run work the ledger has already
          // accounted for as stopped.
          const current = yield* store.worker(input.worker.id)
          if (!current || current.status !== "running") return
          const attempt = yield* jobs.startAttempt({
            workerID: input.worker.id,
            requested: input.worker.requested,
          })
          // Carried explicitly: `input.worker` was read before the tree existed,
          // and handing the executor that stale copy is how a worker ends up
          // working outside the tree the ledger says it owns.
          const worker = worktree === undefined ? input.worker : { ...input.worker, worktree }
          const outcome = yield* beating(input.worker.id, executor.run({ job: input.job, worker, attempt }))
          yield* settle({ workerID: input.worker.id, attempt }, outcome)
        })

        const fiber = yield* work.pipe(
          /**
           * A worker that stopped before it had an attempt goes back to the
           * queue rather than staying `running` and empty.
           *
           * Interrupting `git worktree add` used to strand it: recovery finds a
           * `running` worker with no attempt, calls that stalled, and `stale` is
           * terminal — so a transient failure during startup lost the worker
           * permanently, where the old ordering simply left it queued to be
           * re-admitted. `halt` settles the worker itself, and a terminal status
           * is what tells this apart from a startup that merely failed.
           */
          Effect.onExit(() =>
            Effect.gen(function* () {
              const current = yield* store.worker(input.worker.id)
              if (!current || Job.isWorkerTerminal(current.status)) return
              if ((yield* store.attempts(input.worker.id)).length > 0) return
              yield* jobs
                .workerStatus({ workerID: input.worker.id, to: "queued", reason: "Stopped before an attempt began" })
                .pipe(Effect.ignore)
            }),
          ),
          Effect.ensuring(Effect.sync(() => fibers.delete(input.worker.id))),
          // A slot freed now must be taken now, not at the next tick.
          Effect.ensuring(wake),
          Effect.ignore,
          FiberSet.run(workers),
        )
        fibers.set(input.worker.id, fiber)
        return input.worker.id
      })

      /**
       * Stops a settled job's work, not only its ledger entry.
       *
       * A budget that recorded exhaustion and left the fibers alone would be
       * advisory: the attempts keep calling the provider, keep renewing their
       * leases so recovery never sees them, and roll their usage into a job
       * that is already over. Interrupting first ends the attempt's own
       * settlement before it can race this one, and the heartbeat dies with the
       * scope, so nothing is left vouching for work that has stopped.
       */
      const halt = Effect.fn("JobScheduler.halt")(function* (jobID: Job.ID, reason: string) {
        for (const worker of yield* store.workers(jobID)) {
          if (Job.isWorkerTerminal(worker.status)) continue
          const fiber = fibers.get(worker.id)
          if (fiber) yield* Fiber.interrupt(fiber)
          // An interrupted attempt never reaches its own settlement, so it
          // would otherwise stay `running` under a job that is finished.
          for (const attempt of yield* store.attempts(worker.id)) {
            if (Job.isAttemptSettled(attempt.status)) continue
            yield* jobs
              .settleAttempt({
                attemptID: attempt.id,
                workerID: worker.id,
                status: "cancelled",
                exitReason: "cancelled",
                error: reason,
              })
              .pipe(Effect.ignore)
          }
          // Queued workers stop here too: nothing may start under a job the
          // ledger has already settled, and one left queued is never surfaced
          // by `JobStore.live` again.
          yield* jobs.workerStatus({ workerID: worker.id, to: "cancelled", reason }).pipe(Effect.ignore)
        }
      })

      const tick: Interface["tick"] = Effect.fn("JobScheduler.tick")(function* () {
        yield* recovery.scan()

        const live = yield* store.live()
        const eligible: Job.Info[] = []
        for (const job of live) {
          const verdict = JobBudget.evaluate({
            ...(job.budget === undefined ? {} : { budget: job.budget }),
            spend: {
              usage: job.usage,
              workers: (yield* store.workers(job.id)).length,
              elapsedMs: job.timeStarted
                ? DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(job.timeStarted)
                : 0,
            },
          })
          if (!JobBudget.isExhausted(verdict)) {
            eligible.push(job)
            continue
          }
          // Budgets settle work rather than warning about it.
          const reason = JobBudget.describe(verdict)
          yield* jobs.settle({ jobID: job.id, status: "failed", error: reason }).pipe(Effect.ignore)
          yield* halt(job.id, reason)
        }

        const candidates: JobAdmission.Candidate[] = []
        // Occupancy is read from the database, not a counter in memory, so it
        // survives a restart and agrees with what recovery sees. It counts every
        // worker that reads `running`, not only those of the jobs still eligible:
        // a worker whose job settled or blew its budget underneath it keeps its
        // fiber, its lease and its spend, so it keeps its slot until it stops.
        const running: JobAdmission.Running[] = (yield* store.running()).map((entry) => ({
          projectID: entry.projectID,
          providerID: entry.worker.requested.providerID,
          modelID: entry.worker.requested.modelID,
        }))
        const byJob = new Map<Job.ID, Job.Info>()
        const now = yield* DateTime.now
        for (const job of eligible) {
          byJob.set(job.id, job)
          for (const worker of yield* store.workers(job.id)) {
            // A worker still inside its backoff is queued but not yet eligible.
            const waiting =
              worker.retryAfter !== undefined &&
              DateTime.toEpochMillis(worker.retryAfter) > DateTime.toEpochMillis(now)
            if (worker.status === "queued" && !waiting)
              candidates.push({
                workerID: worker.id,
                jobID: job.id,
                projectID: job.projectID,
                requested: worker.requested,
                enqueuedAt: DateTime.toEpochMillis(worker.timeCreated),
              })
          }
        }

        const started: Job.WorkerID[] = []
        for (const admitted of JobAdmission.admit({ candidates, running, limits })) {
          const job = byJob.get(admitted.jobID)
          const worker = yield* store.worker(admitted.workerID)
          if (!job || !worker) continue
          // `undefined` means another tick claimed this worker first, so it is
          // not one of ours to report as started.
          const claimed = yield* start({ job, worker }).pipe(Effect.orElseSucceed(() => admitted.workerID))
          if (claimed !== undefined) started.push(claimed)
        }
        return started
      })

      loop = tick()
      return Service.of({ tick, limits })
    }),
  )

export const node = makeGlobalNode({
  service: Service,
  layer: layer(JobAdmission.defaultLimits),
  deps: [JobStore.node, JobV2.node, JobRecovery.node, JobExecutor.node, JobWorktree.node],
})

/** Test seam: a scheduler with limits of the caller's choosing. */
export const nodeWith = (limits: JobAdmission.Limits) =>
  makeGlobalNode({
    service: Service,
    layer: layer(limits),
    deps: [JobStore.node, JobV2.node, JobRecovery.node, JobExecutor.node, JobWorktree.node],
  })

/**
 * Drives the scheduler in the background.
 *
 * Separate from the service so a test can tick deliberately instead of racing a
 * timer, and so a process that only reads jobs need not run a loop at all.
 */
export const daemon = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Service
    yield* scheduler
      .tick()
      .pipe(
        Effect.catchCause((cause) => Effect.logWarning("Job scheduler tick failed", cause)),
        Effect.repeat(Schedule.spaced(TICK)),
        Effect.forkScoped,
      )
  }),
)

export const daemonNode = makeGlobalNode({ name: "job-scheduler-daemon", layer: daemon, deps: [node] })

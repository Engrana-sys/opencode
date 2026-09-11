export * as JobV2 from "./job"

import { eq } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Job } from "@opencode-ai/schema/job"
import { JobEvent } from "@opencode-ai/schema/job-event"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { Capability } from "./permission/capability"
import { EventV2 } from "./event"
import { JobStore } from "./job/store"
import { JobWorkerLeaseTable } from "./job/sql"
import type { JobVerification } from "@opencode-ai/schema/job-verification"
import type { Permission } from "@opencode-ai/schema/permission"
import type { ProjectV2 } from "./project"
import type { SessionSchema } from "./session/schema"

/**
 * Durable work.
 *
 * Every operation here appends to the ledger and returns; none of them writes a
 * projection. That is the whole discipline of this module: if a fact is not an
 * event, it does not exist, and a projection that disagrees with the ledger is
 * the projection's bug.
 *
 * Transitions are validated before they are recorded. An illegal move fails
 * rather than being written and reconciled later, because a ledger containing
 * impossible history is worse than no ledger.
 *
 * @module
 */

export const ID = Job.ID
export type ID = Job.ID
export const Info = Job.Info
export type Info = Job.Info
export const Event = JobEvent

/**
 * How deep a worker tree may go.
 *
 * A planner spawning scouts that spawn helpers is the intended shape; anything
 * deeper is usually a worker that failed to decompose and is recursing instead.
 */
export const MAX_DEPTH = 4
export const MAX_WORKERS = 64

export class JobNotFoundError extends Schema.TaggedErrorClass<JobNotFoundError>()("Job.NotFoundError", {
  jobID: Job.ID,
}) {
  override get message() {
    return `Job not found: ${this.jobID}`
  }
}

export class WorkerNotFoundError extends Schema.TaggedErrorClass<WorkerNotFoundError>()("Job.WorkerNotFoundError", {
  workerID: Job.WorkerID,
}) {
  override get message() {
    return `Worker not found: ${this.workerID}`
  }
}

export class InvalidTransitionError extends Schema.TaggedErrorClass<InvalidTransitionError>()(
  "Job.InvalidTransitionError",
  { jobID: Job.ID, from: Job.Status, to: Job.Status },
) {
  override get message() {
    return `Job ${this.jobID} cannot move from ${this.from} to ${this.to}`
  }
}

export class InvalidWorkerTransitionError extends Schema.TaggedErrorClass<InvalidWorkerTransitionError>()(
  "Job.InvalidWorkerTransitionError",
  { workerID: Job.WorkerID, from: Job.WorkerStatus, to: Job.WorkerStatus },
) {
  override get message() {
    return `Worker ${this.workerID} cannot move from ${this.from} to ${this.to}`
  }
}

export class AttemptSettledError extends Schema.TaggedErrorClass<AttemptSettledError>()("Job.AttemptSettledError", {
  attemptID: Job.AttemptID,
  status: Job.AttemptStatus,
}) {
  override get message() {
    return `Attempt ${this.attemptID} is already ${this.status}`
  }
}

export class TreeLimitError extends Schema.TaggedErrorClass<TreeLimitError>()("Job.TreeLimitError", {
  jobID: Job.ID,
  limit: Schema.String,
}) {
  override get message() {
    return `Job ${this.jobID} exceeded its ${this.limit} limit`
  }
}

export type Error =
  | JobNotFoundError
  | WorkerNotFoundError
  | InvalidTransitionError
  | InvalidWorkerTransitionError
  | AttemptSettledError
  | TreeLimitError

export interface Interface {
  readonly create: (input: {
    readonly projectID: ProjectV2.ID
    readonly directory: string
    readonly title: string
    readonly objective: string
    readonly type: string
    readonly requestedBy: string
    readonly baseRef?: string
    readonly budget?: Job.Budget
    readonly sessionID?: SessionSchema.ID
  }) => Effect.Effect<Job.Info>

  /** Moves a job between live states. Terminal states go through `settle`. */
  readonly transition: (input: {
    readonly jobID: Job.ID
    readonly to: Job.Status
    readonly stage?: string
    readonly reason?: string
  }) => Effect.Effect<Job.Info, JobNotFoundError | InvalidTransitionError>

  readonly settle: (input: {
    readonly jobID: Job.ID
    readonly status: "completed" | "failed" | "cancelled"
    readonly result?: string
    readonly error?: string
  }) => Effect.Effect<Job.Info, JobNotFoundError | InvalidTransitionError>

  readonly addStep: (input: {
    readonly jobID: Job.ID
    readonly name: string
  }) => Effect.Effect<Job.Step, JobNotFoundError>

  readonly settleStep: (input: {
    readonly jobID: Job.ID
    readonly stepID: Job.StepID
    readonly status: Job.Status
  }) => Effect.Effect<void, JobNotFoundError>

  readonly createWorker: (input: {
    readonly jobID: Job.ID
    readonly role: string
    readonly agent: string
    /** The model this worker is spawned to use; concurrency limits read it before any attempt exists. */
    readonly requested: Job.ModelRef
    /**
     * What this worker's agent asks for. It is clamped against the parent's
     * effective set before being stored, so asking for more than the parent
     * holds grants nothing.
     */
    readonly permissions?: Permission.Ruleset
    readonly stepID?: Job.StepID
    readonly parentID?: Job.WorkerID
    readonly worktree?: Job.Worktree
  }) => Effect.Effect<Job.Worker, JobNotFoundError | WorkerNotFoundError | TreeLimitError>

  /**
   * Moves a worker, and says whether this caller is the one that moved it.
   *
   * `false` means the worker was already there — someone else got to it first.
   * A caller that acts on the transition rather than merely recording it has to
   * know the difference: two schedulers racing for one queued worker both see a
   * successful call otherwise, and both start an attempt.
   */
  readonly workerStatus: (input: {
    readonly workerID: Job.WorkerID
    readonly to: Job.WorkerStatus
    readonly reason?: string
    /** Backoff before a requeued worker may be admitted again. */
    readonly retryAfterMs?: number
  }) => Effect.Effect<boolean, WorkerNotFoundError | InvalidWorkerTransitionError>

  /** Records the tree a writing worker was given, once it is admitted to run. */
  readonly assignWorktree: (input: {
    readonly workerID: Job.WorkerID
    readonly worktree: Job.Worktree
  }) => Effect.Effect<void, WorkerNotFoundError>

  /** Renews a worker's lease. Silence here is what recovery reads as abandonment. */
  readonly heartbeat: (input: {
    readonly workerID: Job.WorkerID
    readonly leaseMs: number
  }) => Effect.Effect<void, WorkerNotFoundError>

  readonly startAttempt: (input: {
    readonly workerID: Job.WorkerID
    readonly requested: Job.ModelRef
    readonly sessionID?: SessionSchema.ID
    readonly retryReason?: string
  }) => Effect.Effect<Job.Attempt, WorkerNotFoundError>

  /**
   * Records the model that actually answered. Emitted even when it matches the
   * request, so an attempt with no such event is one that never reached a model.
   */
  readonly resolveModel: (input: {
    readonly attemptID: Job.AttemptID
    readonly workerID: Job.WorkerID
    readonly requested: Job.ModelRef
    readonly resolved: Job.ModelRef
    readonly reason?: string
  }) => Effect.Effect<void, WorkerNotFoundError>

  readonly settleAttempt: (input: {
    readonly attemptID: Job.AttemptID
    readonly workerID: Job.WorkerID
    readonly status: Job.AttemptStatus
    readonly exitReason: Job.ExitReason
    readonly usage?: Job.Usage
    readonly error?: string
  }) => Effect.Effect<void, WorkerNotFoundError | AttemptSettledError>

  /** Records a verdict in the ledger, so what was checked stays readable later. */
  readonly recordVerification: (input: {
    readonly jobID: Job.ID
    readonly verdict: JobVerification.Verdict
    readonly results: ReadonlyArray<JobVerification.Result>
    readonly workerID?: Job.WorkerID
    readonly stepID?: Job.StepID
  }) => Effect.Effect<void, JobNotFoundError>

  readonly addArtifact: (input: {
    readonly jobID: Job.ID
    readonly type: Job.ArtifactType
    readonly name: string
    readonly workerID?: Job.WorkerID
    readonly stepID?: Job.StepID
    readonly content?: string
    readonly path?: string
    readonly mime?: string
    readonly bytes?: number
  }) => Effect.Effect<Job.Artifact, JobNotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Job") {}

const sameModel = (left: Job.ModelRef, right: Job.ModelRef) =>
  left.providerID === right.providerID && left.modelID === right.modelID && left.variant === right.variant

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const store = yield* JobStore.Service
    const { db } = yield* Database.Service

    const require = Effect.fn("Job.require")(function* (jobID: Job.ID) {
      const job = yield* store.get(jobID)
      if (!job) return yield* new JobNotFoundError({ jobID })
      return job
    })

    const requireWorker = Effect.fn("Job.requireWorker")(function* (workerID: Job.WorkerID) {
      const worker = yield* store.worker(workerID)
      if (!worker) return yield* new WorkerNotFoundError({ workerID })
      return worker
    })

    const create: Interface["create"] = Effect.fn("Job.create")(function* (input) {
      const jobID = Job.ID.create()
      yield* events.publish(JobEvent.Created, {
        jobID,
        timestamp: yield* DateTime.now,
        projectID: input.projectID,
        directory: input.directory,
        title: input.title,
        objective: input.objective,
        jobType: input.type,
        requestedBy: input.requestedBy,
        ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
        ...(input.budget === undefined ? {} : { budget: input.budget }),
        ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
      })
      const job = yield* store.get(jobID)
      if (!job) return yield* Effect.die(`Job ${jobID} was created but not projected`)
      return job
    })

    const transition: Interface["transition"] = Effect.fn("Job.transition")(function* (input) {
      const job = yield* require(input.jobID)
      if (!Job.canTransition(job.status, input.to))
        return yield* new InvalidTransitionError({ jobID: input.jobID, from: job.status, to: input.to })
      yield* events.publish(JobEvent.StatusChanged, {
        jobID: input.jobID,
        timestamp: yield* DateTime.now,
        from: job.status,
        to: input.to,
        ...(input.stage === undefined ? {} : { stage: input.stage }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })
      return yield* require(input.jobID)
    })

    const settle: Interface["settle"] = Effect.fn("Job.settle")(function* (input) {
      const job = yield* require(input.jobID)
      if (!Job.canTransition(job.status, input.status))
        return yield* new InvalidTransitionError({ jobID: input.jobID, from: job.status, to: input.status })
      yield* events.publish(JobEvent.Settled, {
        jobID: input.jobID,
        timestamp: yield* DateTime.now,
        from: job.status,
        status: input.status,
        ...(input.result === undefined ? {} : { result: input.result }),
        ...(input.error === undefined ? {} : { error: input.error }),
      })
      return yield* require(input.jobID)
    })

    const addStep: Interface["addStep"] = Effect.fn("Job.addStep")(function* (input) {
      yield* require(input.jobID)
      const stepID = Job.StepID.create()
      yield* events.publish(JobEvent.StepAdded, {
        jobID: input.jobID,
        timestamp: yield* DateTime.now,
        stepID,
        name: input.name,
        position: (yield* store.steps(input.jobID)).length,
      })
      const step = (yield* store.steps(input.jobID)).find((item) => item.id === stepID)
      if (!step) return yield* Effect.die(`Step ${stepID} was added but not projected`)
      return step
    })

    const settleStep: Interface["settleStep"] = Effect.fn("Job.settleStep")(function* (input) {
      yield* require(input.jobID)
      yield* events.publish(JobEvent.StepSettled, {
        jobID: input.jobID,
        timestamp: yield* DateTime.now,
        stepID: input.stepID,
        status: input.status,
      })
    })

    const createWorker: Interface["createWorker"] = Effect.fn("Job.createWorker")(function* (input) {
      yield* require(input.jobID)
      const existing = yield* store.workers(input.jobID)
      if (existing.length >= MAX_WORKERS)
        return yield* new TreeLimitError({ jobID: input.jobID, limit: "worker count" })
      const parent = input.parentID === undefined ? undefined : yield* requireWorker(input.parentID)
      const depth = parent === undefined ? 0 : parent.depth + 1
      if (depth > MAX_DEPTH) return yield* new TreeLimitError({ jobID: input.jobID, limit: "depth" })
      const workerID = Job.WorkerID.create()
      yield* events.publish(JobEvent.WorkerCreated, {
        jobID: input.jobID,
        timestamp: yield* DateTime.now,
        workerID,
        depth,
        role: input.role,
        agent: input.agent,
        requested: input.requested,
        // Clamped here rather than at the call site. An invariant that depends
        // on every caller remembering it is not an invariant.
        permissions: Capability.clamp({
          parent: parent?.permissions ?? [],
          child: input.permissions ?? [],
        }),
        ...(input.stepID === undefined ? {} : { stepID: input.stepID }),
        ...(input.parentID === undefined ? {} : { parentID: input.parentID }),
        ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
      })
      return yield* requireWorker(workerID)
    })

    const workerStatus: Interface["workerStatus"] = Effect.fn("Job.workerStatus")(function* (input) {
      const worker = yield* requireWorker(input.workerID)
      // Already there, so this caller did not put it there. Reporting that as an
      // ordinary success is what let two overlapping scheduler ticks each start
      // the same queued worker: the first moved it to `running`, the second saw
      // `running`, returned quietly, and its caller went on to open a second
      // attempt against one lease and one worktree.
      if (worker.status === input.to) return false
      // A worker that has stopped stays stopped. Recovery and a late executor
      // aim at the same worker from opposite sides, and without this whichever
      // writes second erases the other: work flagged for review reads
      // `completed`, or a settled worker is put back into `running` and handed
      // a fresh lease while its completion time still stands.
      if (Job.isWorkerTerminal(worker.status))
        return yield* new InvalidWorkerTransitionError({
          workerID: input.workerID,
          from: worker.status,
          to: input.to,
        })
      const now = yield* DateTime.now
      yield* events.publish(JobEvent.WorkerStatusChanged, {
        jobID: worker.jobID,
        timestamp: now,
        workerID: input.workerID,
        from: worker.status,
        to: input.to,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.retryAfterMs === undefined
          ? {}
          : { retryAfter: DateTime.addDuration(now, input.retryAfterMs) }),
      })
      // The lease is granted and released by the transition itself rather than
      // by the first heartbeat, so there is no window where a worker reads
      // `running` holding nothing and recovery reclaims it out from under its
      // own executor. It is written here and not in the projector because a
      // projection may be dropped and rebuilt, and a rebuild must not decide
      // what is running right now.
      const millis = DateTime.toEpochMillis(now)
      if (input.to === "running")
        yield* db
          .insert(JobWorkerLeaseTable)
          .values({ worker_id: input.workerID, heartbeat_at: millis, lease_until: millis + Job.LEASE_MS })
          .onConflictDoUpdate({
            target: JobWorkerLeaseTable.worker_id,
            set: { heartbeat_at: millis, lease_until: millis + Job.LEASE_MS },
          })
          .run()
          .pipe(Effect.orDie)
      // Anything else means this worker is no longer executing: queued and
      // waiting for a slot, waiting on a person, or finished. Leaving a lease
      // behind would vouch for work nobody is doing.
      else
        yield* db
          .delete(JobWorkerLeaseTable)
          .where(eq(JobWorkerLeaseTable.worker_id, input.workerID))
          .run()
          .pipe(Effect.orDie)
      return true
    })

    const assignWorktree: Interface["assignWorktree"] = Effect.fn("Job.assignWorktree")(function* (input) {
      const worker = yield* requireWorker(input.workerID)
      yield* events.publish(JobEvent.WorkerWorktreeAssigned, {
        jobID: worker.jobID,
        timestamp: yield* DateTime.now,
        workerID: input.workerID,
        worktree: input.worktree,
      })
    })

    /**
     * Renews a lease, outside the ledger on purpose.
     *
     * This used to append a durable event every thirty seconds per running
     * worker — some eleven thousand rows a day for four of them, burying the
     * handful that recorded what the job did. A lease renewal is not a fact
     * about the work; it is a claim that expires on its own, and the only reader
     * is recovery deciding whether anyone is still holding it.
     */
    const heartbeat: Interface["heartbeat"] = Effect.fn("Job.heartbeat")(function* (input) {
      yield* requireWorker(input.workerID)
      const now = DateTime.toEpochMillis(yield* DateTime.now)
      yield* db
        .insert(JobWorkerLeaseTable)
        .values({ worker_id: input.workerID, heartbeat_at: now, lease_until: now + input.leaseMs })
        .onConflictDoUpdate({
          target: JobWorkerLeaseTable.worker_id,
          set: { heartbeat_at: now, lease_until: now + input.leaseMs },
        })
        .run()
        .pipe(Effect.orDie)
    })

    const startAttempt: Interface["startAttempt"] = Effect.fn("Job.startAttempt")(function* (input) {
      const worker = yield* requireWorker(input.workerID)
      const attemptID = Job.AttemptID.create()
      yield* events.publish(JobEvent.AttemptStarted, {
        jobID: worker.jobID,
        timestamp: yield* DateTime.now,
        attemptID,
        workerID: input.workerID,
        // Numbering from the count makes the retry sequence readable without
        // consulting timestamps, and keeps a replay deterministic.
        number: (yield* store.attempts(input.workerID)).length + 1,
        requested: input.requested,
        ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
        ...(input.retryReason === undefined ? {} : { retryReason: input.retryReason }),
      })
      const attempt = (yield* store.attempts(input.workerID)).find((item) => item.id === attemptID)
      if (!attempt) return yield* Effect.die(`Attempt ${attemptID} was started but not projected`)
      return attempt
    })

    const resolveModel: Interface["resolveModel"] = Effect.fn("Job.resolveModel")(function* (input) {
      const worker = yield* requireWorker(input.workerID)
      yield* events.publish(JobEvent.ModelResolved, {
        jobID: worker.jobID,
        timestamp: yield* DateTime.now,
        attemptID: input.attemptID,
        workerID: input.workerID,
        requested: input.requested,
        resolved: input.resolved,
        fellBack: !sameModel(input.requested, input.resolved),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })
    })

    const settleAttempt: Interface["settleAttempt"] = Effect.fn("Job.settleAttempt")(function* (input) {
      const worker = yield* requireWorker(input.workerID)
      // An attempt is settled once. Recovery settling a stalled attempt and its
      // executor returning minutes later both write this row, and a second
      // settlement would replace the first outcome with the loser's while its
      // usage was added again to the worker and job rollups budgets read.
      const attempt = (yield* store.attempts(input.workerID)).find((item) => item.id === input.attemptID)
      if (attempt && Job.isAttemptSettled(attempt.status))
        return yield* new AttemptSettledError({ attemptID: input.attemptID, status: attempt.status })
      yield* events.publish(JobEvent.AttemptSettled, {
        jobID: worker.jobID,
        timestamp: yield* DateTime.now,
        attemptID: input.attemptID,
        workerID: input.workerID,
        status: input.status,
        exitReason: input.exitReason,
        usage: input.usage ?? Job.emptyUsage,
        ...(input.error === undefined ? {} : { error: input.error }),
      })
    })

    const recordVerification: Interface["recordVerification"] = Effect.fn("Job.recordVerification")(function* (
      input,
    ) {
      yield* require(input.jobID)
      yield* events.publish(JobEvent.Verified, {
        jobID: input.jobID,
        timestamp: yield* DateTime.now,
        verdict: input.verdict,
        results: input.results,
        ...(input.workerID === undefined ? {} : { workerID: input.workerID }),
        ...(input.stepID === undefined ? {} : { stepID: input.stepID }),
      })
    })

    const addArtifact: Interface["addArtifact"] = Effect.fn("Job.addArtifact")(function* (input) {
      yield* require(input.jobID)
      const artifactID = Job.ArtifactID.create()
      yield* events.publish(JobEvent.ArtifactAdded, {
        jobID: input.jobID,
        timestamp: yield* DateTime.now,
        artifactID,
        artifactType: input.type,
        name: input.name,
        ...(input.workerID === undefined ? {} : { workerID: input.workerID }),
        ...(input.stepID === undefined ? {} : { stepID: input.stepID }),
        ...(input.content === undefined ? {} : { content: input.content }),
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.mime === undefined ? {} : { mime: input.mime }),
        ...(input.bytes === undefined ? {} : { bytes: input.bytes }),
      })
      const artifact = (yield* store.artifacts(input.jobID)).find((item) => item.id === artifactID)
      if (!artifact) return yield* Effect.die(`Artifact ${artifactID} was added but not projected`)
      return artifact
    })

    return Service.of({
      create,
      transition,
      settle,
      addStep,
      settleStep,
      createWorker,
      workerStatus,
      assignWorktree,
      heartbeat,
      startAttempt,
      resolveModel,
      settleAttempt,
      recordVerification,
      addArtifact,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [EventV2.node, JobStore.node, Database.node] })

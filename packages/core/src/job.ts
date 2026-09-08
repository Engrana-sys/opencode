export * as JobV2 from "./job"

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Job } from "@opencode-ai/schema/job"
import { JobEvent } from "@opencode-ai/schema/job-event"
import { makeGlobalNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { JobStore } from "./job/store"
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

export class TreeLimitError extends Schema.TaggedErrorClass<TreeLimitError>()("Job.TreeLimitError", {
  jobID: Job.ID,
  limit: Schema.String,
}) {
  override get message() {
    return `Job ${this.jobID} exceeded its ${this.limit} limit`
  }
}

export type Error = JobNotFoundError | WorkerNotFoundError | InvalidTransitionError | TreeLimitError

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
    readonly stepID?: Job.StepID
    readonly parentID?: Job.WorkerID
    readonly worktree?: Job.Worktree
  }) => Effect.Effect<Job.Worker, JobNotFoundError | WorkerNotFoundError | TreeLimitError>

  readonly workerStatus: (input: {
    readonly workerID: Job.WorkerID
    readonly to: Job.WorkerStatus
    readonly reason?: string
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
  }) => Effect.Effect<void, WorkerNotFoundError>

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
        ...(input.stepID === undefined ? {} : { stepID: input.stepID }),
        ...(input.parentID === undefined ? {} : { parentID: input.parentID }),
        ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
      })
      return yield* requireWorker(workerID)
    })

    const workerStatus: Interface["workerStatus"] = Effect.fn("Job.workerStatus")(function* (input) {
      const worker = yield* requireWorker(input.workerID)
      if (worker.status === input.to) return
      yield* events.publish(JobEvent.WorkerStatusChanged, {
        jobID: worker.jobID,
        timestamp: yield* DateTime.now,
        workerID: input.workerID,
        from: worker.status,
        to: input.to,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })
    })

    const heartbeat: Interface["heartbeat"] = Effect.fn("Job.heartbeat")(function* (input) {
      const worker = yield* requireWorker(input.workerID)
      const now = yield* DateTime.now
      yield* events.publish(JobEvent.WorkerHeartbeat, {
        jobID: worker.jobID,
        timestamp: now,
        workerID: input.workerID,
        leaseUntil: DateTime.addDuration(now, input.leaseMs),
      })
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
      heartbeat,
      startAttempt,
      resolveModel,
      settleAttempt,
      addArtifact,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [EventV2.node, JobStore.node] })

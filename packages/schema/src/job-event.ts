export * as JobEvent from "./job-event"

import { Schema } from "effect"
import { Event } from "./event"
import { Job } from "./job"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, PositiveInt } from "./schema"
import { SessionID } from "./session-id"

/**
 * The job ledger.
 *
 * Every fact about a job is one of these, appended under the job's aggregate
 * and never rewritten. A projection may be dropped and rebuilt from them; the
 * events themselves are the record. That is why the shapes here carry the
 * reason for a change and not only its outcome: `status = failed` cannot be
 * questioned later, but `WorkerFailed` with an exit reason and the model that
 * ran can.
 *
 * @module
 */

const options = { durable: { aggregate: "jobID", version: 1 } } as const

const Base = {
  timestamp: DateTimeUtcFromMillis,
  jobID: Job.ID,
}

export const Created = Event.define({
  type: "job.created",
  ...options,
  schema: {
    ...Base,
    projectID: Schema.String,
    directory: Schema.String,
    title: Schema.String,
    objective: Schema.String,
    jobType: Schema.String,
    requestedBy: Schema.String,
    baseRef: optional(Schema.String),
    budget: optional(Job.Budget),
    sessionID: optional(SessionID),
  },
})

export const StatusChanged = Event.define({
  type: "job.status.changed",
  ...options,
  schema: {
    ...Base,
    from: Job.Status,
    to: Job.Status,
    stage: optional(Schema.String),
    reason: optional(Schema.String),
  },
})

export const Settled = Event.define({
  type: "job.settled",
  ...options,
  schema: {
    ...Base,
    from: Job.Status,
    status: Job.Status.annotate({ description: "One of the terminal statuses" }),
    result: optional(Schema.String),
    error: optional(Schema.String),
  },
})

export const StepAdded = Event.define({
  type: "job.step.added",
  ...options,
  schema: { ...Base, stepID: Job.StepID, name: Schema.String, position: NonNegativeInt },
})

export const StepSettled = Event.define({
  type: "job.step.settled",
  ...options,
  schema: { ...Base, stepID: Job.StepID, status: Job.Status },
})

export const WorkerCreated = Event.define({
  type: "job.worker.created",
  ...options,
  schema: {
    ...Base,
    workerID: Job.WorkerID,
    stepID: optional(Job.StepID),
    parentID: optional(Job.WorkerID),
    depth: NonNegativeInt,
    role: Schema.String,
    agent: Schema.String,
    worktree: optional(Job.Worktree),
  },
})

export const WorkerStatusChanged = Event.define({
  type: "job.worker.status.changed",
  ...options,
  schema: {
    ...Base,
    workerID: Job.WorkerID,
    from: Job.WorkerStatus,
    to: Job.WorkerStatus,
    reason: optional(Schema.String),
  },
})

/** Renews a worker's lease. Absence of these is how recovery finds abandoned work. */
export const WorkerHeartbeat = Event.define({
  type: "job.worker.heartbeat",
  ...options,
  schema: { ...Base, workerID: Job.WorkerID, leaseUntil: DateTimeUtcFromMillis },
})

export const AttemptStarted = Event.define({
  type: "job.attempt.started",
  ...options,
  schema: {
    ...Base,
    attemptID: Job.AttemptID,
    workerID: Job.WorkerID,
    number: PositiveInt,
    requested: Job.ModelRef,
    sessionID: optional(SessionID),
    retryReason: optional(Schema.String),
  },
})

/**
 * The model that actually answered.
 *
 * Emitted separately from `AttemptStarted` because what was asked for and what
 * ran are different facts, and conflating them is how a silent fallback hides.
 * `fellBack` is true whenever `resolved` differs from what the attempt
 * requested.
 */
export const ModelResolved = Event.define({
  type: "job.attempt.model.resolved",
  ...options,
  schema: {
    ...Base,
    attemptID: Job.AttemptID,
    workerID: Job.WorkerID,
    requested: Job.ModelRef,
    resolved: Job.ModelRef,
    fellBack: Schema.Boolean,
    reason: optional(Schema.String.annotate({ description: "Why the requested model was not used" })),
  },
})

export const AttemptSettled = Event.define({
  type: "job.attempt.settled",
  ...options,
  schema: {
    ...Base,
    attemptID: Job.AttemptID,
    workerID: Job.WorkerID,
    status: Job.AttemptStatus,
    exitReason: Job.ExitReason,
    usage: Job.Usage,
    error: optional(Schema.String),
  },
})

export const ArtifactAdded = Event.define({
  type: "job.artifact.added",
  ...options,
  schema: {
    ...Base,
    artifactID: Job.ArtifactID,
    workerID: optional(Job.WorkerID),
    stepID: optional(Job.StepID),
    artifactType: Job.ArtifactType,
    name: Schema.String,
    content: optional(Schema.String),
    path: optional(Schema.String),
    mime: optional(Schema.String),
    bytes: optional(NonNegativeInt),
  },
})

/** Every job event is durable; the ledger is the only record a job has. */
export const Definitions = Event.inventory(
  Created,
  StatusChanged,
  Settled,
  StepAdded,
  StepSettled,
  WorkerCreated,
  WorkerStatusChanged,
  WorkerHeartbeat,
  AttemptStarted,
  ModelResolved,
  AttemptSettled,
  ArtifactAdded,
)

export const DurableDefinitions = Definitions

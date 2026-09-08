export * as Job from "./job"

import { Schema } from "effect"
import { ascending, descending } from "./identifier"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, PositiveInt, statics } from "./schema"
import { SessionID } from "./session-id"

/**
 * Durable work, independent of any conversation.
 *
 * A Session is a conversation; a Job is a unit of work that outlives one. The
 * two are deliberately not the same entity: a job survives the session that
 * created it, may be worked by several sessions, and stays answerable for its
 * result after every one of them has ended.
 *
 * Nothing here is authoritative state. A job, its steps, workers and attempts
 * are projections of the durable event ledger keyed by job ID, so the shapes
 * below describe what a projection produces, never what a writer mutates.
 *
 * @module
 */

/** Ascending so a job listing reads oldest-first without a sort key. */
export const ID = Schema.String.check(Schema.isStartsWith("job_")).pipe(
  Schema.brand("Job.ID"),
  statics((schema) => ({ create: () => schema.make("job_" + ascending()) })),
)
export type ID = typeof ID.Type

export const StepID = Schema.String.check(Schema.isStartsWith("stp_")).pipe(
  Schema.brand("Job.StepID"),
  statics((schema) => ({ create: () => schema.make("stp_" + ascending()) })),
)
export type StepID = typeof StepID.Type

export const WorkerID = Schema.String.check(Schema.isStartsWith("wrk_")).pipe(
  Schema.brand("Job.WorkerID"),
  statics((schema) => ({ create: () => schema.make("wrk_" + ascending()) })),
)
export type WorkerID = typeof WorkerID.Type

export const AttemptID = Schema.String.check(Schema.isStartsWith("att_")).pipe(
  Schema.brand("Job.AttemptID"),
  statics((schema) => ({ create: () => schema.make("att_" + ascending()) })),
)
export type AttemptID = typeof AttemptID.Type

/** Descending so the newest artifact of a job is the first row read. */
export const ArtifactID = Schema.String.check(Schema.isStartsWith("art_")).pipe(
  Schema.brand("Job.ArtifactID"),
  statics((schema) => ({ create: () => schema.make("art_" + descending()) })),
)
export type ArtifactID = typeof ArtifactID.Type

/**
 * Where a job is in its life.
 *
 * `blocked` is the job's own inability to proceed; `waiting_human` is a
 * deliberate pause for a decision. Keeping them apart matters because only one
 * of the two is a problem.
 */
export const Status = Schema.Literals([
  "created",
  "planning",
  "queued",
  "running",
  "blocked",
  "waiting_human",
  "verifying",
  "reviewing",
  "completed",
  "failed",
  "cancelled",
  "stale",
]).annotate({ identifier: "Job.Status" })
export type Status = typeof Status.Type

export const TERMINAL: ReadonlyArray<Status> = ["completed", "failed", "cancelled"]

export const isTerminal = (status: Status) => TERMINAL.includes(status)

/**
 * Legal transitions.
 *
 * A job may be cancelled from any live state, and `stale` is reachable from any
 * live state because recovery declares it rather than the job reaching it. The
 * terminal states lead nowhere: re-running work means a new job, so that the
 * ledger of what happened stays true.
 */
export const TRANSITIONS: Readonly<Record<Status, ReadonlyArray<Status>>> = {
  created: ["planning", "queued", "cancelled", "failed", "stale"],
  planning: ["queued", "waiting_human", "blocked", "failed", "cancelled", "stale"],
  queued: ["running", "blocked", "cancelled", "failed", "stale"],
  running: ["verifying", "reviewing", "blocked", "waiting_human", "completed", "failed", "cancelled", "stale"],
  blocked: ["queued", "running", "waiting_human", "failed", "cancelled", "stale"],
  waiting_human: ["running", "queued", "cancelled", "failed", "stale"],
  verifying: ["reviewing", "running", "completed", "failed", "cancelled", "stale"],
  reviewing: ["running", "completed", "failed", "cancelled", "stale"],
  completed: [],
  failed: [],
  cancelled: [],
  stale: ["queued", "running", "failed", "cancelled"],
}

export const canTransition = (from: Status, to: Status) => TRANSITIONS[from].includes(to)

export const WorkerStatus = Schema.Literals([
  "created",
  "queued",
  "running",
  "waiting_input",
  "completed",
  "failed",
  "cancelled",
  "stale",
]).annotate({ identifier: "Job.WorkerStatus" })
export type WorkerStatus = typeof WorkerStatus.Type

export const AttemptStatus = Schema.Literals(["running", "completed", "failed", "cancelled", "stale"]).annotate({
  identifier: "Job.AttemptStatus",
})
export type AttemptStatus = typeof AttemptStatus.Type

export const ArtifactType = Schema.Literals([
  "finding",
  "plan",
  "patch",
  "diff",
  "report",
  "test-result",
  "benchmark",
  "screenshot",
  "log",
  "structured-json",
]).annotate({ identifier: "Job.ArtifactType" })
export type ArtifactType = typeof ArtifactType.Type

/** Why an attempt stopped. Distinguishing these is what makes retry policy possible. */
export const ExitReason = Schema.Literals([
  "success",
  "provider_unavailable",
  "rate_limited",
  "model_unavailable",
  "tool_failed",
  "permission_denied",
  "sandbox_violation",
  "timeout",
  "stalled",
  "context_overflow",
  "verifier_failed",
  "human_rejected",
  "cancelled",
  "infrastructure_failure",
]).annotate({ identifier: "Job.ExitReason" })
export type ExitReason = typeof ExitReason.Type

/** Exit reasons worth another attempt. The rest are decisions, not failures to retry. */
export const RETRYABLE: ReadonlyArray<ExitReason> = [
  "provider_unavailable",
  "rate_limited",
  "tool_failed",
  "timeout",
  "stalled",
  "infrastructure_failure",
]

export const isRetryable = (reason: ExitReason) => RETRYABLE.includes(reason)

/** A model as asked for, which is not necessarily the model that ran. */
export const ModelRef = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  variant: optional(Schema.String),
}).annotate({ identifier: "Job.ModelRef" })
export interface ModelRef extends Schema.Schema.Type<typeof ModelRef> {}

export const Budget = Schema.Struct({
  maxCost: optional(Schema.Finite),
  maxTokens: optional(PositiveInt),
  maxWallTimeMs: optional(PositiveInt),
  maxWorkers: optional(PositiveInt),
}).annotate({ identifier: "Job.Budget" })
export interface Budget extends Schema.Schema.Type<typeof Budget> {}

export const Usage = Schema.Struct({
  tokensInput: NonNegativeInt,
  tokensOutput: NonNegativeInt,
  tokensCached: NonNegativeInt,
  cost: Schema.Finite,
}).annotate({ identifier: "Job.Usage" })
export interface Usage extends Schema.Schema.Type<typeof Usage> {}

export const emptyUsage: Usage = { tokensInput: 0, tokensOutput: 0, tokensCached: 0, cost: 0 }

/** Where a worker's writes go. Read-only workers share the base checkout and have none. */
export const Worktree = Schema.Struct({
  repo: Schema.String,
  baseRef: Schema.String,
  baseSha: Schema.String,
  branch: Schema.String,
  directory: Schema.String,
}).annotate({ identifier: "Job.Worktree" })
export interface Worktree extends Schema.Schema.Type<typeof Worktree> {}

export const Info = Schema.Struct({
  id: ID,
  projectID: Schema.String,
  title: Schema.String,
  objective: Schema.String.annotate({ description: "What the job is for, stated by whoever asked for it" }),
  type: Schema.String.annotate({ description: "Workflow class, such as audit or feature" }),
  status: Status,
  stage: optional(Schema.String.annotate({ description: "Free-form progress label within the current status" })),
  requestedBy: Schema.String,
  directory: Schema.String,
  baseRef: optional(Schema.String),
  budget: optional(Budget),
  usage: Usage,
  result: optional(Schema.String),
  error: optional(Schema.String),
  sessionID: optional(SessionID.annotate({ description: "The conversation that created the job, if any" })),
  timeCreated: DateTimeUtcFromMillis,
  timeStarted: optional(DateTimeUtcFromMillis),
  timeCompleted: optional(DateTimeUtcFromMillis),
}).annotate({ identifier: "Job" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Step = Schema.Struct({
  id: StepID,
  jobID: ID,
  name: Schema.String,
  position: NonNegativeInt,
  status: Status,
  timeCreated: DateTimeUtcFromMillis,
  timeCompleted: optional(DateTimeUtcFromMillis),
}).annotate({ identifier: "Job.Step" })
export interface Step extends Schema.Schema.Type<typeof Step> {}

export const Worker = Schema.Struct({
  id: WorkerID,
  jobID: ID,
  stepID: optional(StepID),
  parentID: optional(WorkerID),
  depth: NonNegativeInt,
  role: Schema.String.annotate({ description: "What this worker is for, such as scout-backend or auditor" }),
  agent: Schema.String,
  status: WorkerStatus,
  worktree: optional(Worktree),
  /** Set while an attempt holds the worker; a lapsed lease is how recovery finds the dead. */
  heartbeatAt: optional(DateTimeUtcFromMillis),
  leaseUntil: optional(DateTimeUtcFromMillis),
  usage: Usage,
  timeCreated: DateTimeUtcFromMillis,
  timeCompleted: optional(DateTimeUtcFromMillis),
}).annotate({ identifier: "Job.Worker" })
export interface Worker extends Schema.Schema.Type<typeof Worker> {}

/**
 * One concrete run of a worker.
 *
 * Attempts accumulate rather than overwrite: a worker that failed on a network
 * error and succeeded on retry has two attempts, and both stay readable. This
 * is also where a model is pinned per invocation, with what was asked for kept
 * beside what actually answered.
 */
export const Attempt = Schema.Struct({
  id: AttemptID,
  jobID: ID,
  workerID: WorkerID,
  number: PositiveInt,
  status: AttemptStatus,
  requested: ModelRef,
  resolved: optional(ModelRef.annotate({ description: "Absent until a model is actually reached" })),
  sessionID: optional(SessionID),
  usage: Usage,
  exitReason: optional(ExitReason),
  error: optional(Schema.String),
  retryReason: optional(Schema.String.annotate({ description: "Why this attempt was started after a previous one" })),
  timeStarted: DateTimeUtcFromMillis,
  timeCompleted: optional(DateTimeUtcFromMillis),
}).annotate({ identifier: "Job.Attempt" })
export interface Attempt extends Schema.Schema.Type<typeof Attempt> {}

export const Artifact = Schema.Struct({
  id: ArtifactID,
  jobID: ID,
  workerID: optional(WorkerID),
  stepID: optional(StepID),
  type: ArtifactType,
  name: Schema.String,
  /** Inline content for small results; large ones live at `path` instead. */
  content: optional(Schema.String),
  path: optional(Schema.String),
  mime: optional(Schema.String),
  bytes: optional(NonNegativeInt),
  timeCreated: DateTimeUtcFromMillis,
}).annotate({ identifier: "Job.Artifact" })
export interface Artifact extends Schema.Schema.Type<typeof Artifact> {}

export * as JobVerification from "./job-verification"

import { Schema } from "effect"
import { Job } from "./job"
import { DateTimeUtcFromMillis, NonNegativeInt, optional } from "./schema"

/**
 * Deterministic checks over what a worker produced.
 *
 * A worker proposes; the verifier decides. The separation exists because a
 * model asked whether its own work is correct is not a check — it is the same
 * judgement that produced the work, asked twice.
 *
 * @module
 */

/**
 * The three outcomes, and the reason there are three.
 *
 * `unverified` is not a soft failure, it is the absence of evidence: the check
 * could not run, so nothing was learned. Collapsing it into either of the other
 * two would be a lie in one direction or the other — reporting success for work
 * nobody checked, or condemning work that may be fine.
 */
export const Verdict = Schema.Literals(["verified", "refuted", "unverified"]).annotate({
  identifier: "JobVerification.Verdict",
})
export type Verdict = typeof Verdict.Type

export const CheckOutcome = Schema.Literals(["passed", "failed", "errored", "skipped"]).annotate({
  identifier: "JobVerification.CheckOutcome",
})
export type CheckOutcome = typeof CheckOutcome.Type

/** What a check does. Migrations, HTTP assertions and builds are all commands. */
export const CheckType = Schema.Literals(["command", "files"]).annotate({
  identifier: "JobVerification.CheckType",
})
export type CheckType = typeof CheckType.Type

export const Check = Schema.Struct({
  name: Schema.String,
  type: CheckType,
  /** For `command`: the command to run. Exit zero passes. */
  command: optional(Schema.String),
  /** For `files`: globs the diff may touch. An empty list permits anything. */
  allow: optional(Schema.Array(Schema.String)),
  /** For `files`: globs the diff must not touch, checked after `allow`. */
  forbid: optional(Schema.Array(Schema.String)),
  timeoutMs: optional(NonNegativeInt),
}).annotate({ identifier: "JobVerification.Check" })
export interface Check extends Schema.Schema.Type<typeof Check> {}

export const Result = Schema.Struct({
  name: Schema.String,
  outcome: CheckOutcome,
  detail: Schema.String,
  durationMs: optional(NonNegativeInt),
}).annotate({ identifier: "JobVerification.Result" })
export interface Result extends Schema.Schema.Type<typeof Result> {}

export const Info = Schema.Struct({
  jobID: Job.ID,
  workerID: optional(Job.WorkerID),
  stepID: optional(Job.StepID),
  verdict: Verdict,
  results: Schema.Array(Result),
  timeCreated: DateTimeUtcFromMillis,
}).annotate({ identifier: "JobVerification" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

/**
 * The verdict for a set of results.
 *
 * A single failure refutes: a candidate that breaks one thing is not partially
 * correct. Absent a failure, any check that could not run leaves the whole
 * unverified — you cannot claim a candidate passed when part of the evidence
 * was never gathered. Only when every check ran and passed is it verified.
 *
 * An empty set is `unverified`, not `verified`: checking nothing proves
 * nothing, and defaulting to success would make an unconfigured verifier the
 * most permissive one.
 */
export const verdict = (results: ReadonlyArray<Result>): Verdict => {
  if (results.some((result) => result.outcome === "failed")) return "refuted"
  if (results.length === 0) return "unverified"
  if (results.some((result) => result.outcome !== "passed")) return "unverified"
  return "verified"
}

export const describe = (input: { readonly verdict: Verdict; readonly results: ReadonlyArray<Result> }) => {
  const counted = (outcome: CheckOutcome) => input.results.filter((result) => result.outcome === outcome).length
  return [
    `${input.verdict.toUpperCase()}:`,
    `${counted("passed")} passed`,
    `${counted("failed")} failed`,
    `${counted("errored")} could not run`,
    `${counted("skipped")} skipped`,
  ].join(" ")
}

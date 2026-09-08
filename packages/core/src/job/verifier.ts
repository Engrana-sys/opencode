export * as JobVerifier from "./verifier"

import { Context, DateTime, Duration, Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { JobVerification } from "@opencode-ai/schema/job-verification"
import type { Job } from "@opencode-ai/schema/job"
import { makeGlobalNode } from "../effect/app-node"
import { Git } from "../git"
import { AppProcess } from "../process"
import { AbsolutePath } from "../schema"
import { Wildcard } from "../util/wildcard"

/**
 * Checks a worker's candidate without asking a model anything.
 *
 * A worker proposes and this decides, because a model asked whether its own
 * work is correct is not a check — it is the same judgement that produced the
 * work, asked a second time. Everything here is a command that exits zero or
 * does not, or a diff that touches permitted paths or does not.
 *
 * The verdict rules live in the schema module and are pure; this only gathers
 * the evidence. A check that could not run is recorded as `errored`, never
 * quietly dropped, which is what keeps `unverified` distinguishable from a
 * clean pass.
 *
 * @module
 */

export const DEFAULT_TIMEOUT_MS = 300_000
const MAX_DETAIL = 2_000

const truncate = (value: string) =>
  value.length <= MAX_DETAIL ? value : `${value.slice(0, MAX_DETAIL)}\n[truncated]`

/**
 * Files a worker changed in its own tree, relative to the repository root.
 *
 * Undefined means the tree could not be read, which is different from a tree
 * with no changes: one is missing evidence, the other is evidence of nothing
 * having happened.
 */
export const changed = (input: {
  readonly git: Git.Interface
  readonly proc: AppProcess.Interface
  readonly directory: AbsolutePath
}) =>
  Effect.gen(function* () {
    const repository = yield* input.git.repo.discover(input.directory)
    if (!repository) return undefined
    const result = yield* input.proc
      .run(ChildProcess.make("git", ["status", "--porcelain=v1"], { cwd: input.directory, stdin: "ignore" }))
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!result || result.exitCode !== 0) return undefined
    return result.stdout
      .toString("utf8")
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
  })

/**
 * Judges a set of changed paths against allow and forbid globs.
 *
 * Pure, so the interesting cases can be tested without a repository. `forbid`
 * is applied after `allow` on purpose: a forbid rule is a carve-out from
 * something already permitted, and applying it first would let a broad allow
 * silently override it.
 */
export const inspect = (input: {
  readonly files: ReadonlyArray<string>
  readonly allow?: ReadonlyArray<string>
  readonly forbid?: ReadonlyArray<string>
}): { readonly ok: boolean; readonly detail: string } => {
  const allow = input.allow ?? []
  const forbid = input.forbid ?? []
  const outside =
    allow.length === 0 ? [] : input.files.filter((file) => !allow.some((glob) => Wildcard.match(file, glob)))
  const banned = input.files.filter((file) => forbid.some((glob) => Wildcard.match(file, glob)))
  if (outside.length === 0 && banned.length === 0)
    return { ok: true, detail: `${input.files.length} changed file(s), all permitted` }
  return {
    ok: false,
    detail: [
      ...(outside.length === 0 ? [] : [`Outside the allowed paths: ${outside.join(", ")}`]),
      ...(banned.length === 0 ? [] : [`Forbidden paths touched: ${banned.join(", ")}`]),
    ].join("\n"),
  }
}

export interface Interface {
  readonly verify: (input: {
    readonly checks: ReadonlyArray<JobVerification.Check>
    readonly directory: string
    readonly jobID: Job.ID
    readonly workerID?: Job.WorkerID
  }) => Effect.Effect<JobVerification.Info>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/JobVerifier") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const proc = yield* AppProcess.Service
    const git = yield* Git.Service

    const command = Effect.fn("JobVerifier.command")(function* (
      check: JobVerification.Check,
      directory: string,
    ) {
      if (check.command === undefined)
        return {
          name: check.name,
          outcome: "errored" as const,
          detail: "The check declares no command to run.",
        }
      const started = yield* DateTime.now
      const outcome = yield* proc
        .run(ChildProcess.make("sh", ["-c", check.command], { cwd: directory, extendEnv: true, stdin: "ignore" }), {
          timeout: Duration.millis(check.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        })
        .pipe(
          Effect.map((result) => ({ ran: true as const, result })),
          Effect.catch((error) => Effect.succeed({ ran: false as const, message: error.message })),
        )
      const durationMs = DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(started)
      // A command that never ran is not a command that failed. A missing binary
      // or a timeout leaves the question open; only an exit code answers it.
      if (!outcome.ran)
        return {
          name: check.name,
          outcome: "errored" as const,
          detail: truncate(outcome.message),
          durationMs,
        }
      const result = outcome.result
      return {
        name: check.name,
        outcome: result.exitCode === 0 ? ("passed" as const) : ("failed" as const),
        detail: truncate(
          `${result.stdout.toString("utf8")}${result.stderr.toString("utf8")}`.trim() || `exit ${result.exitCode}`,
        ),
        durationMs,
      }
    })

    const files = Effect.fn("JobVerifier.files")(function* (check: JobVerification.Check, directory: string) {
      const list = yield* changed({ git, proc, directory: AbsolutePath.make(directory) })
      if (list === undefined)
        return {
          name: check.name,
          outcome: "errored" as const,
          detail: "Could not read the working tree, so nothing was checked.",
        }
      const seen = inspect({
        files: list,
        ...(check.allow === undefined ? {} : { allow: check.allow }),
        ...(check.forbid === undefined ? {} : { forbid: check.forbid }),
      })
      return {
        name: check.name,
        outcome: seen.ok ? ("passed" as const) : ("failed" as const),
        detail: seen.detail,
      }
    })

    return Service.of({
      verify: Effect.fn("JobVerifier.verify")(function* (input) {
        const results: JobVerification.Result[] = []
        for (const check of input.checks)
          results.push(
            check.type === "files"
              ? yield* files(check, input.directory)
              : yield* command(check, input.directory),
          )
        return {
          jobID: input.jobID,
          ...(input.workerID === undefined ? {} : { workerID: input.workerID }),
          verdict: JobVerification.verdict(results),
          results,
          timeCreated: yield* DateTime.now,
        }
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [AppProcess.node, Git.node] })

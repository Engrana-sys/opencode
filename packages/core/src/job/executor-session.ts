export * as JobExecutorSession from "./executor-session"

import { Cause, Effect, Layer } from "effect"
import type { Job } from "@opencode-ai/schema/job"
import { AgentV2 } from "../agent"
import { makeGlobalNode } from "../effect/app-node"
import { AbsolutePath } from "../schema"
import { SessionV2 } from "../session"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { JobExecutor } from "./executor"

/**
 * Runs an attempt as a session.
 *
 * A worker is given its own session rather than sharing the one that created
 * the job: its transcript, compaction and context epoch are its own, and a
 * scout burning through context cannot disturb the auditor beside it. The
 * session ID is recorded on the attempt, so the transcript stays reachable
 * afterwards.
 *
 * The model is pinned at creation from what the worker asked for. If that model
 * is unavailable the attempt fails with `model_unavailable` rather than
 * quietly running on whatever the session would have picked — a worker spawned
 * to use Codestral that silently ran on something else makes every later
 * comparison between them meaningless.
 *
 * ## Known gap until phase 4
 *
 * The worker runs with the permissions of its agent, not the intersection of
 * its parent's effective permissions with its own. Capability monotonicity is
 * phase 4 work and is not enforced here. Until it lands, a child worker can
 * reach whatever its agent allows, which may be more than its parent had.
 *
 * @module
 */

const reason = (cause: Cause.Cause<unknown>): { readonly exitReason: Job.ExitReason; readonly error: string } => {
  const failure = Cause.squash(cause)
  const message = failure instanceof Error ? failure.message : String(failure)
  if (Cause.hasInterrupts(cause)) return { exitReason: "cancelled", error: "The attempt was interrupted." }
  // The taxonomy is what retry policy branches on, so map what we can name and
  // leave the rest as infrastructure rather than guessing at a cause.
  if (/rate.?limit/i.test(message)) return { exitReason: "rate_limited", error: message }
  if (/context|too many tokens|maximum context/i.test(message))
    return { exitReason: "context_overflow", error: message }
  if (/permission|denied|forbidden/i.test(message)) return { exitReason: "permission_denied", error: message }
  if (/unavailable|not found|no model/i.test(message)) return { exitReason: "model_unavailable", error: message }
  return { exitReason: "infrastructure_failure", error: message }
}

/** What the worker is told to do. Its goal is the job's, narrowed to its role. */
export const brief = (input: {
  readonly job: Pick<Job.Info, "objective">
  readonly worker: Pick<Job.Worker, "role">
}) =>
  [
    `You are the ${input.worker.role} for this job.`,
    "",
    "<objective>",
    input.job.objective,
    "</objective>",
    "",
    "Work only within your role. Report what you found or did, and say plainly what you could not establish.",
  ].join("\n")

const layer = Layer.effect(
  JobExecutor.Service,
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service

    return JobExecutor.Service.of({
      run: Effect.fn("JobExecutorSession.run")(function* (input) {
        // The catalog names a model `{ id, providerID }`; a job's ModelRef names
        // it `{ modelID, providerID }`. Translate at this boundary rather than
        // leaking either shape into the other.
        const model = {
          id: ModelV2.ID.make(input.attempt.requested.modelID),
          providerID: ProviderV2.ID.make(input.attempt.requested.providerID),
          ...(input.attempt.requested.variant === undefined
            ? {}
            : { variant: ModelV2.VariantID.make(input.attempt.requested.variant) }),
        }
        const outcome = yield* Effect.gen(function* () {
          const session = yield* sessions.create({
            location: { directory: AbsolutePath.make(input.job.directory) },
            agent: AgentV2.ID.make(input.worker.agent),
            model,
          })
          yield* sessions.prompt({
            sessionID: session.id,
            prompt: { text: brief({ job: input.job, worker: input.worker }) },
            resume: false,
          })
          // Blocks until the session settles; that is the end of the attempt.
          yield* sessions.resume(session.id)
          const settled = yield* sessions.get(session.id)
          return {
            exitReason: "success" as const,
            sessionID: session.id,
            // Recorded even when it matches: an attempt with no resolved model
            // is one that never reached a model at all.
            resolved: settled.model
              ? {
                  providerID: settled.model.providerID,
                  modelID: settled.model.id,
                  ...(settled.model.variant === undefined ? {} : { variant: settled.model.variant }),
                }
              : input.attempt.requested,
            usage: {
              tokensInput: settled.tokens.input,
              tokensOutput: settled.tokens.output,
              tokensCached: settled.tokens.cache.read + settled.tokens.cache.write,
              cost: settled.cost,
            },
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.succeed({
              ...reason(cause),
              usage: { tokensInput: 0, tokensOutput: 0, tokensCached: 0, cost: 0 },
            }),
          ),
        )
        return outcome
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: JobExecutor.Service, layer, deps: [SessionV2.node] })

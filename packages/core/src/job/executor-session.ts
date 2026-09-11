export * as JobExecutorSession from "./executor-session"

import { Cause, Effect, Layer } from "effect"
import type { Job } from "@opencode-ai/schema/job"
import { AgentV2 } from "../agent"
import { makeGlobalNode } from "../effect/app-node"
import { AbsolutePath } from "../schema"
import { SessionV2 } from "../session"
import type { SessionSchema } from "../session/schema"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { JobExecutor } from "./executor"

/**
 * Runs an attempt as a session.
 *
 * A worker is given its own session rather than sharing the one that created
 * the job: its transcript, compaction and context epoch are its own, and a
 * scout burning through context cannot disturb the auditor beside it. The
 * session ID is reported on the outcome, ended well or badly, but nothing
 * writes it to the attempt yet: `AttemptStarted` carries the field and is
 * published before the session exists, and `AttemptSettled` has nowhere to put
 * it. Until that is settled in the ledger, a failed attempt's transcript is
 * only reachable through this outcome.
 *
 * The model is pinned at creation from what the worker asked for. If that model
 * is unavailable the attempt fails with `model_unavailable` rather than
 * quietly running on whatever the session would have picked — a worker spawned
 * to use Codestral that silently ran on something else makes every later
 * comparison between them meaningless.
 *
 * ## Permissions
 *
 * The worker carries a ruleset already clamped against its parent's, computed
 * when it was created. Capability monotonicity is therefore settled before an
 * attempt starts rather than negotiated here.
 *
 * What remains open is the last hop: the session runtime resolves permissions
 * from the agent, so the clamped ruleset is recorded on the worker and readable
 * afterwards, but a session does not yet accept an explicit ruleset to run
 * under. Until it does, a child whose agent is more permissive than its parent
 * is denied on paper and permitted in practice. That hop is tracked as
 * remaining phase 4 work and is not papered over here.
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

/**
 * What the session row says the attempt spent.
 *
 * Read on the way out of a failed attempt as well as a successful one: the
 * tokens are burned either way, and an attempt that reported zero would leave a
 * retried worker spending against a budget that never moves.
 */
const spent = (session: SessionSchema.Info): Job.Usage => ({
  tokensInput: session.tokens.input,
  tokensOutput: session.tokens.output,
  tokensCached: session.tokens.cache.read + session.tokens.cache.write,
  cost: session.cost,
})

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
        // Held outside the attempt so its failure path can still name the
        // session and charge what it spent.
        let sessionID: SessionSchema.ID | undefined
        // A worker that was given a tree works in it. Anchoring every session in
        // the shared job directory made the isolation decorative: the scheduler
        // provisioned a worktree, recorded it in the ledger, and then two writing
        // workers edited the same files anyway. Readers get no tree and share the
        // checkout, which is what `undefined` means here.
        const directory = input.worker.worktree?.directory ?? input.job.directory
        const outcome = yield* Effect.gen(function* () {
          const session = yield* sessions.create({
            location: { directory: AbsolutePath.make(directory) },
            agent: AgentV2.ID.make(input.worker.agent),
            model,
          })
          sessionID = session.id
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
            usage: spent(settled),
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const settled =
                sessionID === undefined
                  ? undefined
                  : yield* sessions.get(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
              return {
                ...reason(cause),
                ...(sessionID === undefined ? {} : { sessionID }),
                // A failed attempt that reached a model still resolved one, and
                // a fallback hidden by the failure is a fallback all the same.
                ...(settled?.model === undefined
                  ? {}
                  : {
                      resolved: {
                        providerID: settled.model.providerID,
                        modelID: settled.model.id,
                        ...(settled.model.variant === undefined ? {} : { variant: settled.model.variant }),
                      },
                    }),
                usage: settled ? spent(settled) : { tokensInput: 0, tokensOutput: 0, tokensCached: 0, cost: 0 },
              }
            }),
          ),
        )
        return outcome
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: JobExecutor.Service, layer, deps: [SessionV2.node] })

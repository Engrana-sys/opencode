export * as JobExecutor from "./executor"

import { Context, Effect, Layer } from "effect"
import type { Job } from "@opencode-ai/schema/job"
import { Node } from "../effect/app-node"
import { LayerNode } from "../effect/layer-node"
import type { SessionSchema } from "../session/schema"

/**
 * Runs one attempt.
 *
 * A seam, deliberately. The scheduler owns concurrency, retries and budgets and
 * can be tested end to end without a provider; what actually talks to a model
 * is injected. That division is also what lets a worker run under something
 * other than a session later — a shell verifier, say — without the scheduler
 * knowing.
 *
 * An executor reports how the attempt ended rather than failing. A failed
 * attempt is an ordinary outcome with a reason the retry policy can read, not
 * an error the scheduler has to interpret.
 *
 * @module
 */

export interface Input {
  readonly job: Job.Info
  readonly worker: Job.Worker
  readonly attempt: Job.Attempt
}

export interface Outcome {
  readonly exitReason: Job.ExitReason
  readonly usage: Job.Usage
  /** The model that actually answered, when one did. */
  readonly resolved?: Job.ModelRef
  readonly sessionID?: SessionSchema.ID
  readonly error?: string
}

export interface Interface {
  readonly run: (input: Input) => Effect.Effect<Outcome>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/JobExecutor") {}

/** Test and embedding seam for supplying an executor directly. */
export const layerWith = (run: Interface["run"]) => Layer.succeed(Service, Service.of({ run }))

/**
 * What a graph installs when it wants a scheduler but no model.
 *
 * It fails rather than pretending to work, and it fails with
 * `infrastructure_failure` rather than a reason that would look like the
 * worker's own fault. This keeps a scheduler observable before any executor
 * exists — but it has to be asked for, never inherited.
 */
export const unconfigured = layerWith(() =>
  Effect.succeed({
    exitReason: "infrastructure_failure" as const,
    usage: { tokensInput: 0, tokensOutput: 0, tokensCached: 0, cost: 0 },
    error: "No job executor is configured in this process.",
  }),
)

/**
 * Unbound: a graph installs its executor by replacing this node.
 *
 * A default bound here would be worse than none. The scheduler's dependencies
 * are sealed when its own node compiles, so a second binding of this tag merged
 * beside it in a group is never the one the scheduler calls: the real executor
 * would sit in the runtime, unused, while every attempt failed
 * `infrastructure_failure` and burned its retries in silence. Unbound, a graph
 * that forgets to install one fails to build instead.
 */
export const node = LayerNode.unbound(Service, Node.tags.values.global)

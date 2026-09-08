export * as SessionSystemModel from "./system-model"

import type { Model } from "@opencode-ai/llm"
import { Context, Effect, Layer, Option } from "effect"
import { Config } from "../config"
import { ConfigSystemModel } from "../config/system-model"
import { makeLocationNode } from "../effect/app-node"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"
import { SessionRunnerModel } from "./runner/model"

/**
 * Resolves the model chain behind one internal role.
 *
 * A role like `goal_evaluator` is infrastructure rather than a user choice, so
 * a single unavailable model must not disable it. `attempt` walks the
 * configured chain in order and returns the first usable answer, which lets a
 * caller express "keep trying until something answers" without each caller
 * reimplementing provider fallback.
 *
 * @module
 */

/** Roles the runtime resolves itself. Config may name others for plugins. */
export const GOAL_EVALUATOR = ConfigSystemModel.Role.make("goal_evaluator")

/** Splits a `providerID/modelID` value; model IDs may themselves contain slashes. */
export const parse = (value: string) => {
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) return undefined
  return {
    providerID: ProviderV2.ID.make(value.slice(0, separator)),
    modelID: ModelV2.ID.make(value.slice(separator + 1)),
  }
}

export interface Interface {
  /**
   * Models to try for one role, in order. `fallback` is appended last so a role
   * with no usable chain still runs on the session's own model.
   */
  readonly chain: (role: ConfigSystemModel.Role, fallback?: Model) => Effect.Effect<ReadonlyArray<Model>>
  /**
   * Runs `use` against each model in the chain until one produces a value,
   * returning undefined when every model in the chain declined.
   */
  readonly attempt: <A>(input: {
    readonly role: ConfigSystemModel.Role
    readonly fallback?: Model
    readonly use: (model: Model) => Effect.Effect<Option.Option<A>>
  }) => Effect.Effect<A | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionSystemModel") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const models = yield* SessionRunnerModel.Service
    const config = yield* Config.Service

    const configured = Effect.fn("SessionSystemModel.configured")(function* (role: ConfigSystemModel.Role) {
      const entries = yield* config.entries()
      // Later documents override earlier ones wholesale: a chain is one setting,
      // and merging two chains would produce an order nobody wrote.
      return entries
        .filter((entry): entry is Config.Document => entry.type === "document")
        .reduce((result, entry) => entry.info.system_models?.[role] ?? result, [] as ReadonlyArray<string>)
    })

    const chain = Effect.fn("SessionSystemModel.chain")(function* (role: ConfigSystemModel.Role, fallback?: Model) {
      const names = yield* configured(role)
      const resolved: Model[] = []
      for (const name of names) {
        const parsed = parse(name)
        if (parsed === undefined) {
          yield* Effect.logWarning(`Ignoring malformed ${role} model: ${name}`)
          continue
        }
        const model = yield* models.resolveNamed(parsed).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (model === undefined) {
          yield* Effect.logWarning(`Unavailable ${role} model: ${name}`)
          continue
        }
        resolved.push(model)
      }
      if (fallback !== undefined && !resolved.some((model) => model.id === fallback.id)) resolved.push(fallback)
      return resolved
    })

    return Service.of({
      chain,
      attempt: Effect.fn("SessionSystemModel.attempt")(function* (input) {
        for (const model of yield* chain(input.role, input.fallback)) {
          const result = yield* input.use(model)
          if (Option.isSome(result)) return result.value
          yield* Effect.logWarning(`Role ${input.role} fell through model ${model.provider}/${model.id}`)
        }
        return undefined
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [SessionRunnerModel.node, Config.node] })

import { describe, expect } from "bun:test"
import { Model } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Effect, Layer, Option } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { ConfigSystemModel } from "@opencode-ai/core/config/system-model"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionSystemModel } from "@opencode-ai/core/session/system-model"
import { testEffect } from "./lib/effect"

/**
 * The system-model chain is what keeps OpenCode's own internal work running
 * when a provider is down, so these tests are about degradation: an outage
 * must cost latency, never the feature.
 */

const make = (provider: string, id: string) => Model.make({ id, provider, route: OpenAIChat.route })

const primary = make("mistral", "codestral-latest")
const secondary = make("anthropic", "claude-haiku-4-5")
const sessionModel = make("openai", "gpt-5")

const available = [primary, secondary, sessionModel]

const models = SessionRunnerModel.layerWith(
  () => Effect.die("unused"),
  (input) => {
    const found = available.find(
      (model) => String(model.provider) === String(input.providerID) && String(model.id) === String(input.modelID),
    )
    return found
      ? Effect.succeed(found)
      : Effect.fail(new SessionRunnerModel.ModelUnavailableError({ providerID: input.providerID, modelID: input.modelID }))
  },
)

const config = (chain: ReadonlyArray<string>) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: new Config.Info({
              system_models: { [SessionSystemModel.GOAL_EVALUATOR]: chain } as ConfigSystemModel.Info,
            }),
          }),
        ]),
    }),
  )

const withChain = (chain: ReadonlyArray<string>) =>
  testEffect(
    AppNodeBuilder.build(SessionSystemModel.node, [
      [SessionRunnerModel.node, models],
      [Config.node, config(chain)],
    ]),
  )

describe("SessionSystemModel.parse", () => {
  const it = withChain([])
  it.effect("keeps slashes that belong to the model id", () =>
    Effect.sync(() => {
      expect(SessionSystemModel.parse("openrouter/qwen/qwen3-coder")).toEqual({
        providerID: ProviderV2.ID.make("openrouter"),
        modelID: ModelV2.ID.make("qwen/qwen3-coder"),
      })
    }),
  )

  it.effect("rejects values that name no provider or no model", () =>
    Effect.sync(() => {
      expect(SessionSystemModel.parse("codestral-latest")).toBeUndefined()
      expect(SessionSystemModel.parse("/codestral")).toBeUndefined()
      expect(SessionSystemModel.parse("mistral/")).toBeUndefined()
    }),
  )
})

describe("SessionSystemModel.chain", () => {
  const it = withChain(["mistral/codestral-latest", "anthropic/claude-haiku-4-5"])

  it.effect("resolves the configured chain in order", () =>
    Effect.gen(function* () {
      const system = yield* SessionSystemModel.Service
      expect((yield* system.chain(SessionSystemModel.GOAL_EVALUATOR)).map((model) => String(model.id))).toEqual([
        "codestral-latest",
        "claude-haiku-4-5",
      ])
    }),
  )

  it.effect("appends the session model as a last resort", () =>
    Effect.gen(function* () {
      const system = yield* SessionSystemModel.Service
      expect(
        (yield* system.chain(SessionSystemModel.GOAL_EVALUATOR, sessionModel)).map((model) => String(model.id)),
      ).toEqual(["codestral-latest", "claude-haiku-4-5", "gpt-5"])
    }),
  )
})

describe("SessionSystemModel.chain with unusable entries", () => {
  const it = withChain(["mistral/not-installed", "nonsense", "anthropic/claude-haiku-4-5"])

  it.effect("skips unavailable and malformed entries instead of failing", () =>
    Effect.gen(function* () {
      const system = yield* SessionSystemModel.Service
      expect((yield* system.chain(SessionSystemModel.GOAL_EVALUATOR)).map((model) => String(model.id))).toEqual([
        "claude-haiku-4-5",
      ])
    }),
  )
})

describe("SessionSystemModel.chain with no configuration", () => {
  const it = withChain([])

  it.effect("still runs on the caller's fallback", () =>
    Effect.gen(function* () {
      const system = yield* SessionSystemModel.Service
      expect((yield* system.chain(SessionSystemModel.GOAL_EVALUATOR, sessionModel)).map((model) => String(model.id))).toEqual([
        "gpt-5",
      ])
    }),
  )

  it.effect("returns nothing to try when there is no fallback either", () =>
    Effect.gen(function* () {
      const system = yield* SessionSystemModel.Service
      expect(yield* system.chain(SessionSystemModel.GOAL_EVALUATOR)).toEqual([])
    }),
  )
})

describe("SessionSystemModel.attempt", () => {
  const it = withChain(["mistral/codestral-latest", "anthropic/claude-haiku-4-5"])

  it.effect("stops at the first model that answers", () =>
    Effect.gen(function* () {
      const system = yield* SessionSystemModel.Service
      const tried: string[] = []
      const result = yield* system.attempt({
        role: SessionSystemModel.GOAL_EVALUATOR,
        use: (model) =>
          Effect.sync(() => {
            tried.push(String(model.id))
            return Option.some(String(model.id))
          }),
      })
      expect(result).toBe("codestral-latest")
      expect(tried).toEqual(["codestral-latest"])
    }),
  )

  it.effect("falls through to the next model when one declines", () =>
    Effect.gen(function* () {
      const system = yield* SessionSystemModel.Service
      const tried: string[] = []
      const result = yield* system.attempt({
        role: SessionSystemModel.GOAL_EVALUATOR,
        fallback: sessionModel,
        use: (model) =>
          Effect.sync(() => {
            tried.push(String(model.id))
            return String(model.id) === "claude-haiku-4-5" ? Option.some("judged") : Option.none<string>()
          }),
      })
      expect(result).toBe("judged")
      expect(tried).toEqual(["codestral-latest", "claude-haiku-4-5"])
    }),
  )

  it.effect("reports failure only once every model has declined", () =>
    Effect.gen(function* () {
      const system = yield* SessionSystemModel.Service
      const tried: string[] = []
      const result = yield* system.attempt({
        role: SessionSystemModel.GOAL_EVALUATOR,
        fallback: sessionModel,
        use: (model) =>
          Effect.sync(() => {
            tried.push(String(model.id))
            return Option.none<string>()
          }),
      })
      expect(result).toBeUndefined()
      expect(tried).toEqual(["codestral-latest", "claude-haiku-4-5", "gpt-5"])
    }),
  )
})

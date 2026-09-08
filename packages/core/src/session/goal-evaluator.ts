export * as SessionGoalEvaluator from "./goal-evaluator"

import { LLM, LLMClient, LLMEvent, Message, type LLMRequest, type Model } from "@opencode-ai/llm"
import { Context, Effect, Layer, Option, Stream } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { Token } from "../util/token"
import { SessionCompaction } from "./compaction"
import type { SessionMessage } from "./message"
import { SessionSystemModel } from "./system-model"

/**
 * Judges whether a session's goal condition holds.
 *
 * The judge is deliberately not the model that did the work: a model asked to
 * grade its own transcript reliably finds it satisfactory. A separate small
 * model reading only the recent transcript is both cheaper and better
 * calibrated, so the `goal_evaluator` system-model chain selects one
 * independently.
 *
 * The chain matters as much as the choice. A goal that cannot be judged stops
 * the session, so an unreachable provider would silently disable the feature.
 * Each model in the chain is tried in turn, and only an empty chain gives up.
 *
 * @module
 */

const TRANSCRIPT_TOKENS = 6_000
const VERDICT_OUTPUT_TOKENS = 256

const INSTRUCTIONS = `You are judging whether a stated condition now holds, based only on the transcript.

Rules:
- Judge the condition, not the effort. A thorough attempt that did not achieve the condition is NOT_MET.
- The assistant asserting that something works is not evidence. Look for tool results that show it: passing tests, successful commands, file contents.
- If the transcript does not contain enough evidence either way, answer NOT_MET.
- If the condition is met, answer MET even when unrelated work remains.

Respond with exactly two lines and nothing else:
VERDICT: MET or NOT_MET
REASON: one sentence, naming the evidence you used`

export interface Verdict {
  /** False when the judge could not run; the caller stops rather than looping blind. */
  readonly evaluated: boolean
  readonly met: boolean
  readonly reason: string
}

const selectTranscript = (entries: ReadonlyArray<SessionMessage.Message>) => {
  const lines = entries.map(SessionCompaction.serialize).filter(Boolean)
  let total = 0
  let split = lines.length
  for (let index = lines.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(lines[index])
    if (next > TRANSCRIPT_TOKENS) break
    total = next
    split = index
  }
  return lines.slice(split).join("\n\n")
}

export const buildPrompt = (input: { readonly condition: string; readonly transcript: string }) =>
  [
    `<condition>\n${input.condition}\n</condition>`,
    `<transcript>\n${input.transcript}\n</transcript>`,
    INSTRUCTIONS,
  ].join("\n\n")

export const parseVerdict = (text: string): Verdict | undefined => {
  const verdict = /VERDICT:\s*(MET|NOT[_\s-]?MET)/i.exec(text)
  if (!verdict) return undefined
  const reason = /REASON:\s*(.+)/i.exec(text)
  return {
    evaluated: true,
    met: !/NOT/i.test(verdict[1]),
    reason: reason?.[1].trim() ?? "No reason given.",
  }
}

export interface Interface {
  readonly evaluate: (input: {
    readonly condition: string
    readonly entries: ReadonlyArray<SessionMessage.Message>
    /** The session's own model, used when no judge is configured or the configured one is unavailable. */
    readonly fallback: Model
    readonly http?: LLMRequest["http"]
  }) => Effect.Effect<Verdict>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionGoalEvaluator") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const llm = yield* LLMClient.Service
    const systemModels = yield* SessionSystemModel.Service

    /** One attempt against one model. None means "try the next model in the chain". */
    const ask = (model: Model, prompt: string, http: LLMRequest["http"] | undefined) =>
      Effect.gen(function* () {
        const chunks: string[] = []
        let failed = false
        const completed = yield* llm
          .stream(
            LLM.request({
              model,
              ...(http === undefined ? {} : { http }),
              messages: [Message.user(prompt)],
              tools: [],
              generation: { maxTokens: VERDICT_OUTPUT_TOKENS },
            }),
          )
          .pipe(
            Stream.runForEach((event) => {
              if (LLMEvent.is.providerError(event)) failed = true
              if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
              return Effect.void
            }),
            Effect.as(true),
            Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
          )
        if (!completed || failed) return Option.none<Verdict>()
        // An unreadable verdict is this model's failure, not the chain's: try the next one.
        const verdict = parseVerdict(chunks.join(""))
        return verdict === undefined ? Option.none<Verdict>() : Option.some(verdict)
      })

    return Service.of({
      evaluate: Effect.fn("SessionGoalEvaluator.evaluate")(function* (input) {
        const prompt = buildPrompt({
          condition: input.condition,
          transcript: selectTranscript(input.entries),
        })
        const verdict = yield* systemModels.attempt({
          role: SessionSystemModel.GOAL_EVALUATOR,
          fallback: input.fallback,
          use: (model) => ask(model, prompt, input.http),
        })
        return (
          verdict ?? {
            evaluated: false,
            met: false,
            reason: "No goal evaluator model produced a usable verdict.",
          }
        )
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [llmClient, SessionSystemModel.node],
})

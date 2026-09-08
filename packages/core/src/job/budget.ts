export * as JobBudget from "./budget"

import type { Job } from "@opencode-ai/schema/job"

/**
 * Decides whether a job may keep spending.
 *
 * Pure, so the rule can be checked anywhere without a clock or a database. The
 * scheduler asks before admitting more work and the runner asks before starting
 * another turn; neither needs to know how a limit is shaped.
 *
 * A budget that only logged when it was passed would not be a budget. Reaching
 * a limit settles the job, which is why `Exhausted` names the limit that was
 * hit: a job that stopped must be able to say what stopped it.
 *
 * @module
 */

/** Fraction of a limit at which a job is close enough to be worth reporting. */
export const WARNING_THRESHOLD = 0.8

export type Limit = "cost" | "tokens" | "wall_time" | "workers"

export type Verdict =
  | { readonly _tag: "Ok" }
  | { readonly _tag: "Warning"; readonly limit: Limit; readonly used: number; readonly of: number }
  | { readonly _tag: "Exhausted"; readonly limit: Limit; readonly used: number; readonly of: number }

export interface Spend {
  readonly usage: Job.Usage
  readonly workers: number
  readonly elapsedMs: number
}

/** Tokens spent against a budget are the ones that were paid for. */
export const tokens = (usage: Job.Usage) => usage.tokensInput + usage.tokensOutput

const measure = (limit: Limit, used: number, of: number | undefined) =>
  of === undefined || of <= 0 ? undefined : { limit, used, of }

/**
 * The worst standing across every limit.
 *
 * Exhaustion wins over a warning, and among limits of the same severity the one
 * furthest along is reported, so the message names what actually stopped the
 * job rather than whichever limit happened to be checked first.
 */
export const evaluate = (input: { readonly budget?: Job.Budget; readonly spend: Spend }): Verdict => {
  const budget = input.budget
  if (!budget) return { _tag: "Ok" }
  const measured = [
    measure("cost", input.spend.usage.cost, budget.maxCost),
    measure("tokens", tokens(input.spend.usage), budget.maxTokens),
    measure("wall_time", input.spend.elapsedMs, budget.maxWallTimeMs),
    measure("workers", input.spend.workers, budget.maxWorkers),
  ].filter((item) => item !== undefined)

  const worst = measured
    .map((item) => ({ ...item, ratio: item.used / item.of }))
    .sort((left, right) => right.ratio - left.ratio)[0]
  if (!worst) return { _tag: "Ok" }
  if (worst.ratio >= 1) return { _tag: "Exhausted", limit: worst.limit, used: worst.used, of: worst.of }
  if (worst.ratio >= WARNING_THRESHOLD)
    return { _tag: "Warning", limit: worst.limit, used: worst.used, of: worst.of }
  return { _tag: "Ok" }
}

export const isExhausted = (verdict: Verdict): verdict is Extract<Verdict, { _tag: "Exhausted" }> =>
  verdict._tag === "Exhausted"

export const describe = (verdict: Verdict) => {
  if (verdict._tag === "Ok") return "Within budget."
  const state = verdict._tag === "Exhausted" ? "Budget exhausted" : "Approaching budget"
  return `${state}: ${verdict.limit} at ${verdict.used} of ${verdict.of}.`
}

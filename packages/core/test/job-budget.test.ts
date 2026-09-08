import { describe, expect, it } from "bun:test"
import { Job } from "@opencode-ai/schema/job"
import { JobBudget } from "@opencode-ai/core/job/budget"

const spend = (input: {
  readonly cost?: number
  readonly input?: number
  readonly output?: number
  readonly cached?: number
  readonly workers?: number
  readonly elapsedMs?: number
}): JobBudget.Spend => ({
  usage: {
    tokensInput: input.input ?? 0,
    tokensOutput: input.output ?? 0,
    tokensCached: input.cached ?? 0,
    cost: input.cost ?? 0,
  },
  workers: input.workers ?? 0,
  elapsedMs: input.elapsedMs ?? 0,
})

describe("JobBudget.evaluate", () => {
  it("a job with no budget is never stopped by one", () => {
    expect(JobBudget.evaluate({ spend: spend({ cost: 1_000, workers: 500 }) })).toEqual({ _tag: "Ok" })
  })

  it("stays quiet well below every limit", () => {
    const verdict = JobBudget.evaluate({
      budget: { maxCost: 10, maxTokens: 100_000 },
      spend: spend({ cost: 1, input: 5_000 }),
    })
    expect(verdict._tag).toBe("Ok")
  })

  it("warns before it stops", () => {
    const verdict = JobBudget.evaluate({ budget: { maxCost: 10 }, spend: spend({ cost: 8.5 }) })
    expect(verdict._tag).toBe("Warning")
    expect(verdict).toMatchObject({ limit: "cost" })
  })

  it("exhausts exactly at the limit, not past it", () => {
    // Reaching the limit is spending it; waiting for an overshoot means the
    // overshoot is what gets billed.
    expect(JobBudget.evaluate({ budget: { maxCost: 10 }, spend: spend({ cost: 10 }) })._tag).toBe("Exhausted")
  })

  it("counts the tokens that were paid for", () => {
    const verdict = JobBudget.evaluate({
      budget: { maxTokens: 1_000 },
      // Cached tokens are not free, but they are not what a token budget bounds:
      // input plus output is the spend a caller controls.
      spend: spend({ input: 600, output: 400, cached: 5_000 }),
    })
    expect(verdict._tag).toBe("Exhausted")
    expect(verdict).toMatchObject({ limit: "tokens", used: 1_000 })
  })

  it("bounds wall time and worker count too", () => {
    expect(
      JobBudget.evaluate({ budget: { maxWallTimeMs: 60_000 }, spend: spend({ elapsedMs: 60_001 }) }),
    ).toMatchObject({ _tag: "Exhausted", limit: "wall_time" })
    expect(JobBudget.evaluate({ budget: { maxWorkers: 4 }, spend: spend({ workers: 4 }) })).toMatchObject({
      _tag: "Exhausted",
      limit: "workers",
    })
  })

  it("names the limit that actually stopped the job", () => {
    const verdict = JobBudget.evaluate({
      budget: { maxCost: 10, maxTokens: 1_000, maxWorkers: 100 },
      // Cost is merely close; tokens are spent. The job stopped on tokens.
      spend: spend({ cost: 8.1, input: 1_200, workers: 1 }),
    })
    expect(verdict).toMatchObject({ _tag: "Exhausted", limit: "tokens" })
  })

  it("reports the nearest limit when several are only close", () => {
    const verdict = JobBudget.evaluate({
      budget: { maxCost: 10, maxTokens: 1_000 },
      spend: spend({ cost: 8.1, input: 950 }),
    })
    expect(verdict).toMatchObject({ _tag: "Warning", limit: "tokens" })
  })

  it("ignores a limit set to zero rather than stopping instantly", () => {
    // A zero is a caller that meant "no limit", not "allow nothing".
    expect(JobBudget.evaluate({ budget: { maxCost: 0 }, spend: spend({ cost: 5 }) })._tag).toBe("Ok")
  })

  it("says what stopped it", () => {
    const verdict = JobBudget.evaluate({ budget: { maxCost: 2 }, spend: spend({ cost: 2 }) })
    expect(JobBudget.isExhausted(verdict)).toBe(true)
    expect(JobBudget.describe(verdict)).toBe("Budget exhausted: cost at 2 of 2.")
  })

  it("tokens counts input and output", () => {
    const usage: Job.Usage = { tokensInput: 10, tokensOutput: 5, tokensCached: 100, cost: 0 }
    expect(JobBudget.tokens(usage)).toBe(15)
  })
})

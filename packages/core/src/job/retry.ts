export * as JobRetry from "./retry"

import { Job } from "@opencode-ai/schema/job"

/**
 * Decides whether and when a failed attempt runs again.
 *
 * Kept pure and separate from the scheduler so the policy can be reasoned about
 * and tested without a clock, a database or a provider. The scheduler asks; it
 * does not decide.
 *
 * Retrying everything burns a job's budget on failures that will never succeed —
 * a permission denial is a decision, not an outage. Retrying nothing wastes the
 * failures that would have succeeded on the next call. `Job.isRetryable` draws
 * that line by exit reason, and this module says how long to wait.
 *
 * @module
 */

export const DEFAULT_MAX_ATTEMPTS = 3
export const BASE_DELAY = 1_000
export const MAX_DELAY = 60_000

export interface Policy {
  readonly maxAttempts: number
  readonly baseDelay: number
  readonly maxDelay: number
}

export const defaultPolicy: Policy = {
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  baseDelay: BASE_DELAY,
  maxDelay: MAX_DELAY,
}

export type Decision =
  | { readonly _tag: "Retry"; readonly delay: number; readonly reason: string }
  | { readonly _tag: "Stop"; readonly reason: string }

/**
 * Exponential backoff with full jitter.
 *
 * Jitter is not decoration. Without it, a rate limit that fails ten workers at
 * once retries all ten at the same instant and reproduces the same rate limit;
 * spreading them across the window is what lets some succeed. `random` is a
 * parameter so a test can pin it.
 */
export const delay = (attempt: number, policy: Policy = defaultPolicy, random: () => number = Math.random) => {
  const ceiling = Math.min(policy.maxDelay, policy.baseDelay * 2 ** Math.max(0, attempt - 1))
  return Math.round(random() * ceiling)
}

/**
 * A rate limit is retryable but not on the ordinary curve: the provider has
 * told us to wait, so the first retry starts at the ceiling rather than
 * climbing to it.
 */
const isSlow = (reason: Job.ExitReason) => reason === "rate_limited"

export const decide = (input: {
  readonly exitReason: Job.ExitReason
  /** Attempts already made, including the one that just failed. */
  readonly attempts: number
  readonly policy?: Policy
  readonly random?: () => number
}): Decision => {
  const policy = input.policy ?? defaultPolicy
  if (input.exitReason === "success") return { _tag: "Stop", reason: "The attempt succeeded." }
  if (!Job.isRetryable(input.exitReason))
    return { _tag: "Stop", reason: `${input.exitReason} is a decision, not a transient failure.` }
  if (input.attempts >= policy.maxAttempts)
    return { _tag: "Stop", reason: `Exhausted ${policy.maxAttempts} attempts after ${input.exitReason}.` }
  return {
    _tag: "Retry",
    delay: isSlow(input.exitReason)
      ? delay(policy.maxAttempts, policy, input.random)
      : delay(input.attempts, policy, input.random),
    reason: input.exitReason,
  }
}

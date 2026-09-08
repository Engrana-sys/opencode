export * as JobAdmission from "./admission"

import type { Job } from "@opencode-ai/schema/job"

/**
 * Decides which queued workers may start right now.
 *
 * Pure, and separate from whatever runs them. Concurrency control is the part
 * of a scheduler most worth testing and least worth testing through a provider,
 * so this module takes the queue and what is already running and returns the
 * subset that fits.
 *
 * @module
 */

export interface Limits {
  /** Ceiling across everything this process runs. */
  readonly global: number
  readonly perProject?: number
  readonly perProvider?: number
  readonly perModel?: number
}

export const defaultLimits: Limits = { global: 4, perProject: 4, perProvider: 4, perModel: 2 }

export interface Candidate {
  readonly workerID: Job.WorkerID
  readonly jobID: Job.ID
  readonly projectID: string
  readonly requested: Job.ModelRef
  /** Higher runs first. Equal priorities fall back to arrival order. */
  readonly priority?: number
  readonly enqueuedAt: number
}

export interface Running {
  readonly projectID: string
  readonly providerID: string
  readonly modelID: string
}

const key = (providerID: string, modelID: string) => `${providerID}/${modelID}`

const count = <T>(items: Iterable<T>, pick: (item: T) => string) => {
  const result = new Map<string, number>()
  for (const item of items) {
    const value = pick(item)
    result.set(value, (result.get(value) ?? 0) + 1)
  }
  return result
}

const under = (counts: Map<string, number>, value: string, limit: number | undefined) =>
  limit === undefined || (counts.get(value) ?? 0) < limit

/**
 * Priority first, then arrival order.
 *
 * Ties break on arrival rather than on whatever order the database returned, so
 * a worker cannot be starved by newer work at the same priority.
 */
export const order = (candidates: ReadonlyArray<Candidate>) =>
  [...candidates].sort(
    (left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.enqueuedAt - right.enqueuedAt,
  )

/**
 * The queued workers that fit within every limit.
 *
 * A candidate that does not fit is skipped rather than blocking the ones behind
 * it. Stopping at the first candidate that does not fit would let one saturated
 * provider idle every free slot — a queue full of Mistral work would keep an
 * Anthropic worker waiting for capacity it does not need. Skipping keeps the
 * pool rolling; ordering keeps it fair.
 */
export const admit = (input: {
  readonly candidates: ReadonlyArray<Candidate>
  readonly running: ReadonlyArray<Running>
  readonly limits?: Limits
}): ReadonlyArray<Candidate> => {
  const limits = input.limits ?? defaultLimits
  const projects = count(input.running, (item) => item.projectID)
  const providers = count(input.running, (item) => item.providerID)
  const models = count(input.running, (item) => key(item.providerID, item.modelID))
  let total = input.running.length

  const admitted: Candidate[] = []
  for (const candidate of order(input.candidates)) {
    if (total >= limits.global) break
    const provider = candidate.requested.providerID
    const model = key(provider, candidate.requested.modelID)
    if (!under(projects, candidate.projectID, limits.perProject)) continue
    if (!under(providers, provider, limits.perProvider)) continue
    if (!under(models, model, limits.perModel)) continue
    admitted.push(candidate)
    // Count admissions as they happen: this batch competes with itself for the
    // same slots, not only with what was already running.
    projects.set(candidate.projectID, (projects.get(candidate.projectID) ?? 0) + 1)
    providers.set(provider, (providers.get(provider) ?? 0) + 1)
    models.set(model, (models.get(model) ?? 0) + 1)
    total++
  }
  return admitted
}

export * as Capability from "./capability"

import type { Permission } from "@opencode-ai/schema/permission"
import { PermissionV2 } from "../permission"

/**
 * Capability monotonicity.
 *
 * A worker spawned by another worker must never be able to do more than the one
 * that spawned it. Without that, delegation is an escalation path: an agent
 * denied `bash` reaches it by spawning a child whose agent allows it, and the
 * denial it was given means nothing.
 *
 * Rulesets cannot be intersected syntactically — they are ordered wildcard
 * rules where the last match wins, so two rulesets have no meaningful set
 * intersection. What can be intersected is the *decision*: evaluate the same
 * action and resource against every ruleset in the chain and keep the most
 * restrictive answer. That is what these functions do, and it holds whatever
 * shape the individual rulesets take.
 *
 * @module
 */

/** How restrictive each effect is. A larger rank wins a comparison. */
const RANK: Readonly<Record<Permission.Effect, number>> = { allow: 0, ask: 1, deny: 2 }

/** The more restrictive of two effects. Denial is absorbing; asking beats allowing. */
export const restrict = (left: Permission.Effect, right: Permission.Effect): Permission.Effect =>
  RANK[left] >= RANK[right] ? left : right

/**
 * The effect for one action and resource across a whole chain of rulesets,
 * ordered from the outermost ancestor to the worker itself.
 *
 * A ruleset with no rule for this action and resource has no opinion and is
 * skipped, rather than counting as `ask`. That is what makes inheritance work:
 * a child naming one resource would otherwise silently put a question mark over
 * everything else its parent had already allowed. Only the rulesets that
 * actually speak are intersected, and the most restrictive of them wins.
 *
 * If nobody speaks — an empty chain, or a chain where no ruleset matches — the
 * answer is `ask`. An unknown authority is not a permissive one.
 */
export const effective = (input: {
  readonly action: string
  readonly resource: string
  readonly chain: ReadonlyArray<Permission.Ruleset>
}): Permission.Effect => {
  const spoken = input.chain
    .map((ruleset) => PermissionV2.match(input.action, input.resource, ruleset)?.effect)
    .filter((effect): effect is Permission.Effect => effect !== undefined)
  if (spoken.length === 0) return "ask"
  return spoken.reduce(restrict)
}

/**
 * Whether a child would gain something its parent does not have.
 *
 * Used to decide whether spawning needs human approval: a child asking only for
 * what its parent already holds is ordinary delegation, while one asking for
 * more is an escalation and must be approved rather than silently granted.
 */
export const widens = (input: {
  readonly action: string
  readonly resource: string
  readonly parent: Permission.Ruleset
  readonly child: Permission.Ruleset
}) => {
  const parent = PermissionV2.evaluate(input.action, input.resource, input.parent).effect
  const child = PermissionV2.evaluate(input.action, input.resource, input.child).effect
  return RANK[child] < RANK[parent]
}

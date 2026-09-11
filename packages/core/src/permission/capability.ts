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
 * An empty chain is `ask` rather than `allow`: an unknown authority is not a
 * permissive one.
 */
export const effective = (input: {
  readonly action: string
  readonly resource: string
  readonly chain: ReadonlyArray<Permission.Ruleset>
}): Permission.Effect => {
  if (input.chain.length === 0) return "ask"
  return input.chain
    .map((ruleset) => PermissionV2.evaluate(input.action, input.resource, ruleset).effect)
    .reduce(restrict)
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

/**
 * Rewrites a child's ruleset so it can never exceed its parent.
 *
 * The result is a ruleset that can be handed to ordinary evaluation with no
 * further ceremony — which matters, because a rule that has to be remembered is
 * a rule that gets forgotten. Getting there takes three layers, and the order is
 * the whole mechanism:
 *
 * 1. **The parent's rules**, so anything the child does not mention still falls
 *    under them.
 * 2. **The child's rules**, capped rule by rule, so the child can narrow what it
 *    was given.
 * 3. **The parent's restrictions again, last.** `PermissionV2.evaluate` resolves
 *    by `findLast`, so whatever sits at the end has the final word. Without this
 *    layer a child rule that is merely *broader* than the parent's denial wins
 *    over it: a parent denying `rm *` and allowing everything else, given a
 *    child that allows `*`, would permit `rm -rf /`. The per-rule cap in layer 2
 *    cannot catch that on its own, because it asks the parent about the child's
 *    pattern as though the pattern were a concrete resource, and `rm *` does not
 *    match the literal string `*`.
 *
 * A rule that only ever loosens is not a restriction, which is why layer 3 keeps
 * `deny` and `ask` and drops `allow`: re-appending the parent's permissions would
 * undo the narrowing the child is entitled to make.
 */
export const clamp = (input: {
  readonly parent: Permission.Ruleset
  readonly child: Permission.Ruleset
}): Permission.Ruleset => [
  ...input.parent,
  ...input.child.map((rule) => ({
    ...rule,
    effect: restrict(rule.effect, PermissionV2.evaluate(rule.action, rule.resource, input.parent).effect),
  })),
  ...input.parent.filter((rule) => rule.effect !== "allow"),
]

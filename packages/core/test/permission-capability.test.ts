import { describe, expect, it } from "bun:test"
import type { Permission } from "@opencode-ai/schema/permission"
import { Capability } from "@opencode-ai/core/permission/capability"
import { PermissionV2 } from "@opencode-ai/core/permission"

/**
 * These are the adversarial tests for capability monotonicity. Each one is a
 * way a child could out-reach its parent if the rule were merely conventional.
 */

const rule = (action: string, resource: string, effect: Permission.Effect): Permission.Rule => ({
  action,
  resource,
  effect,
})

const denyBash: Permission.Ruleset = [rule("bash", "*", "deny")]
const allowBash: Permission.Ruleset = [rule("bash", "*", "allow")]
const allowAll: Permission.Ruleset = [rule("*", "*", "allow")]

describe("Capability.restrict", () => {
  it("denial absorbs everything", () => {
    expect(Capability.restrict("deny", "allow")).toBe("deny")
    expect(Capability.restrict("allow", "deny")).toBe("deny")
    expect(Capability.restrict("deny", "ask")).toBe("deny")
  })

  it("asking beats allowing", () => {
    expect(Capability.restrict("ask", "allow")).toBe("ask")
    expect(Capability.restrict("allow", "ask")).toBe("ask")
  })

  it("two allows stay an allow", () => {
    expect(Capability.restrict("allow", "allow")).toBe("allow")
  })
})

describe("Capability.effective", () => {
  it("a child cannot reach what its parent was denied", () => {
    // The escalation this exists to stop: an agent denied bash spawning a child
    // whose own agent allows it.
    expect(
      Capability.effective({ action: "bash", resource: "*", chain: [denyBash, allowBash] }),
    ).toBe("deny")
  })

  it("a denial anywhere in the chain holds all the way down", () => {
    // A grandchild cannot recover what its grandparent forbade, even if every
    // link between them is permissive.
    expect(
      Capability.effective({ action: "bash", resource: "*", chain: [denyBash, allowAll, allowAll] }),
    ).toBe("deny")
  })

  it("delegation still works when nobody objects", () => {
    expect(Capability.effective({ action: "read", resource: "*", chain: [allowAll, allowAll] })).toBe("allow")
  })

  it("an ask by the parent is not silently upgraded by a permissive child", () => {
    expect(
      Capability.effective({
        action: "bash",
        resource: "*",
        chain: [[rule("bash", "*", "ask")], allowBash],
      }),
    ).toBe("ask")
  })

  it("an unknown authority is not a permissive one", () => {
    // An empty chain means nobody granted anything; defaulting to allow here
    // would make a missing parent the most powerful parent of all.
    expect(Capability.effective({ action: "bash", resource: "*", chain: [] })).toBe("ask")
  })

  it("narrowing by resource is respected in both directions", () => {
    const parent: Permission.Ruleset = [rule("edit", "*", "allow"), rule("edit", "/etc/**", "deny")]
    expect(Capability.effective({ action: "edit", resource: "/src/a.ts", chain: [parent, allowAll] })).toBe(
      "allow",
    )
    expect(Capability.effective({ action: "edit", resource: "/etc/passwd", chain: [parent, allowAll] })).toBe(
      "deny",
    )
  })
})

describe("Capability.widens", () => {
  it("spots a child asking for more than its parent holds", () => {
    expect(Capability.widens({ action: "bash", resource: "*", parent: denyBash, child: allowBash })).toBe(true)
  })

  it("ordinary delegation is not an escalation", () => {
    expect(Capability.widens({ action: "bash", resource: "*", parent: allowBash, child: allowBash })).toBe(false)
    // Asking for less than the parent holds is narrowing, not widening.
    expect(Capability.widens({ action: "bash", resource: "*", parent: allowBash, child: denyBash })).toBe(false)
  })
})

describe("a chain, not a flattened ruleset", () => {
  /**
   * These replace the tests for a `clamp` that produced one ruleset from two.
   * It could not be made sound: two ordered wildcard rulesets have no
   * intersection expressible as a third, and every ordering traded one hole for
   * another. Evaluating the chain per query has neither problem.
   */
  it("a child cannot re-open a resource its parent closed", () => {
    const parent: Permission.Ruleset = [rule("edit", "*", "allow"), rule("edit", "/etc/**", "deny")]
    const child: Permission.Ruleset = [rule("edit", "/etc/passwd", "allow")]
    expect(Capability.effective({ action: "edit", resource: "/etc/passwd", chain: [parent, child] })).toBe("deny")
    expect(Capability.effective({ action: "edit", resource: "/src/a.ts", chain: [parent, child] })).toBe("allow")
  })

  it("a child cannot reach past a narrow denial by asking broadly", () => {
    // The case a per-rule cap cannot catch: capping asks the parent about the
    // child's *pattern*, and `rm *` does not match the literal string `*`.
    const parent: Permission.Ruleset = [rule("bash", "*", "allow"), rule("bash", "rm *", "deny")]
    const child: Permission.Ruleset = [rule("bash", "*", "allow")]
    expect(Capability.effective({ action: "bash", resource: "rm -rf /", chain: [parent, child] })).toBe("deny")
    expect(Capability.effective({ action: "bash", resource: "ls", chain: [parent, child] })).toBe("allow")
  })

  it("a parent's own exceptions survive having a child", () => {
    // What flattening broke: re-appending the parent's broad denial after its
    // own narrower allow made every child stricter than its parent, so a chain
    // with an empty child was not the parent.
    const parent: Permission.Ruleset = [rule("bash", "*", "deny"), rule("bash", "ls *", "allow")]
    expect(Capability.effective({ action: "bash", resource: "ls -la", chain: [parent] })).toBe("allow")
    expect(Capability.effective({ action: "bash", resource: "ls -la", chain: [parent, []] })).toBe("allow")
    expect(Capability.effective({ action: "bash", resource: "rm -rf /", chain: [parent, []] })).toBe("deny")
  })

  it("a child can deny what its parent only asks about", () => {
    // The other half flattening broke: the parent's `ask`, re-appended last,
    // overrode the child's own denial. Narrowing is a child's prerogative.
    const parent: Permission.Ruleset = [rule("*", "*", "allow"), rule("bash", "*", "ask")]
    const child: Permission.Ruleset = [rule("bash", "rm *", "deny")]
    expect(Capability.effective({ action: "bash", resource: "rm -rf /", chain: [parent, child] })).toBe("deny")
    expect(Capability.effective({ action: "bash", resource: "ls", chain: [parent, child] })).toBe("ask")
    expect(Capability.effective({ action: "read", resource: "/src/a.ts", chain: [parent, child] })).toBe("allow")
  })
})

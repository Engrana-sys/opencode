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

describe("Capability.clamp", () => {
  it("produces a ruleset that ordinary evaluation can use unchanged", () => {
    // The clamped set has to be safe on its own: a rule that must be remembered
    // separately is a rule that gets forgotten at the call site.
    const clamped = Capability.clamp({ parent: denyBash, child: allowBash })
    expect(PermissionV2.evaluate("bash", "*", clamped).effect).toBe("deny")
  })

  it("keeps what the parent allowed and the child did not mention", () => {
    const clamped = Capability.clamp({ parent: allowAll, child: [rule("bash", "*", "deny")] })
    expect(PermissionV2.evaluate("read", "*", clamped).effect).toBe("allow")
    // The child's own tightening survives.
    expect(PermissionV2.evaluate("bash", "*", clamped).effect).toBe("deny")
  })

  it("a child cannot re-open a resource its parent closed", () => {
    const parent: Permission.Ruleset = [rule("edit", "*", "allow"), rule("edit", "/etc/**", "deny")]
    const clamped = Capability.clamp({ parent, child: [rule("edit", "/etc/passwd", "allow")] })
    expect(PermissionV2.evaluate("edit", "/etc/passwd", clamped).effect).toBe("deny")
    expect(PermissionV2.evaluate("edit", "/src/a.ts", clamped).effect).toBe("allow")
  })

  it("a child cannot reach past a narrow denial by asking broadly", () => {
    // The mirror of the test above, and the harder half. Capping a child rule
    // asks the parent about the child's *pattern* as though it were a resource,
    // and `rm *` does not match the literal string `*` — so the cap sees no
    // objection and the broad child rule, sitting last, would otherwise win.
    const parent: Permission.Ruleset = [rule("bash", "*", "allow"), rule("bash", "rm *", "deny")]
    const clamped = Capability.clamp({ parent, child: [rule("bash", "*", "allow")] })
    expect(PermissionV2.evaluate("bash", "rm -rf /", parent).effect).toBe("deny")
    expect(PermissionV2.evaluate("bash", "rm -rf /", clamped).effect).toBe("deny")
    // And the delegation is still worth having: everything else still runs.
    expect(PermissionV2.evaluate("bash", "ls", clamped).effect).toBe("allow")
  })

  it("an ask the parent imposed is not downgraded by a broad child allow", () => {
    // `ask` is a restriction too. A child that allows everything must still stop
    // at a question its parent wanted asked.
    const parent: Permission.Ruleset = [rule("*", "*", "allow"), rule("webfetch", "*", "ask")]
    const clamped = Capability.clamp({ parent, child: [rule("*", "*", "allow")] })
    expect(PermissionV2.evaluate("webfetch", "https://example.com", clamped).effect).toBe("ask")
    expect(PermissionV2.evaluate("read", "/src/a.ts", clamped).effect).toBe("allow")
  })
})

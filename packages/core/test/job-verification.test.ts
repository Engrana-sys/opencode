import { describe, expect, it } from "bun:test"
import { JobVerification } from "@opencode-ai/schema/job-verification"
import { JobVerifier } from "@opencode-ai/core/job/verifier"

const result = (
  name: string,
  outcome: JobVerification.CheckOutcome,
  detail = "",
): JobVerification.Result => ({ name, outcome, detail })

describe("JobVerification.verdict", () => {
  it("verifies only when every check ran and passed", () => {
    expect(JobVerification.verdict([result("tests", "passed"), result("lint", "passed")])).toBe("verified")
  })

  it("one failure refutes the whole candidate", () => {
    // A candidate that breaks one thing is not partially correct.
    expect(JobVerification.verdict([result("tests", "passed"), result("lint", "failed")])).toBe("refuted")
  })

  it("a check that could not run leaves the candidate unverified", () => {
    // Claiming a pass when part of the evidence was never gathered is the one
    // failure mode a verifier must not have.
    expect(JobVerification.verdict([result("tests", "passed"), result("build", "errored")])).toBe("unverified")
    expect(JobVerification.verdict([result("tests", "passed"), result("build", "skipped")])).toBe("unverified")
  })

  it("a real failure outranks a check that could not run", () => {
    // Something is definitely broken; not knowing about the rest does not
    // soften that.
    expect(JobVerification.verdict([result("build", "errored"), result("tests", "failed")])).toBe("refuted")
  })

  it("checking nothing proves nothing", () => {
    // Defaulting to verified would make an unconfigured verifier the most
    // permissive one in the system.
    expect(JobVerification.verdict([])).toBe("unverified")
  })

  it("describes what happened in each category", () => {
    const results = [result("a", "passed"), result("b", "failed"), result("c", "errored")]
    expect(JobVerification.describe({ verdict: JobVerification.verdict(results), results })).toBe(
      "REFUTED: 1 passed 1 failed 1 could not run 0 skipped",
    )
  })
})

describe("JobVerifier.inspect", () => {
  it("passes a diff that stays inside the allowed paths", () => {
    expect(
      JobVerifier.inspect({ files: ["packages/core/src/a.ts"], allow: ["packages/core/**"] }).ok,
    ).toBe(true)
  })

  it("fails a diff that reaches outside them", () => {
    const seen = JobVerifier.inspect({
      files: ["packages/core/src/a.ts", "infra/deploy.ts"],
      allow: ["packages/core/**"],
    })
    expect(seen.ok).toBe(false)
    expect(seen.detail).toContain("infra/deploy.ts")
  })

  it("an empty allow list permits anything", () => {
    // No allowlist means the check is about forbidden paths only; treating it
    // as "allow nothing" would fail every diff.
    expect(JobVerifier.inspect({ files: ["anywhere.ts"] }).ok).toBe(true)
  })

  it("a forbid rule carves out of what allow permitted", () => {
    // Applied after allow on purpose: a broad allow must not silently override
    // the narrow rule that exists to stop exactly this.
    const seen = JobVerifier.inspect({
      files: ["packages/core/src/a.ts", "packages/core/src/secrets.ts"],
      allow: ["packages/core/**"],
      forbid: ["**/secrets.ts"],
    })
    expect(seen.ok).toBe(false)
    expect(seen.detail).toContain("secrets.ts")
  })

  it("reports both kinds of violation at once", () => {
    const seen = JobVerifier.inspect({
      files: ["infra/deploy.ts", "packages/core/src/secrets.ts"],
      allow: ["packages/core/**"],
      forbid: ["**/secrets.ts"],
    })
    expect(seen.detail).toContain("Outside the allowed paths")
    expect(seen.detail).toContain("Forbidden paths touched")
  })

  it("a diff touching nothing passes", () => {
    expect(JobVerifier.inspect({ files: [], allow: ["packages/**"] }).ok).toBe(true)
  })
})

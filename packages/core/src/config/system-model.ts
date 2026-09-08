export * as ConfigSystemModel from "./system-model"

import { Schema } from "effect"

/**
 * Ordered model chains for the work OpenCode does for itself.
 *
 * These roles are infrastructure: a goal evaluation, a classification, a
 * generated title. When one of them cannot reach a model the feature it
 * supports stops working, so each role takes a list rather than one model and
 * the runtime walks it until a call succeeds. Put the cheapest adequate model
 * first and a differently hosted one after it, so a single provider outage
 * does not take the role down with it.
 */
export const Role = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/)).pipe(
  Schema.brand("ConfigV2.SystemModel.Role"),
)
export type Role = typeof Role.Type

/** Maps a role to an ordered chain of `providerID/modelID` values. */
export const Info = Schema.Record(Role, Schema.Array(Schema.String))
export type Info = typeof Info.Type

import { Schema } from "effect"

const SKILL_PACK_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const SKILL_PACK_NAME_MAX_LENGTH = 64

export const isSkillPackName = (name: string) =>
  name.length <= SKILL_PACK_NAME_MAX_LENGTH && SKILL_PACK_NAME_PATTERN.test(name)

export class SkillPackSource extends Schema.Class<SkillPackSource>("SkillPackSource")({
  owner: Schema.String,
  repo: Schema.String,
  ref: Schema.NullOr(Schema.String),
  path: Schema.String,
}) {}

export const skillPackUrl = ({ owner, repo, ref, path }: SkillPackSource) =>
  ref === null
    ? `https://github.com/${owner}/${repo}`
    : `https://github.com/${owner}/${repo}/tree/${ref}${path === "" ? "" : `/${path}`}`

export class Skill extends Schema.Class<Skill>("Skill")({
  name: Schema.String,
  description: Schema.String,
}) {}

export class SkippedSkill extends Schema.Class<SkippedSkill>("SkippedSkill")({
  directory: Schema.String,
  reason: Schema.String,
}) {}

export class SkillPack extends Schema.Class<SkillPack>("SkillPack")({
  name: Schema.String,
  source: SkillPackSource,
  commit: Schema.String,
  updatable: Schema.Boolean,
  skills: Schema.Array(Skill),
}) {}

export class SkillPackPreview extends Schema.Class<SkillPackPreview>("SkillPackPreview")({
  source: SkillPackSource,
  commit: Schema.String,
  suggestedName: Schema.String,
  skills: Schema.Array(Skill),
  skipped: Schema.Array(SkippedSkill),
}) {}

export class SkillPackUpdate extends Schema.Class<SkillPackUpdate>("SkillPackUpdate")({
  name: Schema.String,
  from: Schema.String,
  to: Schema.String,
  added: Schema.Array(Skill),
  removed: Schema.Array(Skill),
  changed: Schema.Array(Skill),
  skipped: Schema.Array(SkippedSkill),
}) {}

export class InvalidSkillPackUrl extends Schema.TaggedError<InvalidSkillPackUrl>()(
  "InvalidSkillPackUrl",
  { input: Schema.String },
) {}

export class SkillPackNotReadable extends Schema.TaggedError<SkillPackNotReadable>()(
  "SkillPackNotReadable",
  { message: Schema.String },
) {}

export class InvalidSkillPackName extends Schema.TaggedError<InvalidSkillPackName>()(
  "InvalidSkillPackName",
  { name: Schema.String },
) {}

export class SkillPackNameTaken extends Schema.TaggedError<SkillPackNameTaken>()(
  "SkillPackNameTaken",
  { name: Schema.String },
) {}

export class SkillPackNotFound extends Schema.TaggedError<SkillPackNotFound>()(
  "SkillPackNotFound",
  { name: Schema.String },
) {}

export class SkillPackError extends Schema.TaggedError<SkillPackError>()("SkillPackError", {
  message: Schema.String,
}) {}

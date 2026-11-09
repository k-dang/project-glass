import { SKILL_PACK_NAME_MAX_LENGTH, Skill, SkillPackSource, SkippedSkill } from "@glass/contracts"
import { Option, Result, Schema } from "effect"
import { parse } from "yaml"
import type { TreeBlob } from "./github/GitHubClient"

const SKILL_FILE = "SKILL.md"

// GitHub tree URLs don't separate a ref from its path, and refs may contain slashes.
export const skillPackSources = (input: string): ReadonlyArray<SkillPackSource> | null => {
  const trimmed = input.trim()

  let url: URL

  try {
    url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }

  if (!/^(?:www\.)?github\.com$/i.test(url.hostname)) return null

  const [owner, repo, kind, ...rest] = url.pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map(decodeURIComponent)

  if (owner === undefined || repo === undefined) return null

  const repository = { owner: owner.toLowerCase(), repo: repo.replace(/\.git$/i, "").toLowerCase() }

  if (kind === undefined) return [new SkillPackSource({ ...repository, ref: null, path: "" })]

  if (kind !== "tree" || rest.length === 0) return null

  return rest.map(
    (_, index) =>
      new SkillPackSource({
        ...repository,
        ref: rest.slice(0, index + 1).join("/"),
        path: rest.slice(index + 1).join("/"),
      }),
  )
}

const lastSegment = (path: string) => path.slice(path.lastIndexOf("/") + 1)

export const suggestedName = ({ repo, path }: SkillPackSource) =>
  lastSegment(path === "" ? repo : path)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, SKILL_PACK_NAME_MAX_LENGTH)
    .replace(/^-+|-+$/g, "")

export const skillDirectories = (blobs: ReadonlyArray<TreeBlob>) => {
  const directories = blobs
    .flatMap(({ path }) =>
      path === SKILL_FILE
        ? [""]
        : path.endsWith(`/${SKILL_FILE}`)
          ? [path.slice(0, -SKILL_FILE.length - 1)]
          : [],
    )
    .toSorted()

  if (directories.includes("")) return [""]

  return directories.filter(
    (directory) => !directories.some((other) => directory.startsWith(`${other}/`)),
  )
}

export const filesOf = (directory: string, blobs: ReadonlyArray<TreeBlob>) =>
  blobs.filter(({ path }) => directory === "" || path.startsWith(`${directory}/`))

export const skillFilePath = (directory: string) =>
  directory === "" ? SKILL_FILE : `${directory}/${SKILL_FILE}`

const frontmatterOf = (text: string) =>
  /^﻿?---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(text)?.[1]

const SkillText = Schema.Trim.pipe(Schema.decodeTo(Schema.NonEmptyString))

const decodeDescription = Schema.decodeUnknownOption(Schema.Struct({ description: SkillText }))

const decodeName = Schema.decodeUnknownOption(Schema.Struct({ name: SkillText }))

const parseYaml = (text: string) => Result.try(() => parse(text))

export const readSkill = (
  directory: string,
  text: string,
  fallbackName: string,
): Skill | SkippedSkill => {
  const skipped = (reason: string) => new SkippedSkill({ directory, reason })
  const frontmatter = frontmatterOf(text)

  if (frontmatter === undefined) return skipped("SKILL.md has no frontmatter.")

  const fields = parseYaml(frontmatter)

  if (Result.isFailure(fields)) return skipped("SKILL.md's frontmatter isn't valid YAML.")

  return Option.match(decodeDescription(fields.success), {
    onNone: () => skipped("SKILL.md has no description."),
    onSome: ({ description }) =>
      new Skill({
        name: Option.match(decodeName(fields.success), {
          onNone: () => fallbackName,
          onSome: ({ name }) => name,
        }),
        description,
      }),
  })
}

export const fallbackSkillName = (source: SkillPackSource, directory: string) =>
  lastSegment(directory === "" ? (source.path === "" ? source.repo : source.path) : directory)

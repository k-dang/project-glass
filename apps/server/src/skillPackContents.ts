import { SKILL_PACK_NAME_MAX_LENGTH, Skill, SkillPackSource, SkippedSkill } from "@glass/contracts"
import { Option, Result, Schema } from "effect"
import { parse } from "yaml"

const SKILL_FILE = "SKILL.md"

export const candidateSkillPackSources = (input: string): ReadonlyArray<SkillPackSource> | null => {
  const trimmed = input.trim()

  const url = URL.parse(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)

  if (url === null || !/^(?:www\.)?github\.com$/i.test(url.hostname)) return null

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

/** Claims `wanted` in `taken`, or the first `wanted-2`, `wanted-3`, … that's free. */
export const uniqueFolder = (taken: Set<string>, wanted: string) => {
  let folder = wanted

  for (let suffix = 2; taken.has(folder); suffix++) folder = `${wanted}-${suffix}`

  taken.add(folder)

  return folder
}

export const lastSegment = (path: string) => path.slice(path.lastIndexOf("/") + 1)

const folderName = ({ repo, path }: SkillPackSource) => lastSegment(path === "" ? repo : path)

export const suggestedName = (source: SkillPackSource) =>
  folderName(source)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, SKILL_PACK_NAME_MAX_LENGTH)
    .replace(/^-+|-+$/g, "")

const skillFolderOf = (path: string) =>
  path === SKILL_FILE
    ? ""
    : path.endsWith(`/${SKILL_FILE}`)
      ? path.slice(0, -SKILL_FILE.length - 1)
      : undefined

const foldersAround = (path: string) => {
  const segments = path.split("/")

  return ["", ...segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"))]
}

export const filesBySkill = <A extends { readonly path: string }>(files: ReadonlyArray<A>) => {
  const skillFolders = new Set(files.flatMap(({ path }) => skillFolderOf(path) ?? []))

  const owned = files.flatMap((file) => {
    const folder = foldersAround(file.path).find((candidate) => skillFolders.has(candidate))

    return folder === undefined ? [] : [{ folder, file }]
  })

  return new Map(
    [...Map.groupBy(owned, ({ folder }) => folder)]
      .toSorted(([a], [b]) => (a < b ? -1 : 1))
      .map(([folder, entries]) => [folder, entries.map(({ file }) => file)]),
  )
}

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
  directory === "" ? folderName(source) : lastSegment(directory)

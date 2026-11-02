import type { DiffSide } from "@glass/contracts"

function* patchLines(hunks: string, side: DiffSide) {
  let oldLine = 0
  let newLine = 0

  for (const row of hunks.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row)

    if (header !== null) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      continue
    }

    if (row === "" || row.startsWith("\\")) continue

    const onOld = !row.startsWith("+")
    const onNew = !row.startsWith("-")
    const onSide = side === "old" ? onOld : onNew
    const current = side === "old" ? oldLine : newLine

    if (onSide) yield { number: current, text: row.slice(1) }

    if (onOld) oldLine++

    if (onNew) newLine++
  }
}

export const lineInPatch = (hunks: string, side: DiffSide, line: number) => {
  for (const entry of patchLines(hunks, side)) {
    if (entry.number === line) return entry.text
  }

  return null
}

export const rangeInPatch = (hunks: string, side: DiffSide, start: number, end: number) => {
  if (end < start) return false

  let count = 0

  for (const { number } of patchLines(hunks, side)) {
    if (number >= start && number <= end) count++
  }

  return count === end - start + 1
}

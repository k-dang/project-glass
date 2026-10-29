import type { DiffSide } from "@glass/contracts"

export const lineInPatch = (hunks: string, side: DiffSide, line: number) => {
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

    if (onSide && current === line) return row.slice(1)

    if (onOld) oldLine++

    if (onNew) newLine++
  }

  return null
}

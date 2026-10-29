import { expect, it } from "vite-plus/test"
import { lineInPatch } from "./patchLines"

it("finds a line's text on its side of the patch, or nothing outside it", () => {
  const hunks = "@@ -3 +3,2 @@\n-old\n+new\n+more\n@@ -10,2 +11 @@\n ctx\n-gone"

  expect(lineInPatch(hunks, "old", 3)).toBe("old")
  expect(lineInPatch(hunks, "new", 4)).toBe("more")
  expect(lineInPatch(hunks, "new", 11)).toBe("ctx")
  expect(lineInPatch(hunks, "old", 11)).toBe("gone")
  expect(lineInPatch(hunks, "new", 5)).toBeNull()
})

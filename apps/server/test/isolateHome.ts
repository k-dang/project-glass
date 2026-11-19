import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"

export default function isolateHome() {
  const home = mkdtempSync(join(tmpdir(), "glass-test-home-"))
  process.env["HOME"] = home
  process.env["USERPROFILE"] = home

  return () => rmSync(home, { recursive: true, force: true })
}

/** The user's own home, which tests that borrow a real login read from instead of `HOME`. */
export const realHome = () => userInfo().homedir

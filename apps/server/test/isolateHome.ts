import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"

// ServerConfig falls back to the user's home when GLASS_HOME is unset, and services clean up files
// their own database doesn't know about. Point every test worker at a throwaway home so a test that
// forgets GLASS_HOME can never touch the real ~/.project-glass.
export default function isolateHome() {
  const home = mkdtempSync(join(tmpdir(), "glass-test-home-"))
  process.env["HOME"] = home
  process.env["USERPROFILE"] = home

  return () => rmSync(home, { recursive: true, force: true })
}

/** The user's own home, which tests that borrow a real login read from instead of `HOME`. */
export const realHome = () => userInfo().homedir

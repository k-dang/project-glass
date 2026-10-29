// The verify-glass helper loads the fakes that import this file under plain Node, which can't
// resolve the server's extensionless imports, so this file must not import anything.

/**
 * The backend's environment without git's own variables or the user's git config, whose URL
 * rewrites, headers, object paths, and line endings would change what git fetches and writes.
 */
export const isolatedGitEnv = () => ({
  ...Object.fromEntries(
    Object.entries(process.env).flatMap(([name, value]) =>
      value === undefined || /^GIT_/i.test(name) ? [] : [[name, value]],
    ),
  ),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
})

/** How GitHub takes a token over git's HTTP. */
export const basicAuthorization = (token: string) =>
  `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`

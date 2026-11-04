export const isolatedGitEnv = () => ({
  ...Object.fromEntries(
    Object.entries(process.env).flatMap(([name, value]) =>
      value === undefined || /^GIT_/i.test(name) ? [] : [[name, value]],
    ),
  ),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
})

export const gitBasicAuthorization = (token: string) =>
  `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`

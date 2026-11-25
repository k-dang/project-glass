import { ConfigProvider } from "effect"

export const takeGlassVariables = (env: Record<string, string | undefined> = process.env) => {
  const read = { ...env }

  for (const name of Object.keys(env)) if (name.startsWith("GLASS_")) delete env[name]

  return ConfigProvider.layer(ConfigProvider.fromEnvRecord(read))
}

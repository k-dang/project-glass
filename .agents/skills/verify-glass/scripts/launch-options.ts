export const githubMode = (github: string | undefined, backend: string): "real" | "fake" => {
  if (github !== undefined && github !== "real" && github !== "fake")
    throw new Error("--github is real or fake")
  if (backend === "fake" && github === "fake")
    throw new Error("--backend fake brings its own fake GitHub; drop --github fake")
  return github ?? "fake"
}

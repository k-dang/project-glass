const { spawn } = require("node:child_process")

const { existsSync, readFileSync, writeFileSync } = require("node:fs")

if (process.argv[2] === "child") {
  setInterval(() => {}, 1000)
} else if (existsSync(`${__filename}.hang`)) {
  const child = spawn(process.execPath, [__filename, "child"], {
    stdio: "ignore",
    windowsHide: true,
  })

  child.once("spawn", () => {
    writeFileSync(
      `${__filename}.running`,
      JSON.stringify({
        pid: process.pid,
        parentPid: process.ppid,
        childPid: child.pid,
        cwd: process.cwd(),
      }),
    )
  })
  setInterval(() => {}, 1000)
} else {
  process.stdout.write(readFileSync(`${__filename}.key`, "utf8"))
}

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

export interface BeholdHomeOptions {
  readonly cwd: string
  readonly configuredDirectory?: string
  readonly homeDirectory?: string
  readonly platform?: NodeJS.Platform
  readonly environment?: NodeJS.ProcessEnv
}

export const resolveBeholdDataDirectory = (options: BeholdHomeOptions): string => {
  if (options.configuredDirectory !== undefined) return resolve(options.cwd, options.configuredDirectory)

  const home = options.homeDirectory ?? homedir()
  const platform = options.platform ?? process.platform
  const environment = options.environment ?? process.env
  if (platform === "darwin") return join(home, "Library", "Application Support", "Behold")
  if (platform === "win32") return join(environment.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Behold")
  return join(environment.XDG_DATA_HOME ?? join(home, ".local", "share"), "behold")
}

export const readBeholdLocalEnvironment = (cwd: string): Record<string, string> => {
  const readEnvironmentFile = (filePath: string): Record<string, string> => {
    try {
      return Object.fromEntries(
        readFileSync(filePath, "utf8")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line !== "" && !line.startsWith("#") && line.includes("="))
          .map((line) => {
            const index = line.indexOf("=")
            const key = line.slice(0, index).trim()
            const raw = line.slice(index + 1).trim()
            return [key, raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw]
          }),
      )
    } catch {
      return {}
    }
  }

  return {
    ...readEnvironmentFile(resolve(cwd, ".env")),
    ...readEnvironmentFile(resolve(cwd, ".env.local")),
  }
}

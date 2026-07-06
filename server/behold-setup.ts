import { spawn } from "node:child_process"
import { agents, detectGlobalAgents, getAgentTypes, listInstalledServers, upsertServer, type AgentType, type McpServerConfig } from "add-mcp"
import { ensureViewer, getRuntimeStatus, resolveRuntimePaths } from "./behold-lifecycle"

export const defaultPackageSpec = "@kitlangton/behold@latest"

export const beholdMcpConfig = (packageSpec = defaultPackageSpec): McpServerConfig => ({
  command: "bunx",
  args: ["-y", packageSpec, "mcp"],
})

const resolveAgents = async (requested: ReadonlyArray<string>): Promise<ReadonlyArray<AgentType>> => {
  const supported = new Set<string>(getAgentTypes())
  const invalid = requested.filter((agent) => !supported.has(agent))
  if (invalid.length > 0) throw new Error(`Unsupported agent${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}.`)
  if (requested.length > 0) return [...new Set(requested)] as Array<AgentType>

  const detected = await detectGlobalAgents()
  if (detected.length === 0) {
    throw new Error("No supported coding agents were detected. Pass --agent <name> to select one explicitly.")
  }
  return detected
}

export const setupBehold = async (options: {
  readonly requestedAgents?: ReadonlyArray<string>
  readonly packageSpec?: string
} = {}) => {
  const selectedAgents = await resolveAgents(options.requestedAgents ?? [])
  const config = beholdMcpConfig(options.packageSpec ?? process.env.BEHOLD_PACKAGE_SPEC ?? defaultPackageSpec)
  const installs = selectedAgents.map((agent) => ({ agent, result: upsertServer(agent, "behold", config) }))
  const failed = installs.filter(({ result }) => !result.success)
  if (failed.length > 0) {
    throw new Error(failed.map(({ agent, result }) => `${agents[agent].displayName}: ${result.error ?? "installation failed"}`).join("\n"))
  }
  return { installs, viewer: await ensureViewer() }
}

export const diagnoseBehold = async () => {
  const detectedAgents = await detectGlobalAgents()
  const configured = detectedAgents.length === 0
    ? []
    : (await listInstalledServers({ global: true, agents: detectedAgents }))
      .filter((entry) => entry.servers.some((server) => server.serverName === "behold"))
  const viewer = await getRuntimeStatus()
  return {
    bunVersion: Bun.version,
    configured,
    dataDirectory: resolveRuntimePaths().dataDirectory,
    detectedAgents,
    viewer,
  }
}

export const openViewer = (url: string): void => {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]]
  const child = spawn(command, args, { detached: true, stdio: "ignore" })
  child.once("error", () => undefined)
  child.unref()
}

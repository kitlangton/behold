#!/usr/bin/env bun
import { ensureViewer, getRuntimeStatus, stopViewer, ViewerLifecycleError } from "./behold-lifecycle"

const command = process.argv[2] ?? "status"
const args = process.argv.slice(3)
const optionValues = (name: string): Array<string> => args.flatMap((argument, index) => argument === name && args[index + 1] ? [args[index + 1]] : [])

try {
  if (command === "mcp") {
    await import("./mcp-main")
  } else if (command === "setup") {
    const [{ agents }, { openViewer, setupBehold }] = await Promise.all([import("add-mcp"), import("./behold-setup")])
    const result = await setupBehold({ requestedAgents: optionValues("--agent") })
    for (const { agent, result: install } of result.installs) {
      console.log(`Configured ${agents[agent].displayName}: ${install.path}`)
    }
    console.log(`Behold is running at ${result.viewer.origin}.`)
    if (!args.includes("--no-open")) openViewer(result.viewer.origin)
  } else if (command === "doctor") {
    const { diagnoseBehold } = await import("./behold-setup")
    const result = await diagnoseBehold()
    console.log(`Bun ${result.bunVersion}`)
    console.log(`Data: ${result.dataDirectory}`)
    console.log(`Viewer: ${result.viewer.state === "running" ? result.viewer.connection.origin : "not running"}`)
    console.log(`Agents: ${result.configured.length === 0 ? "Behold is not configured in a detected agent" : result.configured.map((entry) => entry.displayName).join(", ")}`)
  } else if (command === "start") {
    const viewer = await ensureViewer()
    console.log(`Behold is running at ${viewer.origin}${viewer.runtime ? ` (PID ${viewer.runtime.pid})` : ""}.`)
  } else if (command === "stop") {
    const result = await stopViewer()
    console.log(result.state === "stopped" ? `Stopped Behold (PID ${result.pid})${result.forced ? " forcibly" : ""}.` : "Behold is not running.")
  } else if (command === "status") {
    const status = await getRuntimeStatus()
    if (status.state === "stopped") {
      console.log("Behold is not running.")
      process.exitCode = 1
    } else {
      const detail = status.managed && status.connection.runtime ? `daemon PID ${status.connection.runtime.pid}` : "foreground server"
      console.log(`Behold is running at ${status.connection.origin} (${detail}).`)
    }
  } else {
    console.error("Usage: behold <setup|doctor|start|stop|status|mcp> [--agent <name>] [--no-open]")
    process.exitCode = 1
  }
} catch (error) {
  console.error(error instanceof ViewerLifecycleError || error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

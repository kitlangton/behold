import { resolve } from "node:path"
import {
  canonicalViewerOrigin,
  removeRuntimeRecord,
  resolveRuntimePaths,
  writeRuntimeRecord,
  type RuntimeRecord,
} from "./behold-lifecycle"
import { readBeholdLocalEnvironment } from "./behold-home"
import { startLocalViewer } from "./local-viewer"

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const root = resolve(import.meta.dir, "..")
const runtimeId = argument("--runtime-id")
const origin = new URL(argument("--origin") ?? canonicalViewerOrigin).origin
const configDirectory = resolve(argument("--config-directory") ?? process.cwd())
const assetDirectory = resolve(argument("--asset-directory") ?? process.env.BEHOLD_ASSET_DIR ?? resolve(root, "dist"))
const originUrl = new URL(origin)
const port = originUrl.port === "" ? 80 : Number(originUrl.port)
const requestUrl = new URL(origin)
requestUrl.hostname = "127.0.0.1"
const requestOrigin = requestUrl.origin
const paths = resolveRuntimePaths({ root, configDirectory })

if (!runtimeId) throw new Error("Missing required --runtime-id argument.")

let server: { readonly close: () => Promise<void> } | undefined
let stopping = false

const shutdown = async (exitCode: number) => {
  if (stopping) return
  stopping = true
  try {
    await server?.close()
  } finally {
    await removeRuntimeRecord(paths.registryFile, runtimeId).catch(() => false)
    process.exit(exitCode)
  }
}

process.once("SIGINT", () => void shutdown(0))
process.once("SIGTERM", () => void shutdown(0))

try {
  console.error(`[behold] Starting runtime ${runtimeId} at ${origin}`)
  server = await startLocalViewer({
    root,
    host: "127.0.0.1",
    port,
    dataDirectory: paths.dataDirectory,
    assetDirectory,
    runtimeId,
    environment: { ...readBeholdLocalEnvironment(configDirectory), ...process.env },
  })

  const record: RuntimeRecord = {
    version: 1,
    runtimeId,
    pid: process.pid,
    origin,
    requestOrigin,
    root,
    configDirectory,
    assetDirectory,
    packageVersion: JSON.parse(await Bun.file(resolve(root, "package.json")).text()).version,
    startedAt: new Date().toISOString(),
  }
  await writeRuntimeRecord(paths.registryFile, record)
  console.error(`[behold] Runtime ready (PID ${process.pid})`)
} catch (error) {
  console.error("[behold] Runtime startup failed:", error)
  await shutdown(1)
}

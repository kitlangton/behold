import { createServer } from "node:net"
import type { Socket } from "node:net"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  ensureViewer,
  getRuntimeStatus,
  resolveRuntimePaths,
  stopViewer,
  writeRuntimeRecord,
  type LifecycleOptions,
} from "../server/behold-lifecycle"

const running: LifecycleOptions[] = []
const directories: string[] = []

const availablePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (!address || typeof address === "string") {
      server.close()
      reject(new Error("Unable to allocate a test port."))
      return
    }
    server.close((error) => error ? reject(error) : resolve(address.port))
  })
})

const lifecycleOptions = async (): Promise<LifecycleOptions> => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "behold-lifecycle-"))
  const assetDirectory = join(dataDirectory, "assets")
  await mkdir(assetDirectory)
  await writeFile(join(assetDirectory, "index.html"), "<!doctype html><title>Behold test</title>")
  const port = await availablePort()
  const options = {
    root: process.cwd(),
    origin: `http://behold.localhost:${port}`,
    dataDirectory,
    assetDirectory,
    configDirectory: process.cwd(),
    startupTimeoutMs: 20_000,
  }
  directories.push(dataDirectory)
  running.push(options)
  return options
}

afterEach(async () => {
  await Promise.allSettled(running.splice(0).map((options) => stopViewer(options)))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("Behold local runtime lifecycle", () => {
  it("starts one daemon under concurrent clients and reuses it", { timeout: 30_000 }, async () => {
    const options = await lifecycleOptions()
    const viewers = await Promise.all(Array.from({ length: 6 }, () => ensureViewer(options)))

    const runtimeIds = new Set(viewers.map((viewer) => viewer.runtime?.runtimeId))
    const pids = new Set(viewers.map((viewer) => viewer.runtime?.pid))
    expect(runtimeIds.size).toBe(1)
    expect(pids.size).toBe(1)
    expect(viewers.every((viewer) => viewer.origin === options.origin)).toBe(true)
    expect(viewers.every((viewer) => new URL(viewer.requestOrigin).hostname === "127.0.0.1")).toBe(true)

    const reused = await ensureViewer(options)
    expect(reused.runtime?.runtimeId).toBe(viewers[0]?.runtime?.runtimeId)
    expect(reused.runtime?.pid).toBe(viewers[0]?.runtime?.pid)

    const status = await getRuntimeStatus(options)
    expect(status.state).toBe("running")
    if (status.state === "running") expect(status.managed).toBe(true)
  })

  it("restarts an incompatible daemon for a different configuration root", { timeout: 30_000 }, async () => {
    const options = await lifecycleOptions()
    const first = await ensureViewer(options)
    const configDirectory = await mkdtemp(join(tmpdir(), "behold-config-"))
    directories.push(configDirectory)

    const secondOptions = { ...options, configDirectory }
    running.push(secondOptions)
    const second = await ensureViewer(secondOptions)

    expect(second.runtime?.runtimeId).not.toBe(first.runtime?.runtimeId)
    expect(second.runtime?.pid).not.toBe(first.runtime?.pid)
    expect(second.runtime?.configDirectory).toBe(configDirectory)
  })

  it("stops only the registered healthy daemon and removes its registry", { timeout: 30_000 }, async () => {
    const options = await lifecycleOptions()
    const viewer = await ensureViewer(options)
    expect(viewer.runtime).toBeDefined()

    const result = await stopViewer(options)
    expect(result).toMatchObject({ state: "stopped", pid: viewer.runtime?.pid, forced: false })

    const status = await getRuntimeStatus(options)
    expect(status.state).toBe("stopped")
    await expect(fetch(`${viewer.requestOrigin}/api/health`, { signal: AbortSignal.timeout(500) })).rejects.toThrow()
    running.length = 0
  })

  it("cleans stale metadata without signaling its recorded PID", async () => {
    const options = await lifecycleOptions()
    const paths = resolveRuntimePaths(options)
    await writeRuntimeRecord(paths.registryFile, {
      version: 1,
      runtimeId: "stale-runtime",
      pid: process.pid,
      origin: options.origin ?? "",
      requestOrigin: "http://127.0.0.1:1",
      root: process.cwd(),
      configDirectory: process.cwd(),
      assetDirectory: options.assetDirectory,
      packageVersion: "0.1.1",
      startedAt: new Date().toISOString(),
    })

    await expect(stopViewer(options)).resolves.toEqual({ state: "not-running", staleRegistryRemoved: true })
    expect(await readFile(paths.registryFile, "utf8").catch(() => undefined)).toBeUndefined()
    running.length = 0
  })

  it("reports detached startup failures with the daemon log", { timeout: 30_000 }, async () => {
    const options = { ...await lifecycleOptions(), startupTimeoutMs: 5_000 }
    const port = Number(new URL(options.origin ?? "").port)
    const sockets = new Set<Socket>()
    const blocker = createServer((socket) => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    })
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject)
      blocker.listen(port, "127.0.0.1", () => resolve())
    })

    try {
      await expect(ensureViewer(options)).rejects.toThrow(/Daemon log .*(already in use|port)/is)
      expect(await readFile(resolveRuntimePaths(options).logFile, "utf8")).toContain("Runtime startup failed")
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
    running.length = 0
  })
})

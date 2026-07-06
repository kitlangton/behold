import { randomUUID } from "node:crypto"
import { closeSync, existsSync, openSync, readFileSync, statSync, truncateSync } from "node:fs"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { spawn, spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readBeholdLocalEnvironment, resolveBeholdDataDirectory } from "./behold-home"

export const canonicalViewerOrigin = "http://behold.localhost:5173"

const lifecycleVersion = 1
const lockStaleAfterMs = 30_000
const defaultStartupTimeoutMs = 15_000

export interface RuntimeRecord {
  readonly version: 1
  readonly runtimeId: string
  readonly pid: number
  readonly origin: string
  readonly requestOrigin: string
  readonly root: string
  readonly configDirectory?: string
  readonly assetDirectory?: string
  readonly packageVersion?: string
  readonly startedAt: string
}

export interface ViewerConnection {
  readonly origin: string
  readonly requestOrigin: string
  readonly runtime?: RuntimeRecord
}

export interface LifecycleOptions {
  readonly root?: string
  readonly origin?: string
  readonly dataDirectory?: string
  readonly assetDirectory?: string
  readonly configDirectory?: string
  readonly startupTimeoutMs?: number
}

export interface RuntimePaths {
  readonly dataDirectory: string
  readonly registryFile: string
  readonly lockDirectory: string
  readonly lockOwnerFile: string
  readonly logFile: string
}

interface LockOwner {
  readonly id: string
  readonly pid: number
  readonly createdAt: string
}

interface HealthPayload {
  readonly service: "behold"
  readonly status: "ok"
  readonly runtimeId?: string
  readonly pid?: number
}

export type RuntimeStatus =
  | { readonly state: "running"; readonly connection: ViewerConnection; readonly managed: boolean }
  | { readonly state: "stopped"; readonly staleRegistryRemoved: boolean }

export type StopResult =
  | { readonly state: "stopped"; readonly pid: number; readonly forced: boolean }
  | { readonly state: "not-running"; readonly staleRegistryRemoved: boolean }

export class ViewerLifecycleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ViewerLifecycleError"
  }
}

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const sleep = (milliseconds: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds))

const normalizeOrigin = (configuredOrigin: string): { origin: string; requestOrigin: string } => {
  let url: URL
  try {
    url = new URL(configuredOrigin)
  } catch {
    throw new ViewerLifecycleError(`BEHOLD_ORIGIN is not a valid URL: ${configuredOrigin}`)
  }

  const localHostname = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".localhost")
  if (url.protocol !== "http:" || !localHostname || (url.pathname !== "/" && url.pathname !== "")) {
    throw new ViewerLifecycleError(
      `Behold is not reachable at ${configuredOrigin}; only a local HTTP viewer can be auto-started.`,
    )
  }

  url.pathname = ""
  url.search = ""
  url.hash = ""
  const origin = url.origin
  const requestUrl = new URL(origin)
  requestUrl.hostname = "127.0.0.1"
  return { origin, requestOrigin: requestUrl.origin }
}

export const resolveRuntimePaths = (options: LifecycleOptions = {}): RuntimePaths => {
  const configDirectory = options.configDirectory ?? process.cwd()
  const localEnvironment = readBeholdLocalEnvironment(configDirectory)
  const dataDirectory = options.dataDirectory ?? resolveBeholdDataDirectory({
    cwd: configDirectory,
    configuredDirectory: process.env.BEHOLD_DATA_DIR ?? localEnvironment.BEHOLD_DATA_DIR,
  })
  return {
    dataDirectory,
    registryFile: resolve(dataDirectory, "runtime.json"),
    lockDirectory: resolve(dataDirectory, "runtime.lock"),
    lockOwnerFile: resolve(dataDirectory, "runtime.lock", "owner.json"),
    logFile: resolve(dataDirectory, "daemon.log"),
  }
}

const packageVersion = (root: string): string => {
  try {
    const value: unknown = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
    return typeof value === "object" && value !== null && "version" in value && typeof value.version === "string"
      ? value.version
      : "unknown"
  } catch {
    return "unknown"
  }
}

interface RuntimeIdentity {
  readonly root: string
  readonly configDirectory: string
  readonly assetDirectory: string
  readonly packageVersion: string
}

const runtimeIdentity = (options: LifecycleOptions & { readonly root: string }): RuntimeIdentity => ({
  root: resolve(options.root),
  configDirectory: resolve(options.configDirectory ?? process.cwd()),
  assetDirectory: resolve(options.assetDirectory ?? resolve(options.root, "dist")),
  packageVersion: packageVersion(options.root),
})

const runtimeIsCompatible = (record: RuntimeRecord, identity: RuntimeIdentity): boolean =>
  record.root === identity.root &&
  record.configDirectory === identity.configDirectory &&
  record.assetDirectory === identity.assetDirectory &&
  record.packageVersion === identity.packageVersion

const isRuntimeRecord = (value: unknown): value is RuntimeRecord => {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return record.version === lifecycleVersion &&
    typeof record.runtimeId === "string" &&
    typeof record.pid === "number" &&
    typeof record.origin === "string" &&
    typeof record.requestOrigin === "string" &&
    typeof record.root === "string" &&
    typeof record.startedAt === "string"
}

export const readRuntimeRecord = async (registryFile: string): Promise<RuntimeRecord | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(registryFile, "utf8"))
    return isRuntimeRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export const writeRuntimeRecord = async (registryFile: string, record: RuntimeRecord): Promise<void> => {
  await mkdir(dirname(registryFile), { recursive: true })
  const temporaryFile = `${registryFile}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporaryFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  await rename(temporaryFile, registryFile)
}

export const removeRuntimeRecord = async (registryFile: string, runtimeId?: string): Promise<boolean> => {
  if (runtimeId !== undefined) {
    const current = await readRuntimeRecord(registryFile)
    if (current?.runtimeId !== runtimeId) return false
  }
  try {
    await rm(registryFile)
    return true
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

const probeHealth = async (
  requestOrigin: string,
  expected?: Pick<RuntimeRecord, "runtimeId" | "pid">,
): Promise<HealthPayload | undefined> => {
  try {
    const response = await fetch(`${requestOrigin}/api/health`, { signal: AbortSignal.timeout(750) })
    if (!response.ok) return undefined
    const payload = await response.json() as Partial<HealthPayload>
    if (payload.service !== "behold" || payload.status !== "ok") return undefined
    if (expected && (payload.runtimeId !== expected.runtimeId || payload.pid !== expected.pid)) return undefined
    return payload as HealthPayload
  } catch {
    return undefined
  }
}

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const processMatchesRuntime = (record: RuntimeRecord): boolean => {
  if (!processIsAlive(record.pid)) return false
  const result = spawnSync("ps", ["-p", String(record.pid), "-o", "command="], { encoding: "utf8" })
  return result.status === 0 && result.stdout.includes("daemon-main.ts") && result.stdout.includes(record.runtimeId)
}

const readLockOwner = async (paths: RuntimePaths): Promise<LockOwner | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(paths.lockOwnerFile, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return undefined
    const owner = parsed as Record<string, unknown>
    if (typeof owner.id !== "string" || typeof owner.pid !== "number" || typeof owner.createdAt !== "string") return undefined
    return owner as unknown as LockOwner
  } catch {
    return undefined
  }
}

const clearStaleLock = async (paths: RuntimePaths): Promise<boolean> => {
  const owner = await readLockOwner(paths)
  if (owner) {
    const age = Date.now() - Date.parse(owner.createdAt)
    if (processIsAlive(owner.pid) && age < lockStaleAfterMs) return false
  } else {
    try {
      const lockStat = await stat(paths.lockDirectory)
      if (Date.now() - lockStat.mtimeMs < 2_000) return false
    } catch {
      return true
    }
  }

  const staleDirectory = `${paths.lockDirectory}.stale.${randomUUID()}`
  try {
    await rename(paths.lockDirectory, staleDirectory)
    await rm(staleDirectory, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

const acquireStartupLock = async (paths: RuntimePaths): Promise<LockOwner | undefined> => {
  await mkdir(paths.dataDirectory, { recursive: true })
  const owner: LockOwner = { id: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() }
  try {
    await mkdir(paths.lockDirectory)
    await writeFile(paths.lockOwnerFile, JSON.stringify(owner), { flag: "wx", mode: 0o600 })
    return owner
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return undefined
    await rm(paths.lockDirectory, { recursive: true, force: true })
    throw error
  }
}

const releaseStartupLock = async (paths: RuntimePaths, owner: LockOwner): Promise<void> => {
  const current = await readLockOwner(paths)
  if (current?.id === owner.id) await rm(paths.lockDirectory, { recursive: true, force: true })
}

const prepareLog = (logFile: string): number => {
  if (existsSync(logFile) && statSync(logFile).size > 2 * 1024 * 1024) truncateSync(logFile, 0)
  return openSync(logFile, "a", 0o600)
}

const spawnDaemon = (
  options: Required<Pick<LifecycleOptions, "root" | "origin" | "dataDirectory" | "assetDirectory" | "configDirectory">>,
  runtimeId: string,
): number => {
  const logFile = resolveRuntimePaths(options).logFile
  const logFd = prepareLog(logFile)
  try {
    const child = spawn(
      "bun",
      [
        "run",
        resolve(options.root, "server/daemon-main.ts"),
        "--runtime-id",
        runtimeId,
        "--origin",
        options.origin,
        "--config-directory",
        options.configDirectory,
        "--asset-directory",
        options.assetDirectory,
      ],
      {
        cwd: options.configDirectory,
        detached: true,
        env: {
          ...process.env,
          BEHOLD_DATA_DIR: options.dataDirectory,
          BEHOLD_DAEMON_ID: runtimeId,
          BEHOLD_ASSET_DIR: options.assetDirectory,
        },
        stdio: ["ignore", logFd, logFd],
      },
    )
    child.unref()
    if (child.pid === undefined) throw new ViewerLifecycleError("Unable to obtain the Behold daemon process id.")
    return child.pid
  } finally {
    closeSync(logFd)
  }
}

const recentLog = (logFile: string): string => {
  try {
    const contents = readFileSync(logFile, "utf8")
    return contents.slice(-8_000).trim()
  } catch {
    return ""
  }
}

const healthyConnection = async (
  origin: string,
  requestOrigin: string,
  registryFile: string,
  identity?: RuntimeIdentity,
  allowUnmanaged = true,
): Promise<ViewerConnection | undefined> => {
  const record = await readRuntimeRecord(registryFile)
  if (record) {
    const health = await probeHealth(record.requestOrigin, record)
    if (health) {
      return record.origin === origin &&
          record.requestOrigin === requestOrigin &&
          (identity === undefined || runtimeIsCompatible(record, identity))
        ? { origin, requestOrigin, runtime: record }
        : undefined
    }
  }
  if (allowUnmanaged && await probeHealth(requestOrigin)) return { origin, requestOrigin }
  if (allowUnmanaged && requestOrigin !== origin && await probeHealth(origin)) return { origin, requestOrigin: origin }
  return undefined
}

const terminateRuntime = async (record: RuntimeRecord): Promise<boolean> => {
  if (!processMatchesRuntime(record)) {
    throw new ViewerLifecycleError(
      `Refusing to stop PID ${record.pid}: its process command does not match registered Behold runtime ${record.runtimeId}.`,
    )
  }

  process.kill(record.pid, "SIGTERM")
  const gracefulDeadline = Date.now() + 5_000
  while (Date.now() < gracefulDeadline && processIsAlive(record.pid)) await sleep(50)
  if (!processIsAlive(record.pid)) return false

  if (!processMatchesRuntime(record)) {
    throw new ViewerLifecycleError(`Refusing to escalate termination because PID ${record.pid} no longer matches Behold.`)
  }
  process.kill(record.pid, "SIGKILL")
  const forcedDeadline = Date.now() + 2_000
  while (Date.now() < forcedDeadline && processIsAlive(record.pid)) await sleep(50)
  if (processIsAlive(record.pid)) throw new ViewerLifecycleError(`Behold PID ${record.pid} did not terminate.`)
  return true
}

export const ensureViewer = async (options: LifecycleOptions = {}): Promise<ViewerConnection> => {
  const root = options.root ?? defaultRoot
  const identity = runtimeIdentity({ ...options, root })
  const normalized = normalizeOrigin(options.origin ?? process.env.BEHOLD_ORIGIN ?? process.env.SHOW_AND_TELL_ORIGIN ?? canonicalViewerOrigin)
  const paths = resolveRuntimePaths({ ...options, root })
  const existing = await healthyConnection(normalized.origin, normalized.requestOrigin, paths.registryFile, identity)
  if (existing) return existing

  const deadline = Date.now() + (options.startupTimeoutMs ?? defaultStartupTimeoutMs)
  while (Date.now() < deadline) {
    const owner = await acquireStartupLock(paths)
    if (!owner) {
      await clearStaleLock(paths)
      const connection = await healthyConnection(normalized.origin, normalized.requestOrigin, paths.registryFile, identity, false)
      if (connection) return connection
      await sleep(100)
      continue
    }

    try {
      const connection = await healthyConnection(normalized.origin, normalized.requestOrigin, paths.registryFile, identity)
      if (connection) return connection
      const incompatible = await readRuntimeRecord(paths.registryFile)
      if (incompatible && await probeHealth(incompatible.requestOrigin, incompatible)) {
        await terminateRuntime(incompatible)
      }
      await removeRuntimeRecord(paths.registryFile)

      const runtimeId = randomUUID()
      const pid = spawnDaemon({
        root,
        origin: normalized.origin,
        dataDirectory: paths.dataDirectory,
        assetDirectory: identity.assetDirectory,
        configDirectory: identity.configDirectory,
      }, runtimeId)
      while (Date.now() < deadline) {
        const record = await readRuntimeRecord(paths.registryFile)
        if (record?.runtimeId === runtimeId && record.pid === pid && await probeHealth(normalized.requestOrigin, record)) {
          return { origin: normalized.origin, requestOrigin: normalized.requestOrigin, runtime: record }
        }
        if (!processIsAlive(pid)) {
          const competingRuntime = await healthyConnection(normalized.origin, normalized.requestOrigin, paths.registryFile, identity)
          if (competingRuntime) return competingRuntime
          break
        }
        await sleep(100)
      }

      const pendingRecord: RuntimeRecord = {
        version: 1,
        runtimeId,
        pid,
        origin: normalized.origin,
        requestOrigin: normalized.requestOrigin,
        ...identity,
        startedAt: new Date().toISOString(),
      }
      if (processMatchesRuntime(pendingRecord)) {
        process.kill(pid, "SIGTERM")
        const terminationDeadline = Date.now() + 1_000
        while (Date.now() < terminationDeadline && processIsAlive(pid)) await sleep(25)
        if (processMatchesRuntime(pendingRecord)) process.kill(pid, "SIGKILL")
      }

      const log = recentLog(paths.logFile)
      throw new ViewerLifecycleError(
        `Behold did not become healthy at ${normalized.origin} within ${options.startupTimeoutMs ?? defaultStartupTimeoutMs}ms.` +
          (log === "" ? ` See ${paths.logFile}.` : ` Daemon log (${paths.logFile}):\n${log}`),
      )
    } finally {
      await releaseStartupLock(paths, owner)
    }
  }

  throw new ViewerLifecycleError(`Timed out waiting for another Behold process to start. See ${paths.logFile}.`)
}

export const getRuntimeStatus = async (options: LifecycleOptions = {}): Promise<RuntimeStatus> => {
  const root = options.root ?? defaultRoot
  const normalized = normalizeOrigin(options.origin ?? process.env.BEHOLD_ORIGIN ?? process.env.SHOW_AND_TELL_ORIGIN ?? canonicalViewerOrigin)
  const paths = resolveRuntimePaths({ ...options, root })
  const connection = await healthyConnection(normalized.origin, normalized.requestOrigin, paths.registryFile)
  if (connection) return { state: "running", connection, managed: connection.runtime !== undefined }
  const staleRegistryRemoved = await removeRuntimeRecord(paths.registryFile)
  return { state: "stopped", staleRegistryRemoved }
}

export const stopViewer = async (options: LifecycleOptions = {}): Promise<StopResult> => {
  const paths = resolveRuntimePaths({ ...options, root: options.root ?? defaultRoot })
  const record = await readRuntimeRecord(paths.registryFile)
  if (!record) {
    const staleRegistryRemoved = await removeRuntimeRecord(paths.registryFile)
    return { state: "not-running", staleRegistryRemoved }
  }

  const health = await probeHealth(record.requestOrigin, record)
  if (!health) {
    const staleRegistryRemoved = await removeRuntimeRecord(paths.registryFile, record.runtimeId)
    return { state: "not-running", staleRegistryRemoved }
  }
  const forced = await terminateRuntime(record)
  await removeRuntimeRecord(paths.registryFile, record.runtimeId)
  return { state: "stopped", pid: record.pid, forced }
}

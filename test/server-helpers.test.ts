import { describe, expect, it } from "vitest"
import { resolveBeholdDataDirectory } from "../server/behold-home"
import { beholdMcpConfig } from "../server/behold-setup"
import { canReadLocalFilePath, resolveReadableLocalFilePath } from "../server/local-file-access"
import { createSerializedAtomicJsonWriter } from "../server/serialized-atomic-json-writer"

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe("serialized atomic JSON writer", () => {
  it("serializes concurrent writes so a delayed earlier write cannot overwrite a later snapshot", async () => {
    const firstWriteStarted = deferred()
    const releaseFirstWrite = deferred()
    const tempContents = new Map<string, string>()
    const renamedPayloads: Array<string> = []
    let finalPayload = ""
    let tempIndex = 0

    const writer = createSerializedAtomicJsonWriter<{ readonly version: string }>({
      directory: "/store",
      filePath: "/store/store.json",
      makeTempFilePath: () => `/store/store.${++tempIndex}.tmp`,
      mkdir: async () => undefined,
      writeFile: async (path, content) => {
        tempContents.set(String(path), String(content))
        if (String(content).includes('"old"')) {
          firstWriteStarted.resolve()
          await releaseFirstWrite.promise
        }
      },
      rename: async (from) => {
        finalPayload = tempContents.get(String(from)) ?? ""
        renamedPayloads.push(finalPayload)
      },
      rm: async () => undefined,
    })

    const firstWrite = writer.write({ version: "old" })
    await firstWriteStarted.promise

    const secondWrite = writer.write({ version: "new" })
    expect(renamedPayloads).toEqual([])

    releaseFirstWrite.resolve()
    await Promise.all([firstWrite, secondWrite])

    expect(renamedPayloads.map((payload) => JSON.parse(payload))).toEqual([{ version: "old" }, { version: "new" }])
    expect(JSON.parse(finalPayload)).toEqual({ version: "new" })
  })

  it("continues processing queued writes after one atomic write fails", async () => {
    const tempContents = new Map<string, string>()
    const removedTemps: Array<string> = []
    let tempIndex = 0
    let shouldFail = true

    const writer = createSerializedAtomicJsonWriter<{ readonly version: string }>({
      directory: "/store",
      filePath: "/store/store.json",
      makeTempFilePath: () => `/store/store.${++tempIndex}.tmp`,
      mkdir: async () => undefined,
      writeFile: async (path, content) => {
        tempContents.set(String(path), String(content))
      },
      rename: async () => {
        if (shouldFail) {
          shouldFail = false
          throw new Error("rename failed")
        }
      },
      rm: async (path) => {
        removedTemps.push(String(path))
      },
    })

    await expect(writer.write({ version: "fails" })).rejects.toThrow("rename failed")
    await expect(writer.write({ version: "recovers" })).resolves.toBeUndefined()

    expect(removedTemps).toEqual(["/store/store.1.tmp"])
    expect(JSON.parse(tempContents.get("/store/store.2.tmp") ?? "{}")).toEqual({ version: "recovers" })
  })
})

describe("Behold data directory", () => {
  it("uses the operating system user data directory by default", () => {
    expect(resolveBeholdDataDirectory({ cwd: "/workspace", homeDirectory: "/Users/example", platform: "darwin" }))
      .toBe("/Users/example/Library/Application Support/Behold")
    expect(resolveBeholdDataDirectory({ cwd: "/workspace", homeDirectory: "/home/example", platform: "linux", environment: {} }))
      .toBe("/home/example/.local/share/behold")
    expect(resolveBeholdDataDirectory({ cwd: "/workspace", homeDirectory: "C:\\Users\\example", platform: "win32", environment: { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" } }))
      .toBe("C:\\Users\\example\\AppData\\Local/Behold")
  })

  it("resolves an explicitly configured directory from the runtime root", () => {
    const target = resolveBeholdDataDirectory({
      cwd: "/workspace",
      configuredDirectory: ".behold-test",
    })

    expect(target).toBe("/workspace/.behold-test")
  })
})

describe("Behold setup", () => {
  it("registers the published MCP command through bunx", () => {
    expect(beholdMcpConfig("@kitlangton/behold@0.1.0")).toEqual({
      command: "bunx",
      args: ["-y", "@kitlangton/behold@0.1.0", "mcp"],
    })
  })
})

describe("local file authorization", () => {
  it("fails closed for non-loopback clients when the target realpath cannot be resolved", async () => {
    const allowed = await canReadLocalFilePath({
      remoteAddress: "192.168.1.10",
      filePath: "/workspace/missing.ts",
      allowedRoots: ["/workspace"],
      realpath: async (path) => {
        if (path === "/workspace") return "/workspace"
        throw new Error("ENOENT")
      },
    })

    expect(allowed).toBe(false)
  })

  it("preserves loopback file-not-found behavior by authorizing before the later read fails", async () => {
    const allowed = await canReadLocalFilePath({
      remoteAddress: "127.0.0.1",
      filePath: "/workspace/missing.ts",
      allowedRoots: ["/workspace"],
      realpath: async () => {
        throw new Error("ENOENT")
      },
    })

    expect(allowed).toBe(true)
  })

  it("requires non-loopback paths to stay inside canonical allowed roots", async () => {
    const realpaths = new Map([
      ["/workspace", "/real/workspace"],
      ["/workspace/file.ts", "/real/workspace/file.ts"],
      ["/workspace/link.ts", "/private/secret.ts"],
    ])
    const realpath = async (path: string) => {
      const value = realpaths.get(path)
      if (!value) throw new Error("ENOENT")
      return value
    }

    await expect(
      canReadLocalFilePath({ remoteAddress: "192.168.1.10", filePath: "/workspace/file.ts", allowedRoots: ["/workspace"], realpath }),
    ).resolves.toBe(true)
    await expect(
      resolveReadableLocalFilePath({ remoteAddress: "192.168.1.10", filePath: "/workspace/file.ts", allowedRoots: ["/workspace"], realpath }),
    ).resolves.toBe("/real/workspace/file.ts")
    await expect(
      canReadLocalFilePath({ remoteAddress: "192.168.1.10", filePath: "/workspace/link.ts", allowedRoots: ["/workspace"], realpath }),
    ).resolves.toBe(false)
  })
})

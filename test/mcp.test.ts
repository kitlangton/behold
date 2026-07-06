import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { afterEach, describe, expect, it } from "vitest"
import { stopViewer, type LifecycleOptions } from "../server/behold-lifecycle"

interface RpcResponse {
  readonly id: number
  readonly result?: {
    readonly content?: ReadonlyArray<{ readonly text: string }>
    readonly structuredContent?: unknown
    readonly tools?: ReadonlyArray<{
      readonly name: string
      readonly annotations?: { readonly readOnlyHint?: boolean }
    }>
  }
  readonly error?: unknown
}

const processes: Array<ChildProcessWithoutNullStreams> = []
const directories: string[] = []
const runtimes: LifecycleOptions[] = []

afterEach(async () => {
  for (const child of processes.splice(0)) child.kill()
  await Promise.allSettled(runtimes.splice(0).map((options) => stopViewer(options)))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const makeClient = async () => {
  const port = 20_000 + Math.floor(Math.random() * 20_000)
  const origin = `http://127.0.0.1:${port}`
  const dataDirectory = await mkdtemp(join(tmpdir(), "behold-mcp-"))
  directories.push(dataDirectory)
  runtimes.push({ root: process.cwd(), origin, dataDirectory })

  const child = spawn("bun", ["run", "server/mcp-main.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, BEHOLD_ORIGIN: `${origin}/`, BEHOLD_DATA_DIR: dataDirectory },
    stdio: ["pipe", "pipe", "pipe"],
  })
  processes.push(child)

  let nextId = 1
  let stderr = ""
  const pending = new Map<number, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }>()
  child.stderr.on("data", (chunk) => (stderr += String(chunk)))
  child.once("exit", (code) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`MCP process exited ${code}: ${stderr}`))
    pending.clear()
  })
  createInterface({ input: child.stdout }).on("line", (line) => {
    const response = JSON.parse(line) as RpcResponse
    const waiter = pending.get(response.id)
    if (!waiter) return
    pending.delete(response.id)
    waiter.resolve(response)
  })

  const notify = (method: string, params: unknown) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
  }
  const request = (method: string, params: unknown): Promise<RpcResponse> => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })
  }
  const call = async (name: string, args: unknown) => {
    const response = await request("tools/call", { name, arguments: args })
    if (response.error) throw new Error(JSON.stringify(response.error))
    const result = response.result
    if (!result) throw new Error("MCP tool returned no result")
    if (result.structuredContent !== undefined) return result.structuredContent
    const text = result.content?.[0]?.text
    if (!text) throw new Error("MCP tool returned no content")
    return JSON.parse(text) as unknown
  }

  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "behold-test", version: "1" },
  })
  notify("notifications/initialized", {})
  return { child, origin, requestOrigin: `http://127.0.0.1:${port}`, request, call }
}

describe("Behold MCP", () => {
  it("auto-starts the viewer and completes the document feedback lifecycle", { timeout: 30_000 }, async () => {
    const client = await makeClient()
    const listed = await client.request("tools/list", {})
    expect(listed.result?.tools?.map((tool) => tool.name)).toContain("wait_for_feedback")
    expect(listed.result?.tools?.find((tool) => tool.name === "wait_for_feedback")?.annotations?.readOnlyHint).toBe(false)

    const created = (await client.call("host_document", {
      markdown: "# MCP test\n\nReview this sentence.",
    })) as { id: string; url: string; version: number; currentRevisionId: string; revisionId: string }
    expect(new URL(created.url).hostname).toBe("127.0.0.1")
    expect(created.version).toBe(1)
    expect(created.currentRevisionId).toBe(created.revisionId)

    const waiting = client.call("wait_for_feedback", { documentId: created.id, timeoutSeconds: 10 })
    const commentResponse = await fetch(`${client.origin}/api/documents/${created.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-behold-request": "1" },
      body: JSON.stringify({
        content: "Please revise this.",
        location: {
          sectionIndex: 0,
          sectionType: "markdown",
          selectedText: "Review this sentence.",
          contextBefore: "",
          contextAfter: "",
        },
      }),
    })
    expect(commentResponse.status).toBe(201)

    const feedback = (await waiting) as { comments: ReadonlyArray<{ content: string }>; timedOut: boolean }
    expect(feedback.comments.map((comment) => comment.content)).toEqual(["Please revise this."])
    expect(feedback.timedOut).toBe(false)

    const deliveredAgain = (await client.call("wait_for_feedback", {
      documentId: created.id,
      timeoutSeconds: 0,
    })) as { comments: ReadonlyArray<unknown> }
    expect(deliveredAgain.comments).toEqual([])

    const updated = (await client.call("update_document", {
      id: created.id,
      markdown: "# MCP test\n\nRevised sentence.",
    })) as { version: number }
    expect(updated.version).toBe(2)

    const versions = (await client.call("list_document_versions", { id: created.id })) as {
      currentVersion: number
      currentRevisionId: string
      versions: ReadonlyArray<{ id: string; revisionId: string }>
    }
    expect(versions.currentVersion).toBe(2)
    expect(versions.versions).toHaveLength(2)
    expect(versions.versions[0]).not.toHaveProperty("markdown")
    expect(versions.currentRevisionId).toBe(versions.versions[1]?.revisionId)
    expect(versions.versions.every((revision) => revision.id === revision.revisionId)).toBe(true)

    const revisionDiff = (await client.call("diff_document_versions", {
      id: created.id,
      fromRevisionId: versions.versions[0]?.revisionId,
      toRevisionId: versions.versions[1]?.revisionId,
    })) as { patch: string; additions: number; deletions: number }
    expect(revisionDiff.patch).toContain("+Revised sentence.")
    expect(revisionDiff.additions).toBeGreaterThan(0)
    expect(revisionDiff.deletions).toBeGreaterThan(0)

    await client.call("delete_document", { id: created.id })

    client.child.kill()
    await new Promise<void>((resolve) => client.child.once("exit", () => resolve()))
    const health = await fetch(`${client.requestOrigin}/api/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ service: "behold", status: "ok" })
  })
})

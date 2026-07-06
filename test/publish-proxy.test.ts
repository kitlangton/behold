import { createServer } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import {
  createPublishProxy,
  type PublicationReceipt,
  type PublicationStore,
} from "../server/publish-proxy"

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

const receipt = (overrides: Partial<PublicationReceipt> = {}): PublicationReceipt => ({
  slug: "demo",
  url: "https://publish.example/published/demo",
  exportedAt: "2026-07-06T12:00:00.000Z",
  publishedRevisionId: "revision-1",
  remoteStatus: "published",
  checkedAt: "2026-07-06T12:00:01.000Z",
  ...overrides,
})

const makeStore = (initial: ReadonlyArray<{ readonly documentId: string; readonly publication: PublicationReceipt }> = []) => {
  const values = new Map(initial.map((entry) => [entry.documentId, entry.publication]))
  const store: PublicationStore = {
    listPublicationReceipts: async () => Array.from(values, ([documentId, publication]) => ({ documentId, publication })),
    setPublicationReceipt: async (documentId, publication) => {
      values.set(documentId, publication)
    },
    clearPublicationReceipt: async (documentId, expectedExportedAt) => {
      const current = values.get(documentId)
      if (!current || expectedExportedAt && current.exportedAt !== expectedExportedAt) return false
      values.delete(documentId)
      return true
    },
  }
  return { store, values }
}

const serve = async (middleware: ReturnType<typeof createPublishProxy>["middleware"]) => {
  const server = createServer((request, response) => middleware(request, response, () => {
    response.statusCode = 404
    response.end()
  }))
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing test server address")
  return `http://127.0.0.1:${address.port}`
}

describe("publish proxy", () => {
  it("records a durable receipt after publishing without forwarding local identity", async () => {
    const { store, values } = makeStore()
    let forwarded: Readonly<Record<string, unknown>> | undefined
    const proxy = createPublishProxy(
      { BEHOLD_PUBLISH_ORIGIN: "https://publish.example", BEHOLD_PUBLISH_TOKEN: "secret" },
      store,
      {
        now: () => "2026-07-06T12:00:01.000Z",
        fetch: async (_input, init) => {
          forwarded = JSON.parse(String(init?.body)) as Readonly<Record<string, unknown>>
          return Response.json({ slug: "demo", url: "https://publish.example/published/demo", updated: false }, { status: 201 })
        },
      },
    )
    const origin = await serve(proxy.middleware)
    const response = await fetch(`${origin}/api/publish-remote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Behold-Request": "1" },
      body: JSON.stringify({
        documentId: "document-1",
        revisionId: "revision-1",
        snapshot: { slug: "demo", exportedAt: "2026-07-06T12:00:00.000Z", markdown: "# Demo" },
      }),
    })

    expect(response.status).toBe(201)
    expect(forwarded).toEqual({ slug: "demo", exportedAt: "2026-07-06T12:00:00.000Z", markdown: "# Demo" })
    expect(values.get("document-1")).toEqual(receipt())
    expect(await response.json()).toMatchObject({ publication: receipt() })
  })

  it("rejects browser publish mutations without the local request header", async () => {
    const proxy = createPublishProxy(
      { BEHOLD_PUBLISH_ORIGIN: "https://publish.example", BEHOLD_PUBLISH_TOKEN: "secret" },
      makeStore().store,
    )
    const origin = await serve(proxy.middleware)
    const response = await fetch(`${origin}/api/publish-remote`, { method: "POST", body: "{}" })

    expect(response.status).toBe(403)
  })

  it("reconciles published, missing, and unreachable receipts without discarding them", async () => {
    const { store, values } = makeStore([
      { documentId: "published", publication: receipt() },
      { documentId: "missing", publication: receipt({ slug: "missing", url: "https://publish.example/published/missing" }) },
      { documentId: "other-origin", publication: receipt({ slug: "other", url: "https://other.example/published/other" }) },
    ])
    const proxy = createPublishProxy(
      { BEHOLD_PUBLISH_ORIGIN: "https://publish.example", BEHOLD_PUBLISH_TOKEN: "secret" },
      store,
      {
        now: () => "2026-07-06T13:00:00.000Z",
        fetch: async () => Response.json({ documents: [{ slug: "demo", exportedAt: "2026-07-06T12:00:00.000Z", url: "https://publish.example/published/demo" }] }),
      },
    )

    await proxy.reconcile()

    expect(values.get("published")?.remoteStatus).toBe("published")
    expect(values.get("missing")?.remoteStatus).toBe("missing")
    expect(values.get("other-origin")?.remoteStatus).toBe("unavailable")
    expect(values.size).toBe(3)
  })

  it("unpublishes by receipt and conditionally clears local state", async () => {
    const { store, values } = makeStore([{ documentId: "document-1", publication: receipt() }])
    let remoteUrl = ""
    const proxy = createPublishProxy(
      { BEHOLD_PUBLISH_ORIGIN: "https://publish.example", BEHOLD_PUBLISH_TOKEN: "secret" },
      store,
      {
        fetch: async (input, init) => {
          remoteUrl = String(input)
          expect(init?.method).toBe("DELETE")
          return Response.json({ slug: "demo", deleted: true })
        },
      },
    )
    const origin = await serve(proxy.middleware)
    const response = await fetch(`${origin}/api/publish-remote`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "X-Behold-Request": "1" },
      body: JSON.stringify({ documentId: "document-1" }),
    })

    expect(response.status).toBe(200)
    expect(new URL(remoteUrl).searchParams.get("exportedAt")).toBe("2026-07-06T12:00:00.000Z")
    expect(values.has("document-1")).toBe(false)
    expect(await response.json()).toMatchObject({ documentId: "document-1", deleted: true, cleared: true })
  })

  it("preserves a receipt and marks it unavailable when unpublish cannot reach the Worker", async () => {
    const { store, values } = makeStore([{ documentId: "document-1", publication: receipt() }])
    const proxy = createPublishProxy(
      { BEHOLD_PUBLISH_ORIGIN: "https://publish.example", BEHOLD_PUBLISH_TOKEN: "secret" },
      store,
      { now: () => "2026-07-06T13:00:00.000Z", fetch: async () => { throw new TypeError("offline") } },
    )
    const origin = await serve(proxy.middleware)
    const response = await fetch(`${origin}/api/publish-remote`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "X-Behold-Request": "1" },
      body: JSON.stringify({ documentId: "document-1" }),
    })

    expect(response.status).toBe(502)
    expect(values.get("document-1")?.remoteStatus).toBe("unavailable")
  })

  it("preserves a receipt when a successful unpublish response is malformed", async () => {
    const { store, values } = makeStore([{ documentId: "document-1", publication: receipt() }])
    const proxy = createPublishProxy(
      { BEHOLD_PUBLISH_ORIGIN: "https://publish.example", BEHOLD_PUBLISH_TOKEN: "secret" },
      store,
      { fetch: async () => Response.json({ ok: true }) },
    )
    const origin = await serve(proxy.middleware)
    const response = await fetch(`${origin}/api/publish-remote`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "X-Behold-Request": "1" },
      body: JSON.stringify({ documentId: "document-1" }),
    })

    expect(response.status).toBe(502)
    expect(values.get("document-1")?.remoteStatus).toBe("unavailable")
  })
})

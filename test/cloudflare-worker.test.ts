import { beforeEach, describe, expect, it, vi } from "vitest"
import { handleCloudflareRequest, type CloudflareEnvironment } from "../cloudflare/worker"
import type { PublishedDocumentSnapshot } from "../src/lib/published"
import type { OgCard } from "../cloudflare/og-image"

const renderedCards: OgCard[] = []

vi.mock("../cloudflare/og-image", () => ({
  ogImageResponse: (card: OgCard) => {
    renderedCards.push(card)
    return new Response("png-bytes", { headers: { "Content-Type": "image/png" } })
  },
}))

interface StoredValue {
  readonly body: string
  readonly customMetadata: Record<string, string>
}

const values = new Map<string, StoredValue>()

const storedObject = (key: string, value: StoredValue) => ({
  key,
  httpEtag: `"${key}-etag"`,
  customMetadata: value.customMetadata,
})

const environment = (): CloudflareEnvironment => ({
  BEHOLD_PUBLISH_TOKEN: "publish-secret",
  ASSETS: {
    fetch: async () => new Response("<!doctype html><html><head><title>Behold</title></head><body><div id=\"root\"></div></body></html>", {
      headers: { "Content-Type": "text/html" },
    }),
  },
  SNAPSHOTS: {
    get: async (key) => {
      const value = values.get(key)
      return value ? { ...storedObject(key, value), text: async () => value.body } : null
    },
    head: async (key) => {
      const value = values.get(key)
      return value ? storedObject(key, value) : null
    },
    put: async (key, body, options) => {
      const value = { body, customMetadata: options.customMetadata }
      values.set(key, value)
      return storedObject(key, value)
    },
    list: async ({ prefix }) => ({
      objects: Array.from(values.entries())
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => storedObject(key, value)),
      truncated: false,
    }),
  },
})

const snapshot = (title = "Cloudflare publish"): PublishedDocumentSnapshot => ({
  slug: "cloudflare-publish",
  title,
  markdown: `# ${title}\n\nA user-owned public snapshot.`,
  exportedAt: "2026-07-05T20:00:00.000Z",
  sourceDocumentId: "document-1",
  sourcePath: "/Users/example/private.md",
  document: { sections: [{ _tag: "markdown", markdown: `# ${title}` }] },
})

describe("Cloudflare publishing worker", () => {
  beforeEach(() => {
    values.clear()
    renderedCards.length = 0
  })

  it("advertises the provider-neutral publishing protocol", async () => {
    const response = await handleCloudflareRequest(new Request("https://behold.example/api/behold"), environment())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      protocol: "behold-publish/1",
      maxSnapshotBytes: 4 * 1024 * 1024,
      capabilities: ["snapshots"],
    })
  })

  it("requires auth, publishes a sanitized snapshot, and reports updates", async () => {
    const unauthorized = await handleCloudflareRequest(new Request("https://behold.example/api/published-documents", {
      method: "POST",
      body: JSON.stringify(snapshot()),
    }), environment())
    expect(unauthorized.status).toBe(401)

    const publish = (title: string) => handleCloudflareRequest(new Request("https://behold.example/api/published-documents", {
      method: "POST",
      headers: { Authorization: "Bearer publish-secret", "Content-Type": "application/json" },
      body: JSON.stringify(snapshot(title)),
    }), environment())

    const created = await publish("First")
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual({
      slug: "cloudflare-publish",
      url: "https://behold.example/published/cloudflare-publish",
      updated: false,
    })

    const updated = await publish("Second")
    expect(updated.status).toBe(200)
    expect((await updated.json() as { updated: boolean }).updated).toBe(true)

    const stored = JSON.parse(values.get("published/cloudflare-publish.json")!.body)
    expect(stored.title).toBe("Second")
    expect(stored).not.toHaveProperty("sourcePath")
  })

  it("lists R2 metadata and returns individual snapshots", async () => {
    await handleCloudflareRequest(new Request("https://behold.example/api/published-documents", {
      method: "POST",
      headers: { Authorization: "Bearer publish-secret" },
      body: JSON.stringify(snapshot()),
    }), environment())

    const list = await handleCloudflareRequest(new Request("https://behold.example/api/published-documents"), environment())
    expect(await list.json()).toEqual({
      documents: [{
        slug: "cloudflare-publish",
        title: "Cloudflare publish",
        exportedAt: "2026-07-05T20:00:00.000Z",
        url: "https://behold.example/published/cloudflare-publish",
      }],
    })

    const get = await handleCloudflareRequest(new Request("https://behold.example/api/published-documents?slug=cloudflare-publish"), environment())
    expect(get.status).toBe(200)
    expect((await get.json() as { title: string }).title).toBe("Cloudflare publish")
  })

  it("injects public metadata into the viewer shell", async () => {
    await handleCloudflareRequest(new Request("https://behold.example/api/published-documents", {
      method: "POST",
      headers: { Authorization: "Bearer publish-secret" },
      body: JSON.stringify(snapshot("A <safe> title")),
    }), environment())

    const page = await handleCloudflareRequest(new Request("https://behold.example/published/cloudflare-publish"), environment())
    const html = await page.text()
    expect(page.status).toBe(200)
    expect(html).toContain("<title>A &lt;safe&gt; title</title>")
    expect(html).toContain('content="https://behold.example/published/cloudflare-publish"')
    expect(html).toContain('property="og:image" content="https://behold.example/api/og-image?slug=cloudflare-publish"')
    expect(html).toContain('name="twitter:card" content="summary_large_image"')
  })

  it("injects site metadata and an OG image into the landing shell", async () => {
    const page = await handleCloudflareRequest(new Request("https://behold.example/"), environment())
    const html = await page.text()
    expect(page.status).toBe(200)
    expect(html).toContain("<title>Behold</title>")
    expect(html).toContain('property="og:image" content="https://behold.example/api/og-image"')
    expect(html).toContain('property="og:type" content="website"')
  })

  it("renders OG cards for the site and published snapshots", async () => {
    const site = await handleCloudflareRequest(new Request("https://behold.example/api/og-image"), environment())
    expect(site.headers.get("Content-Type")).toBe("image/png")
    expect(renderedCards[0]).toMatchObject({ title: "A focused review surface for agent work", kicker: "Local-first agent review", host: "behold.example" })

    const missing = await handleCloudflareRequest(new Request("https://behold.example/api/og-image?slug=nope-not-here"), environment())
    expect(missing.status).toBe(404)

    await handleCloudflareRequest(new Request("https://behold.example/api/published-documents", {
      method: "POST",
      headers: { Authorization: "Bearer publish-secret" },
      body: JSON.stringify(snapshot("Card title")),
    }), environment())
    const published = await handleCloudflareRequest(new Request("https://behold.example/api/og-image?slug=cloudflare-publish"), environment())
    expect(published.headers.get("Content-Type")).toBe("image/png")
    expect(renderedCards.at(-1)).toMatchObject({
      title: "Card title",
      description: "A user-owned public snapshot.",
      kicker: "Published snapshot",
      footnote: "Jul 5, 2026",
    })
  })
})

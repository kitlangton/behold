import { isPublishedSlug, preparePublishedSnapshot, type PublishedDocumentSnapshot } from "../src/lib/published"

const snapshotPrefix = "published/"
const maxSnapshotBytes = 4 * 1024 * 1024
const maxPublishedDocuments = 1_000

interface StoredObject {
  readonly key: string
  readonly etag: string
  readonly httpEtag: string
  readonly customMetadata?: Record<string, string>
}

interface StoredObjectBody extends StoredObject {
  readonly text: () => Promise<string>
}

interface SnapshotBucket {
  readonly get: (key: string) => Promise<StoredObjectBody | null>
  readonly head: (key: string) => Promise<StoredObject | null>
  readonly put: (
    key: string,
    value: string,
    options: {
      readonly httpMetadata: { readonly contentType: string; readonly cacheControl: string }
      readonly customMetadata: Record<string, string>
      readonly onlyIf?: { readonly etagMatches: string }
    },
  ) => Promise<StoredObject | null>
  readonly list: (options: {
    readonly prefix: string
    readonly limit: number
    readonly cursor?: string
    readonly include: ReadonlyArray<"customMetadata">
  }) => Promise<{
    readonly objects: ReadonlyArray<StoredObject>
    readonly truncated: boolean
    readonly cursor?: string
  }>
}

interface AssetFetcher {
  readonly fetch: (request: Request) => Promise<Response>
}

export interface CloudflareEnvironment {
  readonly ASSETS: AssetFetcher
  readonly SNAPSHOTS: SnapshotBucket
  readonly BEHOLD_PUBLISH_TOKEN: string
}

interface PublishedManifestEntry {
  readonly slug: string
  readonly title: string
  readonly exportedAt: string
  readonly url: string
}

const json = (payload: unknown, init: ResponseInit = {}): Response => {
  const headers = new Headers(init.headers)
  headers.set("Content-Type", "application/json; charset=utf-8")
  headers.set("X-Content-Type-Options", "nosniff")
  return new Response(JSON.stringify(payload), { ...init, headers })
}

const textEncoder = new TextEncoder()
const byteLength = (value: string): number => textEncoder.encode(value).byteLength

const secureEqual = async (left: string, right: string): Promise<boolean> => {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", textEncoder.encode(left)),
    crypto.subtle.digest("SHA-256", textEncoder.encode(right)),
  ])
  const leftBytes = new Uint8Array(leftHash)
  const rightBytes = new Uint8Array(rightHash)
  let difference = 0
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index]
  return difference === 0
}

const authorized = async (request: Request, environment: CloudflareEnvironment): Promise<boolean> => {
  const expected = environment.BEHOLD_PUBLISH_TOKEN?.trim()
  const actual = request.headers.get("Authorization")
  if (!expected || !actual?.startsWith("Bearer ")) return false
  return secureEqual(actual.slice("Bearer ".length), expected)
}

const isPublishedSnapshot = (payload: unknown): payload is PublishedDocumentSnapshot => {
  if (!payload || typeof payload !== "object") return false
  if (!("slug" in payload) || typeof payload.slug !== "string" || !isPublishedSlug(payload.slug)) return false
  if (!("title" in payload) || typeof payload.title !== "string" || payload.title.length === 0 || payload.title.length > 500) return false
  if (!("markdown" in payload) || typeof payload.markdown !== "string") return false
  if (!("exportedAt" in payload) || typeof payload.exportedAt !== "string" || !Number.isFinite(Date.parse(payload.exportedAt))) return false
  if ("sourceDocumentId" in payload && payload.sourceDocumentId !== undefined && typeof payload.sourceDocumentId !== "string") return false
  if (!("document" in payload) || !payload.document || typeof payload.document !== "object") return false
  if (!("sections" in payload.document) || !Array.isArray(payload.document.sections)) return false
  return payload.document.sections.every((section) =>
    !!section && typeof section === "object" && "_tag" in section && section._tag === "markdown" && "markdown" in section && typeof section.markdown === "string"
  )
}

const objectKey = (slug: string): string => `${snapshotPrefix}${slug}.json`

const isExpectedExportedAt = (value: string): boolean => {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

const snapshotSlug = (key: string): string | undefined => {
  if (!key.startsWith(snapshotPrefix) || !key.endsWith(".json")) return undefined
  const slug = key.slice(snapshotPrefix.length, -".json".length)
  return isPublishedSlug(slug) ? slug : undefined
}

const loadSnapshot = async (environment: CloudflareEnvironment, slug: string): Promise<{ readonly body: string; readonly etag: string } | undefined> => {
  const object = await environment.SNAPSHOTS.get(objectKey(slug))
  if (!object || object.customMetadata?.deleted === "true") return undefined
  return { body: await object.text(), etag: object.etag }
}

const listSnapshots = async (request: Request, environment: CloudflareEnvironment): Promise<ReadonlyArray<PublishedManifestEntry>> => {
  const entries: PublishedManifestEntry[] = []
  let cursor: string | undefined
  do {
    const page = await environment.SNAPSHOTS.list({
      prefix: snapshotPrefix,
      limit: Math.min(1_000, maxPublishedDocuments - entries.length),
      cursor,
      include: ["customMetadata"],
    })
    for (const object of page.objects) {
      const slug = snapshotSlug(object.key)
      const metadata = object.customMetadata
      if (!slug || !metadata?.title || !metadata.exportedAt) continue
      entries.push({
        slug,
        title: metadata.title,
        exportedAt: metadata.exportedAt,
        url: `${new URL(request.url).origin}/published/${encodeURIComponent(slug)}`,
      })
      if (entries.length >= maxPublishedDocuments) break
    }
    cursor = page.truncated && entries.length < maxPublishedDocuments ? page.cursor : undefined
  } while (cursor)
  return entries.sort((left, right) => Date.parse(right.exportedAt) - Date.parse(left.exportedAt) || left.slug.localeCompare(right.slug))
}

const getPublishedDocuments = async (request: Request, environment: CloudflareEnvironment): Promise<Response> => {
  const slug = new URL(request.url).searchParams.get("slug")?.trim()
  if (slug) {
    if (!isPublishedSlug(slug)) return json({ error: "Invalid published document slug." }, { status: 400 })
    const snapshot = await loadSnapshot(environment, slug)
    if (!snapshot) return json({ error: "Published document not found." }, { status: 404 })
    return new Response(snapshot.body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ETag: snapshot.etag,
        "X-Content-Type-Options": "nosniff",
      },
    })
  }
  return json({ documents: await listSnapshots(request, environment) }, {
    headers: { "Cache-Control": "no-store" },
  })
}

const deletePublishedDocument = async (request: Request, environment: CloudflareEnvironment): Promise<Response> => {
  if (!environment.BEHOLD_PUBLISH_TOKEN?.trim()) return json({ error: "BEHOLD_PUBLISH_TOKEN is not configured." }, { status: 500 })
  if (!await authorized(request, environment)) return json({ error: "Unauthorized." }, { status: 401, headers: { "Cache-Control": "no-store" } })

  const url = new URL(request.url)
  const slug = url.searchParams.get("slug")?.trim() ?? ""
  const expectedExportedAt = url.searchParams.get("exportedAt")?.trim() ?? ""
  if (!isPublishedSlug(slug)) return json({ error: "Invalid published document slug." }, { status: 400, headers: { "Cache-Control": "no-store" } })
  if (!isExpectedExportedAt(expectedExportedAt)) return json({ error: "Invalid expected exportedAt." }, { status: 400, headers: { "Cache-Control": "no-store" } })

  const key = objectKey(slug)
  const stored = await loadSnapshot(environment, slug)
  if (!stored) return json({ slug, deleted: false }, { status: 200, headers: { "Cache-Control": "no-store" } })

  let snapshot: unknown
  try {
    snapshot = JSON.parse(stored.body)
  } catch {
    return json({ error: "Stored published document snapshot is invalid." }, { status: 500, headers: { "Cache-Control": "no-store" } })
  }
  if (!isPublishedSnapshot(snapshot)) return json({ error: "Stored published document snapshot is invalid." }, { status: 500, headers: { "Cache-Control": "no-store" } })
  if (snapshot.exportedAt !== expectedExportedAt) {
    return json({ slug, deleted: false, currentExportedAt: snapshot.exportedAt }, { status: 409, headers: { "Cache-Control": "no-store" } })
  }

  const tombstone = await environment.SNAPSHOTS.put(key, JSON.stringify({ deleted: true }), {
    onlyIf: { etagMatches: stored.etag },
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "no-store",
    },
    customMetadata: { slug, deleted: "true" },
  })
  if (!tombstone) {
    const current = await loadSnapshot(environment, slug)
    if (!current) return json({ slug, deleted: false }, { status: 200, headers: { "Cache-Control": "no-store" } })
    let currentExportedAt: string | undefined
    try {
      const payload = JSON.parse(current.body) as { readonly exportedAt?: unknown }
      if (typeof payload.exportedAt === "string") currentExportedAt = payload.exportedAt
    } catch {
      // The subsequent request can report the invalid stored snapshot.
    }
    return json({ slug, deleted: false, ...(currentExportedAt ? { currentExportedAt } : {}) }, { status: 409, headers: { "Cache-Control": "no-store" } })
  }
  return json({ slug, deleted: true }, { status: 200, headers: { "Cache-Control": "no-store" } })
}

const publishDocument = async (request: Request, environment: CloudflareEnvironment): Promise<Response> => {
  if (!environment.BEHOLD_PUBLISH_TOKEN?.trim()) return json({ error: "BEHOLD_PUBLISH_TOKEN is not configured." }, { status: 500 })
  if (!await authorized(request, environment)) return json({ error: "Unauthorized." }, { status: 401 })

  const contentLength = Number(request.headers.get("Content-Length"))
  if (Number.isFinite(contentLength) && contentLength > maxSnapshotBytes) {
    return json({ error: "Published document snapshot payload is too large." }, { status: 413 })
  }
  const body = await request.text()
  if (byteLength(body) > maxSnapshotBytes) return json({ error: "Published document snapshot payload is too large." }, { status: 413 })

  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return json({ error: "Expected valid JSON snapshot payload." }, { status: 400 })
  }
  if (!isPublishedSnapshot(payload)) return json({ error: "Expected a published document snapshot payload." }, { status: 400 })

  const snapshot = preparePublishedSnapshot(payload)
  const snapshotBody = JSON.stringify(snapshot, null, 2)
  if (byteLength(snapshotBody) > maxSnapshotBytes) return json({ error: "Published document snapshot is too large." }, { status: 413 })

  const key = objectKey(snapshot.slug)
  const updated = await environment.SNAPSHOTS.head(key) !== null
  await environment.SNAPSHOTS.put(key, snapshotBody, {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "public, max-age=60, stale-while-revalidate=300",
    },
    customMetadata: {
      slug: snapshot.slug,
      title: snapshot.title,
      exportedAt: snapshot.exportedAt,
    },
  })

  return json({
    slug: snapshot.slug,
    url: `${new URL(request.url).origin}/published/${encodeURIComponent(snapshot.slug)}`,
    updated,
  }, { status: updated ? 200 : 201 })
}

const escapeHtml = (input: string): string =>
  input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

const extractDescription = (markdown: string): string => {
  const lines = markdown.split(/\r?\n/)
  let inFence = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inFence = !inFence
      continue
    }
    if (inFence || line === "" || /^[#>*-]/.test(line)) continue
    const cleaned = line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`]/g, "").replace(/<[^>]+>/g, "").trim()
    if (cleaned === "") continue
    return cleaned.length > 200 ? `${cleaned.slice(0, 197)}...` : cleaned
  }
  return "Published with Behold."
}

const siteDescription =
  "Turn plans, proposals, and technical notes into a focused review surface. Documents and feedback stay local until you explicitly publish a frozen snapshot."

const formatSnapshotDate = (iso: string): string => {
  const date = new Date(iso)
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : ""
}

const ogImage = async (request: Request, environment: CloudflareEnvironment): Promise<Response> => {
  const url = new URL(request.url)
  const slug = url.searchParams.get("slug")?.trim()
  const { ogImageResponse } = await import("./og-image")
  if (!slug) {
    return ogImageResponse({
      title: "A focused review surface for agent work",
      description: "Documents and feedback stay local until you explicitly publish a frozen snapshot.",
      kicker: "Local-first agent review",
      host: url.hostname,
      footnote: "bunx @kitlangton/behold setup",
    })
  }
  if (!isPublishedSlug(slug)) return json({ error: "Invalid published document slug." }, { status: 400 })
  const stored = await loadSnapshot(environment, slug)
  if (!stored) return json({ error: "Published document not found." }, { status: 404 })
  const snapshot = JSON.parse(stored.body) as PublishedDocumentSnapshot
  return ogImageResponse({
    title: snapshot.title || "Untitled document",
    description: extractDescription(snapshot.markdown),
    kicker: "Published snapshot",
    host: url.hostname,
    footnote: formatSnapshotDate(snapshot.exportedAt),
  })
}

const socialMeta = (options: {
  readonly title: string
  readonly description: string
  readonly canonicalUrl: string
  readonly imageUrl: string
  readonly type: "website" | "article"
}): string =>
  [
    `<title>${escapeHtml(options.title)}</title>`,
    `<meta name="description" content="${escapeHtml(options.description)}" />`,
    `<meta property="og:title" content="${escapeHtml(options.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(options.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(options.canonicalUrl)}" />`,
    `<meta property="og:type" content="${options.type}" />`,
    `<meta property="og:site_name" content="Behold" />`,
    `<meta property="og:image" content="${escapeHtml(options.imageUrl)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(options.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(options.description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(options.imageUrl)}" />`,
  ].join("\n    ")

const publishedSlugFromPath = (pathname: string): string | undefined => {
  if (!pathname.startsWith("/published/")) return undefined
  try {
    const slug = decodeURIComponent(pathname.slice("/published/".length))
    return isPublishedSlug(slug) ? slug : undefined
  } catch {
    return undefined
  }
}

const publishedPage = async (request: Request, environment: CloudflareEnvironment): Promise<Response> => {
  const url = new URL(request.url)
  const slug = publishedSlugFromPath(url.pathname)
  if (!slug) return new Response("Invalid published document slug.", { status: 400 })
  const snapshotObject = await loadSnapshot(environment, slug)
  if (!snapshotObject) return new Response("Published document not found.", { status: 404 })

  const shellResponse = await environment.ASSETS.fetch(new Request(new URL("/", url), request))
  if (!shellResponse.ok) return new Response("Unable to load app shell.", { status: 500 })
  const snapshot = JSON.parse(snapshotObject.body) as PublishedDocumentSnapshot
  const meta = socialMeta({
    title: snapshot.title || "Untitled document",
    description: extractDescription(snapshot.markdown),
    canonicalUrl: `${url.origin}/published/${encodeURIComponent(slug)}`,
    imageUrl: `${url.origin}/api/og-image?slug=${encodeURIComponent(slug)}`,
    type: "article",
  })
  const shell = (await shellResponse.text()).replace(/<title>[^<]*<\/title>/, meta)
  return new Response(shell, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

const landingPage = async (request: Request, environment: CloudflareEnvironment): Promise<Response> => {
  const shellResponse = await environment.ASSETS.fetch(request)
  if (!shellResponse.ok || !(shellResponse.headers.get("Content-Type") ?? "").includes("text/html")) return shellResponse
  const origin = new URL(request.url).origin
  const meta = socialMeta({
    title: "Behold",
    description: siteDescription,
    canonicalUrl: `${origin}/`,
    imageUrl: `${origin}/api/og-image`,
    type: "website",
  })
  const shell = (await shellResponse.text()).replace(/<title>[^<]*<\/title>/, meta)
  return new Response(shell, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

export const handleCloudflareRequest = async (request: Request, environment: CloudflareEnvironment): Promise<Response> => {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/api/behold") {
    return json({ protocol: "behold-publish/1", maxSnapshotBytes, capabilities: ["snapshots", "delete"] }, {
      headers: { "Cache-Control": "no-store" },
    })
  }
  if (url.pathname === "/api/published-documents") {
    if (request.method === "GET") return getPublishedDocuments(request, environment)
    if (request.method === "POST") return publishDocument(request, environment)
    if (request.method === "DELETE") return deletePublishedDocument(request, environment)
    return json({ error: "Method not allowed." }, { status: 405, headers: { Allow: "GET, POST, DELETE" } })
  }
  if (request.method === "GET" && url.pathname === "/api/og-image") return ogImage(request, environment)
  if (url.pathname.startsWith("/api/")) return json({ error: "Not found." }, { status: 404 })
  if (request.method === "GET" && url.pathname.startsWith("/published/")) return publishedPage(request, environment)
  if (request.method === "GET" && url.pathname === "/") return landingPage(request, environment)
  return environment.ASSETS.fetch(request)
}

export default {
  fetch: handleCloudflareRequest,
}

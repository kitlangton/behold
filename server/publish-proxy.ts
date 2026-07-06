import { readRequestBody, RequestBodyTooLargeError, sendJson, type NextHandleFunction } from "./http-helpers"

export interface PublicationReceipt {
  readonly slug: string
  readonly url: string
  readonly exportedAt: string
  readonly publishedRevisionId: string
  readonly remoteStatus: "published" | "missing" | "unavailable"
  readonly checkedAt: string
}

export interface PublicationStore {
  readonly listPublicationReceipts: () => Promise<ReadonlyArray<{ readonly documentId: string; readonly publication: PublicationReceipt }>>
  readonly setPublicationReceipt: (documentId: string, publication: PublicationReceipt) => Promise<void>
  readonly clearPublicationReceipt: (documentId: string, expectedExportedAt?: string) => Promise<boolean>
}

interface HostedPublishRequest {
  readonly documentId: string
  readonly revisionId: string
  readonly snapshot: {
    readonly slug: string
    readonly exportedAt: string
  } & Readonly<Record<string, unknown>>
}

interface PublishedManifestEntry {
  readonly slug: string
  readonly exportedAt: string
  readonly url: string
}

const parseObject = (value: string): Readonly<Record<string, unknown>> | undefined => {
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === "object" && parsed !== null ? parsed as Readonly<Record<string, unknown>> : undefined
  } catch {
    return undefined
  }
}

const parseHostedPublish = (value: Readonly<Record<string, unknown>>): HostedPublishRequest | undefined => {
  const snapshot = value.snapshot
  if (
    typeof value.documentId !== "string" ||
    typeof value.revisionId !== "string" ||
    typeof snapshot !== "object" ||
    snapshot === null ||
    !("slug" in snapshot) ||
    typeof snapshot.slug !== "string" ||
    !("exportedAt" in snapshot) ||
    typeof snapshot.exportedAt !== "string"
  ) return undefined
  return { documentId: value.documentId, revisionId: value.revisionId, snapshot: snapshot as HostedPublishRequest["snapshot"] }
}

const normalizedOrigin = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

const localMutationAllowed = (request: Parameters<NextHandleFunction>[0]): boolean => {
  if (request.headers["x-behold-request"] !== "1") return false
  if (request.headers["sec-fetch-site"] === "cross-site") return false
  const origin = request.headers.origin
  const host = request.headers.host
  if (!origin || !host) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

const manifestEntries = (payload: unknown): ReadonlyArray<PublishedManifestEntry> | undefined => {
  if (typeof payload !== "object" || payload === null || !("documents" in payload) || !Array.isArray(payload.documents)) return undefined
  const entries: PublishedManifestEntry[] = []
  for (const item of payload.documents) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("slug" in item) ||
      typeof item.slug !== "string" ||
      !("exportedAt" in item) ||
      typeof item.exportedAt !== "string" ||
      !("url" in item) ||
      typeof item.url !== "string"
    ) return undefined
    entries.push({ slug: item.slug, exportedAt: item.exportedAt, url: item.url })
  }
  return entries
}

export const createPublishProxy = (
  environment: Readonly<Record<string, string | undefined>>,
  publications?: PublicationStore,
  dependencies: { readonly fetch?: typeof fetch; readonly now?: () => string } = {},
): { readonly middleware: NextHandleFunction; readonly reconcile: () => Promise<void> } => {
  const publishOrigin = normalizedOrigin(environment.BEHOLD_PUBLISH_ORIGIN ?? environment.SHOW_PUBLISH_ORIGIN)
  const publishToken = environment.BEHOLD_PUBLISH_TOKEN ?? environment.SHOW_PUBLISH_TOKEN
  const fetchRemote = dependencies.fetch ?? fetch
  const now = dependencies.now ?? (() => new Date().toISOString())

  const setUnavailable = async (receipts: ReadonlyArray<{ readonly documentId: string; readonly publication: PublicationReceipt }>) => {
    if (!publications) return
    const checkedAt = now()
    await Promise.all(receipts.map(({ documentId, publication }) =>
      publications.setPublicationReceipt(documentId, { ...publication, remoteStatus: "unavailable", checkedAt })
    ))
  }

  const reconcile = async () => {
    if (!publications) return
    const receipts = await publications.listPublicationReceipts()
    if (receipts.length === 0) return
    if (!publishOrigin) {
      await setUnavailable(receipts)
      return
    }

    let entries: ReadonlyArray<PublishedManifestEntry> | undefined
    try {
      const remote = await fetchRemote(`${publishOrigin}/api/published-documents`, { signal: AbortSignal.timeout(5_000) })
      entries = remote.ok ? manifestEntries(await remote.json()) : undefined
    } catch {
      entries = undefined
    }
    if (!entries) {
      await setUnavailable(receipts)
      return
    }

    const checkedAt = now()
    await Promise.all(receipts.map(async ({ documentId, publication }) => {
      let receiptOrigin: string | undefined
      try {
        receiptOrigin = new URL(publication.url).origin
      } catch {
        receiptOrigin = undefined
      }
      if (receiptOrigin !== publishOrigin) {
        await publications.setPublicationReceipt(documentId, { ...publication, remoteStatus: "unavailable", checkedAt })
        return
      }
      const remote = entries.find((entry) => entry.slug === publication.slug)
      const matches = remote?.exportedAt === publication.exportedAt
      await publications.setPublicationReceipt(documentId, {
        ...publication,
        ...(matches && remote ? { url: remote.url } : {}),
        remoteStatus: matches ? "published" : "missing",
        checkedAt,
      })
    }))
  }

  const middleware: NextHandleFunction = async (request, response, next) => {
    let deleting: { readonly documentId: string; readonly publication: PublicationReceipt } | undefined
    const url = request.url ? new URL(request.url, "http://localhost") : undefined
    if (!url || url.pathname !== "/api/publish-remote" || (request.method !== "POST" && request.method !== "DELETE")) {
      next()
      return
    }

    if (!localMutationAllowed(request)) {
      sendJson(response, 403, { error: "Publish requests must come from the local Behold viewer." })
      return
    }
    if (!publishOrigin || !publishToken) {
      sendJson(response, 400, {
        error: "Missing publish configuration.",
        message: "Set BEHOLD_PUBLISH_ORIGIN and BEHOLD_PUBLISH_TOKEN in your local environment to enable remote publish.",
      })
      return
    }

    try {
      if (request.method === "POST") {
        const body = await readRequestBody(request)
        const object = parseObject(body)
        if (!object) {
          sendJson(response, 400, { error: "Expected a JSON publish request." })
          return
        }
        const hosted = parseHostedPublish(object)
        const snapshot = hosted?.snapshot ?? object
        const remote = await fetchRemote(`${publishOrigin}/api/published-documents`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${publishToken}` },
          body: JSON.stringify(snapshot),
        })
        const payload = await remote.json().catch(() => ({ error: `Remote publish failed with ${remote.status}.` })) as Readonly<Record<string, unknown>>
        if (!remote.ok || !hosted || !publications) {
          sendJson(response, remote.status, payload)
          return
        }
        if (typeof payload.url !== "string" || typeof payload.slug !== "string" || typeof payload.updated !== "boolean") {
          sendJson(response, 502, { error: "Remote publish returned an invalid response." })
          return
        }
        const receipt: PublicationReceipt = {
          slug: payload.slug,
          url: payload.url,
          exportedAt: hosted.snapshot.exportedAt,
          publishedRevisionId: hosted.revisionId,
          remoteStatus: "published",
          checkedAt: now(),
        }
        await publications.setPublicationReceipt(hosted.documentId, receipt)
        sendJson(response, remote.status, { ...payload, publication: receipt })
        return
      }

      const body = parseObject(await readRequestBody(request))
      const documentId = body?.documentId
      if (typeof documentId !== "string" || !publications) {
        sendJson(response, 400, { error: "Expected JSON { documentId }." })
        return
      }
      const current = (await publications.listPublicationReceipts()).find((entry) => entry.documentId === documentId)
      if (!current) {
        sendJson(response, 404, { error: "This document has no publication receipt." })
        return
      }
      deleting = current
      let receiptOrigin: string | undefined
      try {
        receiptOrigin = new URL(current.publication.url).origin
      } catch {
        receiptOrigin = undefined
      }
      if (receiptOrigin !== publishOrigin) {
        sendJson(response, 409, { error: "The publication belongs to a different configured origin." })
        return
      }
      const remoteUrl = new URL("/api/published-documents", publishOrigin)
      remoteUrl.searchParams.set("slug", current.publication.slug)
      remoteUrl.searchParams.set("exportedAt", current.publication.exportedAt)
      const remote = await fetchRemote(remoteUrl, { method: "DELETE", headers: { Authorization: `Bearer ${publishToken}` } })
      const payload = await remote.json().catch(() => ({ error: `Remote unpublish failed with ${remote.status}.` })) as Readonly<Record<string, unknown>>
      if (remote.status === 409) {
        await publications.setPublicationReceipt(documentId, { ...current.publication, remoteStatus: "missing", checkedAt: now() })
      }
      if (!remote.ok) {
        sendJson(response, remote.status, payload)
        return
      }
      if (payload.slug !== current.publication.slug || typeof payload.deleted !== "boolean") {
        await publications.setPublicationReceipt(documentId, {
          ...current.publication,
          remoteStatus: "unavailable",
          checkedAt: now(),
        })
        sendJson(response, 502, { error: "Remote unpublish returned an invalid response." })
        return
      }
      const cleared = await publications.clearPublicationReceipt(documentId, current.publication.exportedAt)
      sendJson(response, 200, { documentId, slug: current.publication.slug, deleted: payload.deleted, cleared })
    } catch (error) {
      if (deleting && publications) {
        await publications.setPublicationReceipt(deleting.documentId, {
          ...deleting.publication,
          remoteStatus: "unavailable",
          checkedAt: now(),
        }).catch(() => undefined)
      }
      const status = error instanceof RequestBodyTooLargeError ? 413 : error instanceof TypeError ? 502 : 400
      sendJson(response, status, { error: error instanceof Error ? error.message : "Unable to update published document." })
    }
  }

  return { middleware, reconcile }
}

import { readFile } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { isAbsolute, resolve } from "node:path"
import { Duration, Effect, ManagedRuntime, Option, Schema, Stream } from "effect"
import { agentGuide, agentSkill } from "./agent-guide"
import {
  DocumentReviewInvalidAnchor,
  DocumentReviewInvalidInput,
  DocumentReviewNotFound,
  DocumentReviewPersistenceError,
  DocumentReviews,
  CommentAnchor,
  type Comment,
  type Revision,
  type StoredDocument,
  type SubmitResult,
} from "./document-reviews"
import { resolveReadableLocalFilePath } from "./local-file-access"
import { readRequestBody, RequestBodyTooLargeError, sendJson, type NextHandleFunction } from "./http-helpers"

export interface DocumentApiOptions {
  readonly dataDirectory: string
  readonly storeFilePath: string
  readonly allowedFileRoots: () => ReadonlyArray<string>
  readonly runtimeId?: string
}

const DocumentPostInput = Schema.Struct({
  markdown: Schema.optionalKey(Schema.String),
  filePath: Schema.optionalKey(Schema.String),
})
const DocumentUpdateInput = Schema.Struct({ markdown: Schema.String })
const FeedbackAcknowledgementInput = Schema.Struct({ lastSeq: Schema.Number })
const CommentLocationInput = Schema.Struct({
  sectionIndex: Schema.Number,
  sectionType: Schema.Literal("markdown"),
  selectedText: Schema.String,
  contextBefore: Schema.optionalKey(Schema.String),
  contextAfter: Schema.optionalKey(Schema.String),
})
const CommentCreateInput = Schema.Struct({
  content: Schema.String,
  location: CommentLocationInput,
  anchor: Schema.optionalKey(CommentAnchor),
})
const CommentUpdateInput = Schema.Struct({
  content: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Literals(["open", "resolved"])),
})

const localFileAccessDeniedMessage = "Local file access is not allowed for this client or path."

const sendRequestBodyError = (response: ServerResponse, error: unknown): boolean => {
  if (!(error instanceof RequestBodyTooLargeError)) return false
  sendJson(response, 413, { error: error.message })
  return true
}

const parseJsonPayload = (body: string): unknown | undefined => {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

const decodeJsonPayload = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, body: string): S["Type"] | undefined => {
  const payload = parseJsonPayload(body)
  return payload === undefined ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(schema)(payload))
}

const originForRequest = (request: IncomingMessage): string => {
  const protocol = request.headers["x-forwarded-proto"] === "https" ? "https" : "http"
  const forwardedHost = request.headers["x-forwarded-host"]
  const host = (typeof forwardedHost === "string" ? forwardedHost : undefined) ?? request.headers.host ?? "behold.localhost:5173"
  return `${protocol}://${host}`
}

const isDocumentReviewError = (error: unknown, tag: string): boolean =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === tag

const documentReviewErrorStatus = (error: unknown): number | undefined => {
  if (error instanceof DocumentReviewNotFound || isDocumentReviewError(error, "DocumentReviewNotFound")) return 404
  if (error instanceof DocumentReviewInvalidInput || isDocumentReviewError(error, "DocumentReviewInvalidInput")) return 400
  if (error instanceof DocumentReviewInvalidAnchor || isDocumentReviewError(error, "DocumentReviewInvalidAnchor")) return 409
  if (error instanceof DocumentReviewPersistenceError || isDocumentReviewError(error, "DocumentReviewPersistenceError")) return 500
  return undefined
}

const errorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message
  return fallback
}

const sendDocumentReviewError = (response: ServerResponse, error: unknown, fallback: string) => {
  sendJson(response, documentReviewErrorStatus(error) ?? 500, { error: errorMessage(error, fallback) })
}

const parseDocumentPostInput = (
  body: string,
  contentType: string | undefined,
):
  | { readonly ok: true; readonly markdown: string; readonly sourcePath?: string }
  | { readonly ok: false; readonly message: string } => {
  if (!contentType?.includes("application/json")) {
    return { ok: true, markdown: body }
  }

  const parsed = decodeJsonPayload(DocumentPostInput, body)
  if (!parsed) {
    return { ok: false, message: "Expected valid JSON payload." }
  }

  if (typeof parsed.filePath === "string") {
    const rawPath = parsed.filePath.trim()
    if (!isAbsolute(rawPath)) {
      return { ok: false, message: "filePath must be an absolute path." }
    }
    return { ok: true, markdown: "", sourcePath: resolve(rawPath) }
  }

  if (typeof parsed.markdown === "string") {
    return { ok: true, markdown: parsed.markdown }
  }

  return { ok: false, message: "Expected raw markdown body or JSON { markdown } or { filePath }." }
}

const toHostedDocument = (document: StoredDocument & { readonly revision?: Revision }) => ({
  id: document.id,
  title: document.title,
  markdown: document.markdown,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
  sourcePath: document.sourcePath,
  version: document.version,
  currentRevisionId: document.currentRevisionId,
  revisionId: document.revision?.id ?? document.currentRevisionId,
})

const documentMutationPayload = (request: IncomingMessage, result: SubmitResult) => {
  const origin = originForRequest(request)
  const { document, outcome } = result
  const unchanged = outcome === "unchanged"
  const updated = outcome === "revised"
  const revisionId = result.revision?.id ?? document.currentRevisionId
  return {
    id: document.id,
    postUrl: `${origin}/api/documents`,
    documentUrl: `${origin}/api/documents/${document.id}`,
    url: `${origin}/?doc=${encodeURIComponent(document.id)}`,
    sourcePath: document.sourcePath,
    updated,
    unchanged,
    message: unchanged
      ? "Document unchanged. Existing hosted document kept as-is."
      : updated
        ? "Document updated. Reusing the existing hosted document id."
        : "Document created successfully.",
    version: document.version,
    currentRevisionId: document.currentRevisionId,
    revisionId,
  }
}

const revisionSummaryPayload = (revision: Revision) => ({
  id: revision.id,
  revisionId: revision.id,
  version: revision.number,
  title: revision.title,
  createdAt: revision.createdAt,
  parentRevisionId: revision.parentRevisionId,
})

const revisionPayload = (revision: Revision) => ({
  ...revisionSummaryPayload(revision),
  markdown: revision.markdown,
  contentHash: revision.contentHash,
})

export const createDocumentApi = (options: DocumentApiOptions): { middleware: NextHandleFunction; dispose: () => Promise<void> } => {
  const eventClients = new Set<ServerResponse>()
  const runtime = ManagedRuntime.make(DocumentReviews.layer({ directory: options.dataDirectory, storeFilePath: options.storeFilePath }))
  type RuntimeServices = ManagedRuntime.ManagedRuntime.Services<typeof runtime>
  const runDocumentReviewsPromise = <A, E>(effect: Effect.Effect<A, E, RuntimeServices>, signal?: AbortSignal) =>
    runtime.runPromise(effect, { signal })

  const sendEvent = (event: string, payload: unknown) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
    for (const client of eventClients) {
      try {
        client.write(message)
      } catch {
        eventClients.delete(client)
      }
    }
  }

  runtime.runFork(
    Effect.gen(function* () {
      const service = yield* DocumentReviews.Service
      yield* service.changes().pipe(
        Stream.runForEach((event) => {
          if (event._tag === "document-updated") {
            return service.getDocument(event.documentId).pipe(
              Effect.tap((document) =>
                Effect.sync(() => {
                  sendEvent("document-updated", {
                    documentId: event.documentId,
                    revisionId: event.revisionId,
                    updatedAt: document.updatedAt,
                    updated: event.outcome !== "created",
                  })
                  sendEvent("recent-documents-updated", {})
                }),
              ),
              Effect.catch(() => Effect.void),
            )
          }
          if (event._tag === "document-deleted") {
            return Effect.sync(() => {
              sendEvent("document-deleted", { documentId: event.documentId })
              sendEvent("recent-documents-updated", {})
            })
          }
          return Effect.sync(() => {
            sendEvent("comments-updated", { documentId: event.documentId })
          })
        }),
      )
    }),
  )

  const readableLocalFilePath = (request: IncomingMessage, filePath: string): Promise<string | undefined> =>
    resolveReadableLocalFilePath({ remoteAddress: request.socket.remoteAddress, filePath, allowedRoots: options.allowedFileRoots() })

  const middleware: NextHandleFunction = async (request, response, next) => {
    const method = request.method ?? "GET"
    const url = request.url ? new URL(request.url, originForRequest(request)) : undefined
    if (method === "GET" && url && (url.pathname === "/agent-howto" || url.pathname === "/skill")) {
      response.statusCode = 200
      response.setHeader("Content-Type", "text/markdown; charset=utf-8")
      response.end(url.pathname === "/skill" ? agentSkill(originForRequest(request)) : agentGuide(originForRequest(request)))
      return
    }
    if (!url || !url.pathname.startsWith("/api/")) {
      next()
      return
    }

    if (url.pathname === "/api/publish-remote") {
      next()
      return
    }

    if (method === "GET" && url.pathname === "/api/health") {
      try {
        await runDocumentReviewsPromise(DocumentReviews.Service.use((service) => service.listDocuments()))
        sendJson(response, 200, {
          service: "behold",
          status: "ok",
          ...(options.runtimeId ? { runtimeId: options.runtimeId, pid: process.pid } : {}),
        })
      } catch (error) {
        sendDocumentReviewError(response, error, "Document store is unavailable.")
      }
      return
    }

    if (method === "GET" && url.pathname === "/api/events") {
      response.statusCode = 200
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8")
      response.setHeader("Cache-Control", "no-cache, no-transform")
      response.setHeader("Connection", "keep-alive")
      response.write("retry: 1000\n\n")
      eventClients.add(response)

      const removeClient = () => {
        eventClients.delete(response)
        try {
          response.end()
        } catch {
          // noop
        }
      }

      request.on("close", removeClient)
      return
    }

    if (!url.pathname.startsWith("/api/documents")) {
      next()
      return
    }

    if (method === "POST" && url.pathname === "/api/documents") {
      let body: string
      try {
        body = await readRequestBody(request)
      } catch (error) {
        if (!sendRequestBodyError(response, error)) sendJson(response, 400, { error: errorMessage(error, "Unable to read request body.") })
        return
      }
      const parsed = parseDocumentPostInput(body, request.headers["content-type"])
      if (!parsed.ok) {
        sendJson(response, 400, { error: parsed.message })
        return
      }

      const readableSourcePath = parsed.sourcePath ? await readableLocalFilePath(request, parsed.sourcePath) : undefined
      if (parsed.sourcePath && !readableSourcePath) {
        sendJson(response, 403, { error: localFileAccessDeniedMessage })
        return
      }

      const markdown = readableSourcePath
        ? await readFile(readableSourcePath, "utf8").catch((error) => {
            const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
            if (code === "ENOENT") {
              sendJson(response, 404, { error: `File not found: ${parsed.sourcePath}` })
              return null
            }
            sendJson(response, 400, { error: errorMessage(error, "Unable to read markdown file.") })
            return null
          })
        : parsed.markdown

      if (markdown === null) return
      if (markdown.trim() === "") {
        sendJson(response, 400, { error: "Document markdown cannot be empty." })
        return
      }

      try {
        const result = await runDocumentReviewsPromise(
          DocumentReviews.Service.use((service) => service.submitDocument({ markdown, sourcePath: parsed.sourcePath })),
        )
        sendJson(response, result.outcome === "created" ? 201 : 200, documentMutationPayload(request, result))
      } catch (error) {
        sendDocumentReviewError(response, error, "Unable to save document.")
      }
      return
    }

    if (method === "PUT") {
      const documentMatch = /^\/api\/documents\/([^/]+)$/.exec(url.pathname)
      if (documentMatch) {
        const documentId = decodeURIComponent(documentMatch[1]!)
        let body: string
        try {
          body = await readRequestBody(request)
        } catch (error) {
          if (!sendRequestBodyError(response, error)) sendJson(response, 400, { error: errorMessage(error, "Unable to read request body.") })
          return
        }
        const payload = decodeJsonPayload(DocumentUpdateInput, body)
        const markdown = payload?.markdown ?? ""
        if (markdown.trim() === "") {
          sendJson(response, 400, { error: "Expected non-empty document markdown." })
          return
        }

        try {
          const result = await runDocumentReviewsPromise(
            DocumentReviews.Service.use((service) => service.reviseDocument(documentId, markdown)),
          )
          const payload = documentMutationPayload(request, result)
          sendJson(response, 200, {
            ...payload,
            updated: result.outcome !== "unchanged",
            unchanged: result.outcome === "unchanged",
            message: result.outcome === "unchanged" ? "Document unchanged." : "Document updated in place.",
          })
        } catch (error) {
          sendDocumentReviewError(response, error, "Unable to update document.")
        }
        return
      }
    }

    if (method === "GET") {
      if (url.pathname === "/api/documents") {
        try {
          const documents = await runDocumentReviewsPromise(
            DocumentReviews.Service.use((service) => service.listDocuments()),
          )
          sendJson(response, 200, {
            documents: documents
              .toSorted((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1))
              .map((document) => ({
                id: document.id,
                title: document.title,
                createdAt: document.createdAt,
                updatedAt: document.updatedAt,
                url: `${originForRequest(request)}/?doc=${encodeURIComponent(document.id)}`,
                version: document.version,
                currentRevisionId: document.currentRevisionId,
                revisionId: document.currentRevisionId,
              })),
          })
        } catch (error) {
          sendDocumentReviewError(response, error, "Unable to list documents.")
        }
        return
      }

      const commentsMatch = /^\/api\/documents\/([^/]+)\/comments$/.exec(url.pathname)
      if (commentsMatch) {
        const documentId = decodeURIComponent(commentsMatch[1]!)
        try {
          const comments = await runDocumentReviewsPromise(
            DocumentReviews.Service.use((service) => service.listComments(documentId)),
          )
          sendJson(response, 200, { documentId, comments })
        } catch (error) {
          sendDocumentReviewError(response, error, "Unable to list comments.")
        }
        return
      }

      const feedbackMatch = /^\/api\/documents\/([^/]+)\/feedback$/.exec(url.pathname)
      if (feedbackMatch) {
        const documentId = decodeURIComponent(feedbackMatch[1]!)
        const waitSeconds = Math.min(Math.max(Number(url.searchParams.get("wait") ?? 0) || 0, 0), 300)
        const controller = new AbortController()
        const onClose = () => {
          if (!response.writableEnded) controller.abort()
        }
        response.once("close", onClose)
        try {
          const feedback = await runDocumentReviewsPromise(
            DocumentReviews.Service.use((service) => service.waitForFeedback(documentId, Duration.seconds(waitSeconds))),
            controller.signal,
          )
          if (!controller.signal.aborted) sendJson(response, 200, feedback)
        } catch (error) {
          if (!controller.signal.aborted) sendDocumentReviewError(response, error, "Unable to wait for feedback.")
        } finally {
          response.off("close", onClose)
        }
        return
      }

      const versionsMatch = /^\/api\/documents\/([^/]+)\/versions$/.exec(url.pathname)
      if (versionsMatch) {
        const documentId = decodeURIComponent(versionsMatch[1]!)
        try {
          const result = await runDocumentReviewsPromise(
            Effect.gen(function* () {
              const service = yield* DocumentReviews.Service
              const document = yield* service.getDocument(documentId)
              const revisions = yield* service.listRevisions(documentId)
              return { document, revisions }
            }),
          )
          sendJson(response, 200, {
            documentId,
            currentVersion: result.document.version,
            currentRevisionId: result.document.currentRevisionId,
            versions: result.revisions.map(revisionSummaryPayload),
          })
        } catch (error) {
          sendDocumentReviewError(response, error, "Unable to list document versions.")
        }
        return
      }

      const revisionMatch = /^\/api\/documents\/([^/]+)\/revisions\/([^/]+)$/.exec(url.pathname)
      if (revisionMatch) {
        const documentId = decodeURIComponent(revisionMatch[1]!)
        const revisionId = decodeURIComponent(revisionMatch[2]!)
        try {
          const document = await runDocumentReviewsPromise(
            DocumentReviews.Service.use((service) => service.getDocument(documentId, revisionId)),
          )
          sendJson(response, 200, revisionPayload(document.revision))
        } catch (error) {
          sendDocumentReviewError(response, error, "Revision not found.")
        }
        return
      }

      const diffMatch = /^\/api\/documents\/([^/]+)\/diff$/.exec(url.pathname)
      if (diffMatch) {
        const documentId = decodeURIComponent(diffMatch[1]!)
        const fromRevisionId = url.searchParams.get("from") ?? ""
        const toRevisionId = url.searchParams.get("to") ?? ""
        if (fromRevisionId === "" || toRevisionId === "") {
          sendJson(response, 400, { error: "Expected from and to revision ids." })
          return
        }
        try {
          const diff = await runDocumentReviewsPromise(
            DocumentReviews.Service.use((service) => service.diffRevisions(documentId, fromRevisionId, toRevisionId)),
          )
          sendJson(response, 200, { documentId, fromRevisionId, toRevisionId, ...diff })
        } catch (error) {
          sendDocumentReviewError(response, error, "Unable to diff document revisions.")
        }
        return
      }
    }

    if (method === "POST") {
      const feedbackAckMatch = /^\/api\/documents\/([^/]+)\/feedback\/ack$/.exec(url.pathname)
      if (feedbackAckMatch) {
        const documentId = decodeURIComponent(feedbackAckMatch[1]!)
        let body: string
        try {
          body = await readRequestBody(request)
        } catch (error) {
          if (!sendRequestBodyError(response, error)) sendJson(response, 400, { error: errorMessage(error, "Unable to read request body.") })
          return
        }
        const payload = decodeJsonPayload(FeedbackAcknowledgementInput, body)
        if (!payload || !Number.isFinite(payload.lastSeq)) {
          sendJson(response, 400, { error: "Expected a numeric lastSeq." })
          return
        }
        try {
          await runDocumentReviewsPromise(
            DocumentReviews.Service.use((service) => service.acknowledgeFeedback(documentId, payload.lastSeq)),
          )
          sendJson(response, 200, { documentId, lastSeq: payload.lastSeq })
        } catch (error) {
          sendDocumentReviewError(response, error, "Unable to acknowledge feedback.")
        }
        return
      }

      const commentsMatch = /^\/api\/documents\/([^/]+)\/comments$/.exec(url.pathname)
      if (commentsMatch) {
        const documentId = decodeURIComponent(commentsMatch[1]!)
        let body: string
        try {
          body = await readRequestBody(request)
        } catch (error) {
          if (!sendRequestBodyError(response, error)) sendJson(response, 400, { error: errorMessage(error, "Unable to read request body.") })
          return
        }
        const payload = decodeJsonPayload(CommentCreateInput, body)
        const content = payload?.content.trim() ?? ""
        if (!payload || content === "") {
          sendJson(response, 400, { error: "Expected comment content plus a valid location payload and optional anchor." })
          return
        }

        try {
          const comment = await runDocumentReviewsPromise(
            DocumentReviews.Service.use((service) =>
              service.addComment({
                documentId,
                content,
                location: {
                  ...payload.location,
                  contextBefore: payload.location.contextBefore ?? "",
                  contextAfter: payload.location.contextAfter ?? "",
                },
                ...(payload.anchor ? { anchor: payload.anchor } : {}),
              }),
            ),
          )
          sendJson(response, 201, { documentId, comment })
        } catch (error) {
          sendDocumentReviewError(response, error, "Unable to add comment.")
        }
        return
      }
    }

    if (method === "PATCH") {
      const match = /^\/api\/documents\/([^/]+)\/comments\/([^/]+)$/.exec(url.pathname)
      if (match) {
        const documentId = decodeURIComponent(match[1]!)
        const commentId = decodeURIComponent(match[2]!)
        let body: string
        try {
          body = await readRequestBody(request)
        } catch (error) {
          if (!sendRequestBodyError(response, error)) sendJson(response, 400, { error: errorMessage(error, "Unable to read request body.") })
          return
        }

        const payload = decodeJsonPayload(CommentUpdateInput, body)
        const status = payload?.status
        const content = payload?.content?.trim()
        const hasStatus = status === "open" || status === "resolved"
        const hasContent = content !== undefined && content !== ""
        if ((status !== undefined && !hasStatus) || (payload?.content !== undefined && !hasContent) || (!hasStatus && !hasContent)) {
          sendJson(response, 400, { error: "Expected a non-empty content value or status: 'open' or 'resolved'." })
          return
        }

        try {
          const comment = await runDocumentReviewsPromise(
            DocumentReviews.Service.use((service) =>
              service.updateComment({
                documentId,
                commentId,
                ...(hasContent ? { content } : {}),
                ...(hasStatus ? { status } : {}),
              }),
            ),
          )
          sendJson(response, 200, { documentId, comment })
        } catch (error) {
          sendDocumentReviewError(response, error, "Unable to update comment.")
        }
        return
      }
    }

    if (method === "DELETE") {
      const documentMatch = /^\/api\/documents\/([^/]+)$/.exec(url.pathname)
      if (documentMatch) {
        const documentId = decodeURIComponent(documentMatch[1]!)
        try {
          await runDocumentReviewsPromise(
            DocumentReviews.Service.use((service) => service.deleteDocument(documentId)),
          )
          sendJson(response, 200, { documentId, deleted: true })
        } catch (error) {
          sendDocumentReviewError(response, error, "Unable to delete document.")
        }
        return
      }

      const singleMatch = /^\/api\/documents\/([^/]+)\/comments\/([^/]+)$/.exec(url.pathname)
      if (singleMatch) {
        const documentId = decodeURIComponent(singleMatch[1]!)
        const commentId = decodeURIComponent(singleMatch[2]!)
        try {
          const comments = await runDocumentReviewsPromise(
            Effect.gen(function* () {
              const service = yield* DocumentReviews.Service
              yield* service.deleteComment(documentId, commentId)
              return yield* service.listComments(documentId)
            }),
          )
          sendJson(response, 200, { documentId, comments })
        } catch (error) {
          sendDocumentReviewError(response, error, "Unable to delete comment.")
        }
        return
      }

      const commentsMatch = /^\/api\/documents\/([^/]+)\/comments$/.exec(url.pathname)
      if (commentsMatch) {
        const documentId = decodeURIComponent(commentsMatch[1]!)
        try {
          await runDocumentReviewsPromise(
            DocumentReviews.Service.use((service) => service.clearComments(documentId)),
          )
          sendJson(response, 200, { documentId, comments: [] as ReadonlyArray<Comment> })
        } catch (error) {
          sendDocumentReviewError(response, error, "Unable to clear comments.")
        }
        return
      }
    }

    if (method === "GET") {
      const match = /^\/api\/documents\/([^/]+)$/.exec(url.pathname)
      if (!match) {
        sendJson(response, 404, { error: "Document not found." })
        return
      }

      const documentId = decodeURIComponent(match[1]!)
      try {
        const document = await runDocumentReviewsPromise(
          DocumentReviews.Service.use((service) => service.getDocument(documentId)),
        )
        sendJson(response, 200, toHostedDocument(document))
      } catch (error) {
        sendDocumentReviewError(response, error, "Document not found.")
      }
      return
    }

    sendJson(response, 405, { error: "Method not allowed." })
  }

  return {
    middleware,
    dispose: async () => {
      for (const client of eventClients) {
        try {
          client.end()
        } catch {
          // noop
        }
      }
      eventClients.clear()
      await runtime.dispose()
    },
  }
}

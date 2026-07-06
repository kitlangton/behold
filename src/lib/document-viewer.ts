import { Cache, Context, Duration, Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import type { PublishedDocumentManifest, PublishedDocumentSnapshot } from "./published"
import {
  DocumentDeleteResultSchema,
  DocumentListSchema as RecentDocumentListResultSchema,
  DocumentMutationSchema as HostedDocumentCreateResultSchema,
  DocumentVersionsSchema as DocumentRevisionListResultSchema,
  HostedDocumentSchema,
  PublicationReceiptSchema,
  RevisionDiffSchema as DocumentRevisionDiffSchema,
  type PublicationReceipt,
} from "../../shared/document-contracts"

export type { PublishedDocumentSnapshot } from "./published"
export type { PublicationReceipt } from "../../shared/document-contracts"

export interface RenderedMarkdownSection {
  readonly _tag: "markdown"
  readonly markdown: string
}

export type RenderedDocumentSection = RenderedMarkdownSection

export interface RenderedDocument {
  readonly sections: ReadonlyArray<RenderedDocumentSection>
}

export interface HostedDocument {
  readonly id: string
  readonly title: string
  readonly markdown: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly sourcePath?: string
  readonly version: number
  readonly currentRevisionId: string
  readonly revisionId: string
  readonly publication?: PublicationReceipt
}

export interface HostedDocumentCreateResult {
  readonly id: string
  readonly postUrl: string
  readonly documentUrl: string
  readonly url: string
  readonly sourcePath?: string
  readonly updated: boolean
  readonly unchanged: boolean
  readonly message: string
  readonly version: number
  readonly currentRevisionId: string
  readonly revisionId: string
  readonly publication?: PublicationReceipt
}

export interface DocumentCommentAnchorSource {
  readonly startUtf16: number
  readonly endUtf16: number
  readonly startLine: number
  readonly endLine: number
}

export interface DocumentCommentAnchor {
  readonly revisionId: string
  readonly plane: "rendered-text-v1"
  readonly range: { readonly start: number; readonly end: number }
  readonly quote: { readonly exact: string; readonly prefix: string; readonly suffix: string }
  readonly source?: DocumentCommentAnchorSource
}

export interface DocumentCommentLocation {
  readonly sectionIndex: number
  readonly sectionType: "markdown" | "code-reference"
  readonly selectedText: string
  readonly contextBefore: string
  readonly contextAfter: string
  readonly sectionTitle?: string
  readonly displayPath?: string
  readonly focusStartLine?: number
  readonly focusEndLine?: number
}

export interface DocumentComment {
  readonly id: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly content: string
  readonly status: "open" | "resolved"
  readonly resolvedAt?: string
  readonly location: DocumentCommentLocation
  readonly seq: number
  readonly anchor?: DocumentCommentAnchor
}

export interface DocumentCommentListResult {
  readonly documentId: string
  readonly comments: ReadonlyArray<DocumentComment>
}

export interface DocumentCommentMutationResult {
  readonly documentId: string
  readonly comment: DocumentComment
}

export interface DocumentCommentDeleteResult {
  readonly documentId: string
  readonly comments: ReadonlyArray<DocumentComment>
}

export interface RecentDocument {
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly url: string
  readonly version: number
  readonly currentRevisionId: string
  readonly publication?: PublicationReceipt
}

export interface DocumentRevision {
  readonly id: string
  readonly revisionId: string
  readonly version: number
  readonly title: string
  readonly createdAt: string
  readonly parentRevisionId?: string
}

export interface DocumentRevisionDetail extends DocumentRevision {
  readonly markdown: string
  readonly contentHash: string
}

export interface DocumentRevisionListResult {
  readonly documentId: string
  readonly currentVersion: number
  readonly currentRevisionId: string
  readonly versions: ReadonlyArray<DocumentRevision>
}

export interface DocumentRevisionDiff {
  readonly documentId: string
  readonly fromRevisionId: string
  readonly toRevisionId: string
  readonly patch: string
  readonly additions: number
  readonly deletions: number
}

export interface RecentDocumentListResult {
  readonly documents: ReadonlyArray<RecentDocument>
}

export interface PublishedDocumentListResult extends PublishedDocumentManifest {}

export interface PublishRemoteResult {
  readonly slug: string
  readonly url: string
  readonly updated: boolean
  readonly publication?: PublicationReceipt
}

export interface UnpublishRemoteResult {
  readonly documentId: string
  readonly slug: string
  readonly deleted: boolean
  readonly cleared: boolean
}

export type RemoteMarkdownLoadResult =
  | {
      readonly ok: true
      readonly markdown: string
      readonly sourceUrl: string
    }
  | {
      readonly ok: false
      readonly message: string
    }

interface NormalizedRemoteUrl {
  readonly ok: true
  readonly url: string
  readonly openUrl: string
  readonly displayPath: string
}

interface InvalidRemoteUrl {
  readonly ok: false
  readonly message: string
}

const OptionalString = Schema.optionalKey(Schema.String)
const OptionalNumber = Schema.optionalKey(Schema.Number)

const RenderedMarkdownSectionSchema = Schema.Struct({
  _tag: Schema.Literal("markdown"),
  markdown: Schema.String,
})

const LegacyCodeReferenceSectionSchema = Schema.Struct({
  _tag: Schema.Literal("code-reference"),
})

const IncomingRenderedDocumentSectionSchema = Schema.Union([RenderedMarkdownSectionSchema, LegacyCodeReferenceSectionSchema])

const IncomingRenderedDocumentSchema = Schema.Struct({
  sections: Schema.Array(IncomingRenderedDocumentSectionSchema),
  codeReferenceCount: OptionalNumber,
  loadedReferenceCount: OptionalNumber,
  failedReferenceCount: OptionalNumber,
})

const DocumentCommentAnchorSourceSchema = Schema.Struct({
  startUtf16: Schema.Number,
  endUtf16: Schema.Number,
  startLine: Schema.Number,
  endLine: Schema.Number,
})

const DocumentCommentAnchorSchema = Schema.Struct({
  revisionId: Schema.String,
  plane: Schema.Literal("rendered-text-v1"),
  range: Schema.Struct({ start: Schema.Number, end: Schema.Number }),
  quote: Schema.Struct({ exact: Schema.String, prefix: Schema.String, suffix: Schema.String }),
  source: Schema.optionalKey(DocumentCommentAnchorSourceSchema),
})

const DocumentCommentLocationSchema = Schema.Struct({
  sectionIndex: Schema.Number,
  sectionType: Schema.Literals(["markdown", "code-reference"]),
  selectedText: Schema.String,
  contextBefore: Schema.String,
  contextAfter: Schema.String,
  sectionTitle: OptionalString,
  displayPath: OptionalString,
  focusStartLine: OptionalNumber,
  focusEndLine: OptionalNumber,
})

const DocumentCommentSchema = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  content: Schema.String,
  status: Schema.Literals(["open", "resolved"]),
  resolvedAt: OptionalString,
  location: DocumentCommentLocationSchema,
  seq: Schema.Number,
  anchor: Schema.optionalKey(DocumentCommentAnchorSchema),
})

const DocumentCommentListResultSchema = Schema.Struct({
  documentId: Schema.String,
  comments: Schema.Array(DocumentCommentSchema),
})

const DocumentCommentMutationResultSchema = Schema.Struct({
  documentId: Schema.String,
  comment: DocumentCommentSchema,
})

const DocumentCommentDeleteResultSchema = Schema.Struct({
  documentId: Schema.String,
  comments: Schema.Array(DocumentCommentSchema),
})

const DocumentRevisionDetailSchema = Schema.Struct({
  id: Schema.String,
  revisionId: Schema.String,
  version: Schema.Number,
  title: Schema.String,
  markdown: Schema.String,
  contentHash: Schema.String,
  createdAt: Schema.String,
  parentRevisionId: OptionalString,
})

const PublishedDocumentManifestEntrySchema = Schema.Struct({
  slug: Schema.String,
  title: Schema.String,
  exportedAt: Schema.String,
  sourceDocumentId: OptionalString,
  url: Schema.String,
})

const PublishedDocumentListResultSchema = Schema.Struct({ documents: Schema.Array(PublishedDocumentManifestEntrySchema) })

const PublishedDocumentSnapshotSchema = Schema.Struct({
  slug: Schema.String,
  title: Schema.String,
  markdown: Schema.String,
  exportedAt: Schema.String,
  sourceDocumentId: OptionalString,
  sourcePath: OptionalString,
  document: IncomingRenderedDocumentSchema,
})

const PublishRemoteResultSchema = Schema.Struct({
  slug: Schema.String,
  url: Schema.String,
  updated: Schema.Boolean,
  publication: Schema.optionalKey(PublicationReceiptSchema),
})

const UnpublishRemoteResultSchema = Schema.Struct({
  documentId: Schema.String,
  slug: Schema.String,
  deleted: Schema.Boolean,
  cleared: Schema.Boolean,
})

type IncomingRenderedDocumentSection = RenderedMarkdownSection | { readonly _tag: "code-reference" }

interface IncomingRenderedDocument {
  readonly sections: ReadonlyArray<IncomingRenderedDocumentSection>
}

const materializeRenderedDocument = (document: IncomingRenderedDocument): RenderedDocument => ({
  sections: document.sections.filter((section): section is RenderedMarkdownSection => section._tag === "markdown"),
})

const materializePublishedSnapshot = (snapshot: Schema.Schema.Type<typeof PublishedDocumentSnapshotSchema>): PublishedDocumentSnapshot => ({
  ...snapshot,
  sourcePath: undefined,
  document: materializeRenderedDocument(snapshot.document),
})

const encodeGithubPath = (value: string): string => {
  const encoded: string[] = []
  for (const part of value.split("/")) {
    if (part.length > 0) encoded.push(encodeURIComponent(part))
  }
  return encoded.join("/")
}

export const normalizeRemoteTextUrl = (input: string): NormalizedRemoteUrl | InvalidRemoteUrl => {
  const trimmed = input.trim()
  if (trimmed === "") return { ok: false, message: "Missing remote URL." }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, message: `Invalid URL "${input}".` }
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: `Unsupported URL protocol "${url.protocol}".` }
  }

  const openUrl = url.toString()
  url.hash = ""

  if (url.hostname === "github.com") {
    const match = /^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/.exec(url.pathname)
    if (!match) {
      return { ok: false, message: "GitHub URLs must point at a blob path like owner/repo/blob/ref/file.md." }
    }

    const [, owner, repo, ref, file] = match
    return {
      ok: true,
      url: `https://raw.githubusercontent.com/${owner}/${repo}/${encodeGithubPath(ref)}/${encodeGithubPath(file)}`,
      openUrl,
      displayPath: `${owner}/${repo}/${file}`,
    }
  }

  if (url.hostname === "raw.githubusercontent.com") {
    const parts = url.pathname.split("/").filter((part) => part.length > 0)
    const displayPath = parts.length >= 4 ? `${parts[0]}/${parts[1]}/${parts.slice(3).join("/")}` : url.pathname.slice(1)
    return {
      ok: true,
      url: url.toString(),
      openUrl,
      displayPath,
    }
  }

  return {
    ok: true,
    url: url.toString(),
    openUrl,
    displayPath: url.pathname.slice(1) || url.hostname,
  }
}

type BoundaryErrorKind = "http-status" | "http-transport" | "schema" | "unknown"

export class DocumentViewerBoundaryError extends Error {
  readonly _tag = "DocumentViewerBoundaryError"
  constructor(
    readonly kind: BoundaryErrorKind,
    message: string,
    readonly evidence?: { readonly status?: number; readonly url?: string; readonly cause?: unknown },
  ) {
    super(message)
  }
}

const remoteTextCacheCapacity = 128
const remoteTextCacheTtl = Duration.minutes(5)

export const shouldCacheTextForDocumentViewer = (_url: string): boolean => true

export const makeDocumentViewerTextCache = <E = never, R = never, ServiceMode extends "lookup" | "construction" = never>(
  lookup: (url: string) => Effect.Effect<string, E, R>,
  options?: {
    readonly capacity?: number
    readonly timeToLive?: Duration.Input
    readonly requireServicesAt?: ServiceMode
  },
) =>
  Cache.make<string, string, E, R, ServiceMode>({
    capacity: options?.capacity ?? remoteTextCacheCapacity,
    timeToLive: options?.timeToLive ?? remoteTextCacheTtl,
    requireServicesAt: options?.requireServicesAt,
    lookup,
  })

class RemoteTextCache extends Context.Service<RemoteTextCache, Cache.Cache<string, string, DocumentViewerBoundaryError, HttpClient.HttpClient>>()(
  "DocumentViewer.RemoteTextCache",
) {}

const RemoteTextCacheLive = Layer.effect(
  RemoteTextCache,
  makeDocumentViewerTextCache<DocumentViewerBoundaryError, HttpClient.HttpClient, "lookup">(
    Effect.fn("DocumentViewer.remoteTextCache.lookup")((url: string) => requestText(HttpClientRequest.get(url))),
    {
      capacity: remoteTextCacheCapacity,
      timeToLive: remoteTextCacheTtl,
      requireServicesAt: "lookup",
    },
  ),
)

export const documentViewerRuntime = ManagedRuntime.make(Layer.merge(FetchHttpClient.layer, RemoteTextCacheLive))

type DocumentViewerRuntimeServices = ManagedRuntime.ManagedRuntime.Services<typeof documentViewerRuntime>

export const runDocumentViewerPromise = <A, E>(
  effect: Effect.Effect<A, E, DocumentViewerRuntimeServices>,
  signal?: AbortSignal,
) => documentViewerRuntime.runPromise(effect, { signal })

const hot = (import.meta as ImportMeta & { readonly hot?: { readonly dispose: (callback: () => void) => void } }).hot
if (hot) {
  hot.dispose(() => {
    void documentViewerRuntime.dispose()
  })
}

const toErrorMessage = (error: unknown): string => {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  return "Request failed."
}

const toBoundaryError = (error: unknown, fallback = "Request failed."): DocumentViewerBoundaryError => {
  if (error instanceof DocumentViewerBoundaryError) return error
  if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "SchemaError") {
    return new DocumentViewerBoundaryError("schema", fallback, { cause: error })
  }
  return new DocumentViewerBoundaryError("http-transport", toErrorMessage(error) || fallback, { cause: error })
}

const boundaryErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof DocumentViewerBoundaryError ? error.message || fallback : toErrorMessage(error) || fallback

const relabelBoundaryError = (error: unknown, fallback: string): DocumentViewerBoundaryError => {
  const boundaryError = toBoundaryError(error, fallback)
  if (boundaryError.message === fallback) return boundaryError
  return new DocumentViewerBoundaryError(boundaryError.kind, `${fallback} ${boundaryError.message}`, {
    ...boundaryError.evidence,
    cause: boundaryError,
  })
}

const shouldTryPublishedStaticFallback = (error: unknown): boolean => {
  if (!(error instanceof DocumentViewerBoundaryError)) return false
  if (error.kind === "http-transport") return true
  return error.kind === "http-status" && (error.evidence?.status === 404 || error.evidence?.status === 405)
}

const ErrorResponseSchema = Schema.Struct({ error: Schema.String })

const readErrorMessage = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.match({
      onFailure: () => `Request failed with ${response.status}`,
      onSuccess: (text) => {
        const trimmed = text.trim()
        if (trimmed === "") return `Request failed with ${response.status}`

        try {
          const decoded = Schema.decodeUnknownOption(ErrorResponseSchema)(JSON.parse(trimmed))
          if (Option.isSome(decoded)) return decoded.value.error || `Request failed with ${response.status}`
        } catch {
          // Fall back to the response text below.
        }

        return trimmed
      },
    }),
  )

const requestText: (
  request: HttpClientRequest.HttpClientRequest,
  options?: { readonly cacheControl?: string },
) => Effect.Effect<string, DocumentViewerBoundaryError, HttpClient.HttpClient> = Effect.fn("DocumentViewer.requestText")(function* (
  request: HttpClientRequest.HttpClientRequest,
  options?: { readonly cacheControl?: string },
) {
  const prepared = options?.cacheControl ? request.pipe(HttpClientRequest.setHeader("cache-control", options.cacheControl)) : request
  const response = yield* prepared.pipe(HttpClient.execute).pipe(Effect.mapError((error) => toBoundaryError(error, "Unable to connect.")))
  if (response.status < 200 || response.status >= 300) {
    const message = yield* readErrorMessage(response).pipe(
      Effect.match({
        onFailure: () => `Request failed with ${response.status}`,
        onSuccess: (message) => message,
      }),
    )
    yield* Effect.fail(new DocumentViewerBoundaryError("http-status", message, { status: response.status, url: prepared.url }))
  }
  return yield* response.text.pipe(Effect.mapError((error) => toBoundaryError(error, "Unable to read response text.")))
})

const requestJson = <S extends Schema.Constraint>(
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
): Effect.Effect<S["Type"], DocumentViewerBoundaryError, HttpClient.HttpClient | S["DecodingServices"]> => Effect.fn("DocumentViewer.requestJson")(function* () {
  const response = yield* request.pipe(HttpClient.execute).pipe(Effect.mapError((error) => toBoundaryError(error, "Unable to connect.")))
  if (response.status < 200 || response.status >= 300) {
    const message = yield* readErrorMessage(response)
    yield* Effect.fail(new DocumentViewerBoundaryError("http-status", message, { status: response.status, url: request.url }))
  }
  return yield* response.pipe(HttpClientResponse.schemaBodyJson(schema)).pipe(
    Effect.mapError((error) => toBoundaryError(error, "Response did not match the expected shape.")),
  )
})()

export const sampleMarkdown = `# Show And Tell

Paste markdown, drag in a .md file, or point the viewer at a public markdown URL.

\`\`\`text
+-------------+       +----------------+
| Markdown    | ----> | Published page |
+-------------+       +----------------+
\`\`\`
`

const fetchRemoteText = (url: string) =>
  RemoteTextCache.pipe(
    Effect.flatMap((cache) => Cache.get(cache, url)),
    Effect.mapError((error) => boundaryErrorMessage(error, "Unable to load remote text.")),
  )

const localMutation = HttpClientRequest.setHeader("X-Behold-Request", "1")

export const parseDocument = (markdown: string): ReadonlyArray<RenderedMarkdownSection> => {
  const normalized = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  return normalized.trim() === "" ? [] : [{ _tag: "markdown", markdown: normalized }]
}

export const loadDocument = Effect.fn("DocumentViewer.loadDocument")(function* (markdown: string) {
  return { sections: parseDocument(markdown) } satisfies RenderedDocument
})

export const loadRemoteMarkdown = Effect.fn("DocumentViewer.loadRemoteMarkdown")(function* (input: string) {
  const normalized = normalizeRemoteTextUrl(input)
  if (normalized.ok === false) return { ok: false, message: normalized.message } satisfies RemoteMarkdownLoadResult

  return yield* fetchRemoteText(normalized.url).pipe(
    Effect.match({
      onFailure: (message) => ({ ok: false, message } satisfies RemoteMarkdownLoadResult),
      onSuccess: (markdown) => ({
        ok: true,
        markdown,
        sourceUrl: normalized.openUrl,
      } satisfies RemoteMarkdownLoadResult),
    }),
  )
})

export const loadHostedDocument = Effect.fn("DocumentViewer.loadHostedDocument")(function* (id: string) {
  return yield* requestJson(HttpClientRequest.get(`/api/documents/${encodeURIComponent(id)}`), HostedDocumentSchema).pipe(
    Effect.mapError((error) => relabelBoundaryError(error, "Unable to load hosted document.")),
  )
})

export const createHostedDocument = Effect.fn("DocumentViewer.createHostedDocument")(function* (markdown: string) {
  return yield* requestJson(
    HttpClientRequest.post("/api/documents").pipe(localMutation, HttpClientRequest.bodyText(markdown, "text/markdown")),
    HostedDocumentCreateResultSchema,
  ).pipe(Effect.mapError((error) => relabelBoundaryError(error, "Unable to create hosted document.")))
})

export const createHostedDocumentFromPath = Effect.fn("DocumentViewer.createHostedDocumentFromPath")(function* (filePath: string) {
  return yield* requestJson(
    HttpClientRequest.post("/api/documents").pipe(localMutation, HttpClientRequest.bodyJsonUnsafe({ filePath })),
    HostedDocumentCreateResultSchema,
  ).pipe(Effect.mapError((error) => relabelBoundaryError(error, "Unable to create hosted document from file path.")))
})

export const loadDocumentComments = Effect.fn("DocumentViewer.loadDocumentComments")(function* (documentId: string) {
  return yield* requestJson(
    HttpClientRequest.get(`/api/documents/${encodeURIComponent(documentId)}/comments`),
    DocumentCommentListResultSchema,
  ).pipe(Effect.mapError((error) => relabelBoundaryError(error, "Unable to load document comments.")))
})

export const createDocumentComment = Effect.fn("DocumentViewer.createDocumentComment")(function* (
  documentId: string,
  content: string,
  location: DocumentCommentLocation,
  anchor?: DocumentCommentAnchor,
) {
  return yield* requestJson(
    HttpClientRequest.post(`/api/documents/${encodeURIComponent(documentId)}/comments`).pipe(
      localMutation,
      HttpClientRequest.bodyJsonUnsafe({ content, location, anchor }),
    ),
    DocumentCommentMutationResultSchema,
  ).pipe(Effect.mapError((error) => relabelBoundaryError(error, "Unable to create document comment.")))
})

export const updateDocumentCommentStatus = Effect.fn("DocumentViewer.updateDocumentCommentStatus")(function* (
  documentId: string,
  commentId: string,
  status: DocumentComment["status"],
) {
  return yield* requestJson(
    HttpClientRequest.patch(`/api/documents/${encodeURIComponent(documentId)}/comments/${encodeURIComponent(commentId)}`).pipe(
      localMutation,
      HttpClientRequest.bodyJsonUnsafe({ status }),
    ),
    DocumentCommentMutationResultSchema,
  ).pipe(Effect.mapError((error) => relabelBoundaryError(error, "Unable to update comment status.")))
})

export const updateDocumentCommentContent = Effect.fn("DocumentViewer.updateDocumentCommentContent")(function* (
  documentId: string,
  commentId: string,
  content: string,
) {
  return yield* requestJson(
    HttpClientRequest.patch(`/api/documents/${encodeURIComponent(documentId)}/comments/${encodeURIComponent(commentId)}`).pipe(
      localMutation,
      HttpClientRequest.bodyJsonUnsafe({ content }),
    ),
    DocumentCommentMutationResultSchema,
  ).pipe(Effect.mapError((error) => relabelBoundaryError(error, "Unable to update comment content.")))
})

export const deleteDocumentComment = Effect.fn("DocumentViewer.deleteDocumentComment")(function* (
  documentId: string,
  commentId: string,
) {
  return yield* requestJson(
    HttpClientRequest.delete(`/api/documents/${encodeURIComponent(documentId)}/comments/${encodeURIComponent(commentId)}`).pipe(localMutation),
    DocumentCommentDeleteResultSchema,
  ).pipe(Effect.mapError((error) => relabelBoundaryError(error, "Unable to delete comment.")))
})

export const clearDocumentComments = Effect.fn("DocumentViewer.clearDocumentComments")(function* (documentId: string) {
  return yield* requestJson(
    HttpClientRequest.delete(`/api/documents/${encodeURIComponent(documentId)}/comments`).pipe(localMutation),
    DocumentCommentListResultSchema,
  ).pipe(Effect.mapError((error) => relabelBoundaryError(error, "Unable to clear document comments.")))
})

export const loadRecentDocuments = Effect.fn("DocumentViewer.loadRecentDocuments")(function* () {
  return yield* requestJson(HttpClientRequest.get("/api/documents"), RecentDocumentListResultSchema).pipe(
    Effect.mapError((error) => relabelBoundaryError(error, "Unable to load recent documents.")),
  )
})

export const loadDocumentRevisions = Effect.fn("DocumentViewer.loadDocumentRevisions")(function* (documentId: string) {
  return yield* requestJson(
    HttpClientRequest.get(`/api/documents/${encodeURIComponent(documentId)}/versions`),
    DocumentRevisionListResultSchema,
  ).pipe(Effect.mapError((error) => relabelBoundaryError(error, "Unable to load document revisions.")))
})

export const loadDocumentRevision = Effect.fn("DocumentViewer.loadDocumentRevision")(function* (
  documentId: string,
  revisionId: string,
) {
  return yield* requestJson(
    HttpClientRequest.get(`/api/documents/${encodeURIComponent(documentId)}/revisions/${encodeURIComponent(revisionId)}`),
    DocumentRevisionDetailSchema,
  ).pipe(Effect.mapError((error) => relabelBoundaryError(error, "Unable to load document revision.")))
})

export const diffDocumentRevisions = Effect.fn("DocumentViewer.diffDocumentRevisions")(function* (
  documentId: string,
  fromRevisionId: string,
  toRevisionId: string,
) {
  return yield* requestJson(
    HttpClientRequest.get(
      `/api/documents/${encodeURIComponent(documentId)}/diff?from=${encodeURIComponent(fromRevisionId)}&to=${encodeURIComponent(toRevisionId)}`,
    ),
    DocumentRevisionDiffSchema,
  ).pipe(Effect.mapError((error) => relabelBoundaryError(error, "Unable to diff document revisions.")))
})

export const deleteHostedDocument = Effect.fn("DocumentViewer.deleteHostedDocument")(function* (documentId: string) {
  return yield* requestJson(
    HttpClientRequest.delete(`/api/documents/${encodeURIComponent(documentId)}`).pipe(localMutation),
    DocumentDeleteResultSchema,
  ).pipe(Effect.mapError((error) => relabelBoundaryError(error, "Unable to delete hosted document.")))
})

export const loadPublishedDocumentSnapshot = Effect.fn("DocumentViewer.loadPublishedDocumentSnapshot")(function* (slug: string) {
  return yield* requestJson(
    HttpClientRequest.get(`/api/published-documents?slug=${encodeURIComponent(slug)}`),
    PublishedDocumentSnapshotSchema,
  ).pipe(
    Effect.catchIf(
      shouldTryPublishedStaticFallback,
      () => requestJson(HttpClientRequest.get(`/published/${encodeURIComponent(slug)}.json`), PublishedDocumentSnapshotSchema),
    ),
    Effect.map(materializePublishedSnapshot),
    Effect.mapError((error) => relabelBoundaryError(error, "Unable to load published document snapshot.")),
  )
})

export const decodePublishedDocumentSnapshot = (input: unknown) =>
  Schema.decodeUnknownEffect(PublishedDocumentSnapshotSchema)(input).pipe(
    Effect.map(materializePublishedSnapshot),
    Effect.mapError((error) => toBoundaryError(error, "Response did not match the expected shape.")),
  )

export const loadPublishedDocuments = Effect.fn("DocumentViewer.loadPublishedDocuments")(function* () {
  return yield* requestJson(HttpClientRequest.get("/api/published-documents"), PublishedDocumentListResultSchema).pipe(
    Effect.catchIf(
      shouldTryPublishedStaticFallback,
      () => requestJson(HttpClientRequest.get("/published/index.json"), PublishedDocumentListResultSchema),
    ),
    Effect.mapError((error) => relabelBoundaryError(error, "Unable to load published documents.")),
  )
})

export const publishDocumentSnapshot = Effect.fn("DocumentViewer.publishDocumentSnapshot")(function* (
  snapshot: PublishedDocumentSnapshot,
  hosted?: { readonly documentId: string; readonly revisionId: string },
) {
  const body = hosted ? { ...hosted, snapshot } : snapshot
  return yield* requestJson(
    HttpClientRequest.post("/api/publish-remote").pipe(
      HttpClientRequest.setHeader("X-Behold-Request", "1"),
      HttpClientRequest.bodyJsonUnsafe(body),
    ),
    PublishRemoteResultSchema,
  ).pipe(Effect.mapError((error) => relabelBoundaryError(error, "Unable to publish document snapshot.")))
})

export const unpublishHostedDocument = Effect.fn("DocumentViewer.unpublishHostedDocument")(function* (documentId: string) {
  return yield* requestJson(
    HttpClientRequest.delete("/api/publish-remote").pipe(
      HttpClientRequest.setHeader("X-Behold-Request", "1"),
      HttpClientRequest.bodyJsonUnsafe({ documentId }),
    ),
    UnpublishRemoteResultSchema,
  ).pipe(Effect.mapError((error) => relabelBoundaryError(error, "Unable to unpublish document snapshot.")))
})

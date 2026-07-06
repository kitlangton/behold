import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { Config, Context, Effect, Layer, Logger, Schema } from "effect"
import * as McpServer from "effect/unstable/ai/McpServer"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ensureViewer } from "./behold-lifecycle"
import { Comment as ReviewComment } from "./document-reviews"
import {
  DocumentDeleteResultSchema as DeleteResult,
  DocumentListSchema as DocumentList,
  DocumentMutationSchema as DocumentMutation,
  DocumentVersionsSchema as DocumentVersions,
  HostedDocumentSchema as HostedDocument,
  RevisionDiffSchema as RevisionDiff,
} from "../shared/document-contracts"

const OptionalString = Schema.optionalKey(Schema.String)

const Feedback = Schema.Struct({
  documentId: Schema.String,
  comments: Schema.Array(ReviewComment),
  lastSeq: Schema.Number,
  timedOut: Schema.Boolean,
})

const FeedbackAcknowledgement = Schema.Struct({
  documentId: Schema.String,
  lastSeq: Schema.Number,
})

const CommentMutation = Schema.Struct({
  documentId: Schema.String,
  comment: ReviewComment,
})

class McpToolError extends Schema.TaggedErrorClass<McpToolError>()("Behold.McpToolError", {
  operation: Schema.String,
  message: Schema.String,
  status: Schema.optionalKey(Schema.Number),
}) {}

class ViewerStartupError extends Schema.TaggedErrorClass<ViewerStartupError>()("Behold.ViewerStartupError", {
  message: Schema.String,
}) {}

interface ViewerInterface {
  readonly origin: string
  readonly requestOrigin: string
}

class Viewer extends Context.Service<Viewer, ViewerInterface>()("Behold.Viewer") {}

const viewerLayer = Layer.effect(
  Viewer,
  Effect.gen(function* () {
    const configuredOrigin = yield* Config.string("BEHOLD_ORIGIN").pipe(
      Config.orElse(() => Config.string("SHOW_AND_TELL_ORIGIN")),
      Config.withDefault("http://behold.localhost:5173"),
    )
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
    const viewer = yield* Effect.tryPromise({
      try: () => ensureViewer({ root, origin: configuredOrigin }),
      catch: (cause) => new ViewerStartupError({
        message: cause instanceof Error ? cause.message : "Unable to start the Behold viewer.",
      }),
    })
    return Viewer.of({ origin: viewer.origin, requestOrigin: viewer.requestOrigin })
  }),
)

interface DocumentApiInterface {
  readonly host: (input: { readonly markdown?: string; readonly filePath?: string }) => Effect.Effect<typeof DocumentMutation.Type, McpToolError>
  readonly update: (id: string, markdown: string) => Effect.Effect<typeof DocumentMutation.Type, McpToolError>
  readonly get: (id: string) => Effect.Effect<typeof HostedDocument.Type, McpToolError>
  readonly list: () => Effect.Effect<typeof DocumentList.Type, McpToolError>
  readonly versions: (id: string) => Effect.Effect<typeof DocumentVersions.Type, McpToolError>
  readonly diffVersions: (id: string, fromRevisionId: string, toRevisionId: string) => Effect.Effect<typeof RevisionDiff.Type, McpToolError>
  readonly feedback: (id: string, timeoutSeconds: number) => Effect.Effect<typeof Feedback.Type, McpToolError>
  readonly setCommentStatus: (documentId: string, commentId: string, status: "open" | "resolved") => Effect.Effect<typeof CommentMutation.Type, McpToolError>
  readonly remove: (id: string) => Effect.Effect<typeof DeleteResult.Type, McpToolError>
  readonly guide: () => Effect.Effect<string, McpToolError>
}

class DocumentApi extends Context.Service<DocumentApi, DocumentApiInterface>()("Behold.DocumentApi") {}

const documentApiLayer = Layer.effect(
  DocumentApi,
  Effect.gen(function* () {
    const viewer = yield* Viewer
    const origin = viewer.requestOrigin
    const publicUrl = new URL(viewer.origin)
    const withPublicOrigin = (request: HttpClientRequest.HttpClientRequest) =>
      request.pipe(
        HttpClientRequest.setHeaders({
          "x-forwarded-host": publicUrl.host,
          "x-forwarded-proto": publicUrl.protocol.slice(0, -1),
        }),
      )
    const client = yield* HttpClient.HttpClient

    const requestJson = Effect.fn("Behold.DocumentApi.requestJson")(function* <S extends Schema.Constraint>(
      operation: string,
      request: HttpClientRequest.HttpClientRequest,
      schema: S,
    ) {
      const response = yield* request.pipe(
        withPublicOrigin,
        client.execute,
        Effect.mapError((error) => new McpToolError({ operation, message: String(error) })),
      )
      if (response.status < 200 || response.status >= 300) {
        const message = yield* response.text.pipe(
          Effect.map((text) => {
            try {
              const payload = JSON.parse(text) as { error?: unknown }
              return typeof payload.error === "string" ? payload.error : text
            } catch {
              return text
            }
          }),
          Effect.catch(() => Effect.succeed(`Request failed with ${response.status}.`)),
        )
        return yield* new McpToolError({ operation, message, status: response.status })
      }
      return yield* response.pipe(
        HttpClientResponse.schemaBodyJson(schema),
        Effect.mapError((error) => new McpToolError({ operation, message: `Invalid server response: ${String(error)}` })),
      )
    })

    const requestText = Effect.fn("Behold.DocumentApi.requestText")(function* (operation: string, path: string) {
      const response = yield* HttpClientRequest.get(`${origin}${path}`).pipe(
        withPublicOrigin,
        client.execute,
        Effect.mapError((error) => new McpToolError({ operation, message: String(error) })),
      )
      if (response.status < 200 || response.status >= 300) {
        return yield* new McpToolError({ operation, message: `Request failed with ${response.status}.`, status: response.status })
      }
      return yield* response.text.pipe(
        Effect.mapError((error) => new McpToolError({ operation, message: String(error) })),
      )
    })

    return DocumentApi.of({
      host: (input) =>
        requestJson(
          "host_document",
          HttpClientRequest.post(`${origin}/api/documents`).pipe(HttpClientRequest.bodyJsonUnsafe(input)),
          DocumentMutation,
        ),
      update: (id, markdown) =>
        requestJson(
          "update_document",
          HttpClientRequest.put(`${origin}/api/documents/${encodeURIComponent(id)}`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ markdown }),
          ),
          DocumentMutation,
        ),
      get: (id) => requestJson("get_document", HttpClientRequest.get(`${origin}/api/documents/${encodeURIComponent(id)}`), HostedDocument),
      list: () => requestJson("list_documents", HttpClientRequest.get(`${origin}/api/documents`), DocumentList),
      versions: (id) =>
        requestJson(
          "list_document_versions",
          HttpClientRequest.get(`${origin}/api/documents/${encodeURIComponent(id)}/versions`),
          DocumentVersions,
        ),
      diffVersions: (id, fromRevisionId, toRevisionId) =>
        requestJson(
          "diff_document_versions",
          HttpClientRequest.get(
            `${origin}/api/documents/${encodeURIComponent(id)}/diff?from=${encodeURIComponent(fromRevisionId)}&to=${encodeURIComponent(toRevisionId)}`,
          ),
          RevisionDiff,
        ),
      feedback: (id, timeoutSeconds) => Effect.gen(function* () {
        const feedback = yield* requestJson(
          "wait_for_feedback",
          HttpClientRequest.get(`${origin}/api/documents/${encodeURIComponent(id)}/feedback?wait=${timeoutSeconds}`),
          Feedback,
        )
        if (feedback.comments.length > 0) {
          yield* requestJson(
            "wait_for_feedback.acknowledge",
            HttpClientRequest.post(`${origin}/api/documents/${encodeURIComponent(id)}/feedback/ack`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ lastSeq: feedback.lastSeq }),
            ),
            FeedbackAcknowledgement,
          )
        }
        return feedback
      }),
      setCommentStatus: (documentId, commentId, status) =>
        requestJson(
          "set_comment_status",
          HttpClientRequest.patch(
            `${origin}/api/documents/${encodeURIComponent(documentId)}/comments/${encodeURIComponent(commentId)}`,
          ).pipe(HttpClientRequest.bodyJsonUnsafe({ status })),
          CommentMutation,
        ),
      remove: (id) =>
        requestJson("delete_document", HttpClientRequest.delete(`${origin}/api/documents/${encodeURIComponent(id)}`), DeleteResult),
      guide: () => requestText("get_agent_guide", "/agent-howto"),
    })
  }),
)

const HostDocument = Tool.make("host_document", {
  description:
    "Host a Markdown document in the local Behold viewer. Pass exactly one of markdown or absolute filePath. Reposting the same filePath updates the existing document. Use semantic fences such as tree, diff, shell, http, and mermaid when they improve scanning.",
  parameters: Schema.Struct({ markdown: OptionalString, filePath: OptionalString }),
  success: DocumentMutation,
  failure: McpToolError,
}).annotate(Tool.Destructive, false)

const UpdateDocument = Tool.make("update_document", {
  description:
    "Update an inline hosted document in place and create a new version. File-backed documents must be updated by editing their source file and calling host_document with the same filePath.",
  parameters: Schema.Struct({ id: Schema.String, markdown: Schema.String }),
  success: DocumentMutation,
  failure: McpToolError,
}).annotate(Tool.Destructive, false)

const GetDocument = Tool.make("get_document", {
  description: "Get the current Markdown and metadata for one hosted document.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: HostedDocument,
  failure: McpToolError,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

const ListDocuments = Tool.make("list_documents", {
  description: "List locally hosted documents in most-recently-updated order.",
  success: DocumentList,
  failure: McpToolError,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

const ListDocumentVersions = Tool.make("list_document_versions", {
  description: "List retained version metadata for a hosted document, oldest to newest.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: DocumentVersions,
  failure: McpToolError,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

const DiffDocumentVersions = Tool.make("diff_document_versions", {
  description: "Render the durable unified diff between two retained document revision ids.",
  parameters: Schema.Struct({
    id: Schema.String,
    fromRevisionId: Schema.String,
    toRevisionId: Schema.String,
  }),
  success: RevisionDiff,
  failure: McpToolError,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

const WaitForFeedback = Tool.make("wait_for_feedback", {
  description:
    "Wait until the user leaves a new browser comment on a hosted document. Each comment is delivered once using a persisted document cursor. A timeout is not an error.",
  parameters: Schema.Struct({
    documentId: Schema.String,
    timeoutSeconds: Schema.optionalKey(Schema.Finite),
  }),
  success: Feedback,
  failure: McpToolError,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)

const SetCommentStatus = Tool.make("set_comment_status", {
  description: "Resolve or reopen a browser comment after acting on it.",
  parameters: Schema.Struct({
    documentId: Schema.String,
    commentId: Schema.String,
    status: Schema.Literals(["open", "resolved"]),
  }),
  success: CommentMutation,
  failure: McpToolError,
}).annotate(Tool.Destructive, false)

const DeleteDocument = Tool.make("delete_document", {
  description: "Delete one local hosted document and its comments. This never deletes an independently published public snapshot.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: DeleteResult,
  failure: McpToolError,
}).annotate(Tool.Destructive, true)

const GetAgentGuide = Tool.make("get_agent_guide", {
  description: "Read the current Behold authoring and review workflow instructions.",
  success: Schema.String,
  failure: McpToolError,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

const BeholdTools = Toolkit.make(
  HostDocument,
  UpdateDocument,
  GetDocument,
  ListDocuments,
  ListDocumentVersions,
  DiffDocumentVersions,
  WaitForFeedback,
  SetCommentStatus,
  DeleteDocument,
  GetAgentGuide,
)

const documentApiLive = documentApiLayer.pipe(
  Layer.provide(viewerLayer.pipe(Layer.provide(FetchHttpClient.layer))),
  Layer.provide(FetchHttpClient.layer),
)

const handlersLive = BeholdTools.toLayer(
  Effect.gen(function* () {
    const api = yield* DocumentApi
    return BeholdTools.of({
      host_document: ({ markdown, filePath }) => {
        const supplied = Number(markdown !== undefined) + Number(filePath !== undefined)
        if (supplied !== 1) {
          return Effect.fail(
            new McpToolError({ operation: "host_document", message: "Pass exactly one of markdown or filePath." }),
          )
        }
        return api.host({ ...(markdown !== undefined ? { markdown } : {}), ...(filePath !== undefined ? { filePath } : {}) })
      },
      update_document: ({ id, markdown }) => api.update(id, markdown),
      get_document: ({ id }) => api.get(id),
      list_documents: () => api.list(),
      list_document_versions: ({ id }) => api.versions(id),
      diff_document_versions: ({ id, fromRevisionId, toRevisionId }) => api.diffVersions(id, fromRevisionId, toRevisionId),
      wait_for_feedback: ({ documentId, timeoutSeconds }) =>
        api.feedback(documentId, Math.min(Math.max(timeoutSeconds ?? 120, 0), 300)),
      set_comment_status: ({ documentId, commentId, status }) => api.setCommentStatus(documentId, commentId, status),
      delete_document: ({ id }) => api.remove(id),
      get_agent_guide: () => api.guide(),
    })
  }),
).pipe(Layer.provide(documentApiLive))

Effect.gen(function* () {
  yield* McpServer.registerToolkit(BeholdTools)
  yield* McpServer.run({ name: "behold", version: "0.1.0" })
}).pipe(
  Effect.provide(handlersLive),
  Effect.provide(McpServer.McpServer.layer),
  Effect.provide(RpcServer.layerProtocolStdio),
  Effect.provide(RpcSerialization.layerNdJsonRpc()),
  Effect.provide(BunStdio.layer),
  Effect.provide(Layer.succeed(Logger.LogToStderr, true)),
  BunRuntime.runMain,
)

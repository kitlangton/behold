import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdir, readFile, stat } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { createTwoFilesPatch } from "diff"
import { Context, Duration, Effect, Layer, Option, PubSub, Schema, Stream, SynchronizedRef } from "effect"
import { PublicationReceiptSchema, type PublicationReceipt } from "../shared/document-contracts"
import { createSerializedAtomicJsonWriter, type SerializedAtomicJsonWriter } from "./serialized-atomic-json-writer"

const normalizeMarkdown = (markdown: string) => markdown.replace(/\r\n?/g, "\n")
const titleFromMarkdown = (markdown: string) => {
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim()
    if (line === "") continue
    const heading = line.replace(/^#+\s*/, "").trim()
    const title = line.startsWith("#") ? heading : line
    if (title === "") continue
    return title.length > 120 ? `${title.slice(0, 117)}...` : title
  }
  return "Untitled"
}
const contentHash = (markdown: string) => createHash("sha256").update(markdown).digest("hex")

export const AnchorSource = Schema.Struct({
  startUtf16: Schema.Number,
  endUtf16: Schema.Number,
  startLine: Schema.Number,
  endLine: Schema.Number,
})
export interface AnchorSource extends Schema.Schema.Type<typeof AnchorSource> {}

export const CommentAnchor = Schema.Struct({
  revisionId: Schema.String,
  plane: Schema.Literal("rendered-text-v1"),
  range: Schema.Struct({ start: Schema.Number, end: Schema.Number }),
  quote: Schema.Struct({ exact: Schema.String, prefix: Schema.String, suffix: Schema.String }),
  source: Schema.optionalKey(AnchorSource),
})
export interface CommentAnchor extends Schema.Schema.Type<typeof CommentAnchor> {}

export type CommentStatus = "open" | "resolved"

export const LegacyCommentLocation = Schema.Struct({
  sectionIndex: Schema.Number,
  sectionType: Schema.Literal("markdown"),
  selectedText: Schema.String,
  contextBefore: Schema.String,
  contextAfter: Schema.String,
})
export interface LegacyCommentLocation extends Schema.Schema.Type<typeof LegacyCommentLocation> {}

export const Comment = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  content: Schema.String,
  status: Schema.Literals(["open", "resolved"]),
  resolvedAt: Schema.optionalKey(Schema.String),
  location: LegacyCommentLocation,
  seq: Schema.Number,
  anchor: Schema.optionalKey(CommentAnchor),
})
export interface Comment extends Schema.Schema.Type<typeof Comment> {}

export const Revision = Schema.Struct({
  id: Schema.String,
  number: Schema.Number,
  documentId: Schema.String,
  parentRevisionId: Schema.optionalKey(Schema.String),
  title: Schema.String,
  markdown: Schema.String,
  contentHash: Schema.String,
  createdAt: Schema.String,
})
export interface Revision extends Schema.Schema.Type<typeof Revision> {}

export const StoredDocument = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  markdown: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  sourcePath: Schema.optionalKey(Schema.String),
  version: Schema.Number,
  currentRevisionId: Schema.String,
  publication: Schema.optionalKey(PublicationReceiptSchema),
})
export interface StoredDocument extends Schema.Schema.Type<typeof StoredDocument> {}

const PersistentStoreV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  documents: Schema.Array(StoredDocument),
  revisions: Schema.Record(Schema.String, Schema.Array(Revision)),
  comments: Schema.Record(Schema.String, Schema.Array(Comment)),
  feedbackCursors: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
  nextCommentSeq: Schema.optionalKey(Schema.Number),
})
interface PersistentStoreV2 extends Schema.Schema.Type<typeof PersistentStoreV2> {}

const V1DocumentVersion = Schema.Struct({
  version: Schema.optionalKey(Schema.Number),
  title: Schema.optionalKey(Schema.String),
  markdown: Schema.String,
  createdAt: Schema.optionalKey(Schema.String),
})
interface V1DocumentVersion extends Schema.Schema.Type<typeof V1DocumentVersion> {}

const V1Document = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  markdown: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.optionalKey(Schema.String),
  sourcePath: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.Number),
  history: Schema.optionalKey(Schema.Array(V1DocumentVersion)),
})
interface V1Document extends Schema.Schema.Type<typeof V1Document> {}

const V1Comment = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.optionalKey(Schema.String),
  content: Schema.String,
  status: Schema.optionalKey(Schema.Literals(["open", "resolved"])),
  resolvedAt: Schema.optionalKey(Schema.String),
  location: Schema.optionalKey(Schema.Unknown),
  seq: Schema.optionalKey(Schema.Number),
  anchor: Schema.optionalKey(CommentAnchor),
})
interface V1Comment extends Omit<Schema.Schema.Type<typeof V1Comment>, "location"> {
  readonly location?: LegacyCommentLocation | unknown
}

const PersistentStoreV1 = Schema.Struct({
  documents: Schema.Array(V1Document),
  comments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(V1Comment))),
  feedbackCursors: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
  nextCommentSeq: Schema.optionalKey(Schema.Number),
})
interface PersistentStoreV1 extends Schema.Schema.Type<typeof PersistentStoreV1> {}

export class DocumentReviewNotFound extends Schema.TaggedErrorClass<DocumentReviewNotFound>()("DocumentReviewNotFound", {
  message: Schema.String,
}) {}
export class DocumentReviewInvalidInput extends Schema.TaggedErrorClass<DocumentReviewInvalidInput>()("DocumentReviewInvalidInput", {
  message: Schema.String,
}) {}
export class DocumentReviewInvalidAnchor extends Schema.TaggedErrorClass<DocumentReviewInvalidAnchor>()("DocumentReviewInvalidAnchor", {
  message: Schema.String,
}) {}
export class DocumentReviewPersistenceError extends Schema.TaggedErrorClass<DocumentReviewPersistenceError>()("DocumentReviewPersistenceError", {
  message: Schema.String,
}) {}

export type SubmitOutcome = "created" | "revised" | "unchanged"
export interface SubmitResult {
  readonly outcome: SubmitOutcome
  readonly document: StoredDocument
  readonly revision?: Revision
}
export interface RevisionDiff {
  readonly patch: string
  readonly additions: number
  readonly deletions: number
}
export type DocumentReviewEvent =
  | { readonly _tag: "document-updated"; readonly documentId: string; readonly revisionId: string; readonly outcome: SubmitOutcome }
  | { readonly _tag: "document-deleted"; readonly documentId: string }
  | { readonly _tag: "comments-updated"; readonly documentId: string }
  | { readonly _tag: "publication-updated"; readonly documentId: string; readonly publication?: PublicationReceipt }

export interface PublicationReceiptEntry {
  readonly documentId: string
  readonly publication: PublicationReceipt
}

export interface SubmitDocumentInput {
  readonly markdown: string
  readonly sourcePath?: string
}
export interface AddCommentInput {
  readonly documentId: string
  readonly content: string
  readonly anchor?: CommentAnchor
  readonly location?: LegacyCommentLocation | unknown
}
export interface UpdateCommentInput {
  readonly documentId: string
  readonly commentId: string
  readonly content?: string
  readonly status?: CommentStatus
  readonly anchor?: CommentAnchor
}
export interface WaitForFeedbackResult {
  readonly documentId: string
  readonly comments: ReadonlyArray<Comment>
  readonly lastSeq: number
  readonly timedOut: boolean
}
interface State {
  readonly store: PersistentStoreV2
  readonly nextCommentSeq: number
}

type Mutation<A> = readonly [A, State, ReadonlyArray<DocumentReviewEvent>]

export interface DocumentReviewsOptions {
  readonly directory: string
  readonly storeFilePath: string
  readonly now?: () => string
  readonly makeId?: () => string
}

const persistenceError = (error: unknown) =>
  new DocumentReviewPersistenceError({ message: error instanceof Error ? error.message : String(error) })

const persistable = (store: PersistentStoreV2): PersistentStoreV2 => ({ ...store, schemaVersion: 2 })

const hasFile = (path: string) => Effect.tryPromise({ try: () => stat(path).then(() => true, () => false), catch: persistenceError })

const readJson = (path: string) =>
  Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: persistenceError }).pipe(
    Effect.flatMap((text) =>
      Effect.try({ try: () => JSON.parse(text) as unknown, catch: (e) => new DocumentReviewPersistenceError({ message: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` }) }),
    ),
  )

const decodeV2 = (value: unknown) => Schema.decodeUnknownEffect(PersistentStoreV2)(value).pipe(Effect.mapError((e) => new DocumentReviewPersistenceError({ message: String(e) })))
const decodeV1 = (value: unknown) => Schema.decodeUnknownEffect(PersistentStoreV1)(value).pipe(Effect.mapError((e) => new DocumentReviewPersistenceError({ message: String(e) })))

const emptyStore = (): PersistentStoreV2 => ({ schemaVersion: 2, documents: [], revisions: {}, comments: {} })

const retainRevisions = (revisions: ReadonlyArray<Revision>): ReadonlyArray<Revision> => {
  const retained = revisions.slice(-21)
  if (retained.length === 0) return retained
  const retainedIds = new Set(retained.map((revision) => revision.id))
  return retained.map((revision) =>
    revision.parentRevisionId && !retainedIds.has(revision.parentRevisionId)
      ? { ...revision, parentRevisionId: undefined }
      : revision,
  )
}

const normalizeLegacyLocation = (location: unknown, anchor?: CommentAnchor): LegacyCommentLocation => {
  if (typeof location === "object" && location !== null) {
    const value = location as Partial<LegacyCommentLocation>
    if (typeof value.sectionIndex === "number" && value.sectionType === "markdown" && typeof value.selectedText === "string") {
      return {
        sectionIndex: value.sectionIndex,
        sectionType: "markdown",
        selectedText: value.selectedText,
        contextBefore: typeof value.contextBefore === "string" ? value.contextBefore : "",
        contextAfter: typeof value.contextAfter === "string" ? value.contextAfter : "",
      }
    }
  }
  return {
    sectionIndex: 0,
    sectionType: "markdown",
    selectedText: anchor?.quote.exact ?? "",
    contextBefore: anchor?.quote.prefix ?? "",
    contextAfter: anchor?.quote.suffix ?? "",
  }
}

const normalizeV2Store = (store: PersistentStoreV2): PersistentStoreV2 => ({
  ...store,
  revisions: Object.fromEntries(
    Object.entries(store.revisions).map(([documentId, revisions]) => [
      documentId,
      retainRevisions(revisions),
    ]),
  ),
  comments: Object.fromEntries(
    Object.entries(store.comments).map(([documentId, comments]) => [
      documentId,
      comments.map((comment) => ({ ...comment, location: normalizeLegacyLocation(comment.location, comment.anchor) })),
    ]),
  ),
})

const normalizeComments = (store: PersistentStoreV1): { readonly comments: Record<string, Array<Comment>>; readonly nextCommentSeq: number } => {
  let next = store.nextCommentSeq ?? Math.max(0, ...Object.values(store.comments ?? {}).flat().map((comment) => comment.seq ?? 0)) + 1
  const comments: Record<string, Array<Comment>> = {}
  for (const [documentId, items] of Object.entries(store.comments ?? {})) {
    comments[documentId] = items.map((comment) => {
      const seq = comment.seq ?? next++
      return {
        id: comment.id,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt ?? comment.createdAt,
        content: comment.content,
        status: comment.status ?? "open",
        resolvedAt: comment.resolvedAt,
        location: normalizeLegacyLocation(comment.location, comment.anchor),
        seq,
        anchor: comment.anchor,
      }
    })
  }
  return { comments, nextCommentSeq: Math.max(next, store.nextCommentSeq ?? 1) }
}

const revisionFromSnapshot = (input: {
  readonly id: string
  readonly documentId: string
  readonly parentRevisionId?: string
  readonly number: number
  readonly title: string
  readonly markdown: string
  readonly createdAt: string
}): Revision => {
  const markdown = normalizeMarkdown(input.markdown)
  return { id: input.id, documentId: input.documentId, parentRevisionId: input.parentRevisionId, number: input.number, title: input.title, markdown, contentHash: contentHash(markdown), createdAt: input.createdAt }
}

const migrateV1 = (store: PersistentStoreV1, makeId: () => string): PersistentStoreV2 => {
  const revisions: Record<string, ReadonlyArray<Revision>> = {}
  const normalizedComments = normalizeComments(store)
  const documents = store.documents.map((doc) => {
    const documentRevisions: Array<Revision> = []
    let parentRevisionId: string | undefined
    let fallbackNumber = 1
    for (const snapshot of doc.history ?? []) {
      const number = snapshot.version ?? fallbackNumber
      const revision = revisionFromSnapshot({
        id: makeId(),
        documentId: doc.id,
        parentRevisionId,
        number,
        title: snapshot.title ?? titleFromMarkdown(snapshot.markdown),
        markdown: snapshot.markdown,
        createdAt: snapshot.createdAt ?? doc.createdAt,
      })
      documentRevisions.push(revision)
      parentRevisionId = revision.id
      fallbackNumber = Math.max(fallbackNumber + 1, number + 1)
    }
    const currentNumber = doc.version && doc.version >= fallbackNumber ? doc.version : fallbackNumber
    const currentRevision = revisionFromSnapshot({
      id: makeId(),
      documentId: doc.id,
      parentRevisionId,
      number: currentNumber,
      title: doc.title,
      markdown: doc.markdown,
      createdAt: doc.updatedAt ?? doc.createdAt,
    })
    documentRevisions.push(currentRevision)
    revisions[doc.id] = retainRevisions(documentRevisions)
    return { id: doc.id, title: currentRevision.title, markdown: currentRevision.markdown, createdAt: doc.createdAt, updatedAt: doc.updatedAt ?? doc.createdAt, sourcePath: doc.sourcePath, version: currentRevision.number, currentRevisionId: currentRevision.id }
  })
  return { schemaVersion: 2, documents, revisions, comments: normalizedComments.comments, feedbackCursors: store.feedbackCursors, nextCommentSeq: normalizedComments.nextCommentSeq }
}

const validateAnchor = (store: PersistentStoreV2, documentId: string, anchor: CommentAnchor) => {
  const revision = store.revisions[documentId]?.find((item) => item.id === anchor.revisionId)
  if (!revision) return Effect.fail(new DocumentReviewInvalidAnchor({ message: "Anchor revision does not belong to document." }))
  const numbers = [anchor.range.start, anchor.range.end, anchor.source?.startUtf16, anchor.source?.endUtf16, anchor.source?.startLine, anchor.source?.endLine].filter(
    (n): n is number => n !== undefined,
  )
  if (numbers.some((n) => !Number.isInteger(n) || n < 0)) return Effect.fail(new DocumentReviewInvalidAnchor({ message: "Anchor ranges must be non-negative integers." }))
  if (anchor.range.end <= anchor.range.start) return Effect.fail(new DocumentReviewInvalidAnchor({ message: "Anchor range end must be after start." }))
  if (anchor.quote.exact.length === 0) return Effect.fail(new DocumentReviewInvalidAnchor({ message: "Anchor exact quote must be non-empty." }))
  if (anchor.range.end - anchor.range.start !== anchor.quote.exact.length) return Effect.fail(new DocumentReviewInvalidAnchor({ message: "Anchor range length must equal exact quote length." }))
  if (anchor.source) {
    if (anchor.source.endUtf16 < anchor.source.startUtf16) return Effect.fail(new DocumentReviewInvalidAnchor({ message: "Anchor source end must be after start." }))
    if (revision.markdown.slice(anchor.source.startUtf16, anchor.source.endUtf16) !== anchor.quote.exact) {
      return Effect.fail(new DocumentReviewInvalidAnchor({ message: "Anchor source slice must equal exact quote." }))
    }
    const occurrences: Array<number> = []
    let occurrence = revision.markdown.indexOf(anchor.quote.exact)
    while (occurrence >= 0) {
      occurrences.push(occurrence)
      occurrence = revision.markdown.indexOf(anchor.quote.exact, occurrence + 1)
    }
    const matchesContext = (offset: number, prefix: string, suffix: string) => {
      const before = revision.markdown.slice(Math.max(0, offset - prefix.length), offset)
      const after = revision.markdown.slice(offset + anchor.quote.exact.length, offset + anchor.quote.exact.length + suffix.length)
      return (prefix === "" || before.endsWith(prefix)) && (suffix === "" || after.startsWith(suffix))
    }
    const both = occurrences.filter((offset) => matchesContext(offset, anchor.quote.prefix, anchor.quote.suffix))
    const prefix = occurrences.filter((offset) => matchesContext(offset, anchor.quote.prefix, ""))
    const suffix = occurrences.filter((offset) => matchesContext(offset, "", anchor.quote.suffix))
    const resolvedSourceOffset = occurrences.length === 1
      ? occurrences[0]
      : both.length === 1
        ? both[0]
        : anchor.quote.prefix !== "" && prefix.length === 1
          ? prefix[0]
          : anchor.quote.suffix !== "" && suffix.length === 1
            ? suffix[0]
            : undefined
    if (resolvedSourceOffset !== anchor.source.startUtf16) {
      return Effect.fail(new DocumentReviewInvalidAnchor({ message: "Anchor source metadata requires an unambiguous Markdown quote." }))
    }
    const startLine = lineForOffset(revision.markdown, anchor.source.startUtf16)
    const endLine = lineForOffset(revision.markdown, anchor.source.endUtf16)
    if (startLine !== anchor.source.startLine || endLine !== anchor.source.endLine) {
      return Effect.fail(new DocumentReviewInvalidAnchor({ message: "Anchor source line numbers must match offsets." }))
    }
  }
  return Effect.void
}

const lineForOffset = (text: string, offset: number) => text.slice(0, offset).split("\n").length

const makeRevision = (input: { readonly id: string; readonly number: number; readonly documentId: string; readonly parentRevisionId?: string; readonly markdown: string; readonly createdAt: string }): Revision => ({
  id: input.id,
  number: input.number,
  documentId: input.documentId,
  parentRevisionId: input.parentRevisionId,
  title: titleFromMarkdown(input.markdown),
  markdown: input.markdown,
  contentHash: contentHash(input.markdown),
  createdAt: input.createdAt,
})

const loadState = (
  options: Required<Pick<DocumentReviewsOptions, "now" | "makeId">> & DocumentReviewsOptions,
  writer: SerializedAtomicJsonWriter<PersistentStoreV2>,
) => {
  return hasFile(options.storeFilePath).pipe(
    Effect.flatMap((exists) => {
      if (!exists) return Effect.succeed({ store: emptyStore(), nextCommentSeq: 1 })
      return readJson(options.storeFilePath).pipe(
        Effect.flatMap((json) => {
          if (typeof json === "object" && json !== null && "schemaVersion" in json) {
            return decodeV2(json).pipe(
              Effect.map(normalizeV2Store),
              Effect.map((store) => ({ store, nextCommentSeq: store.nextCommentSeq ?? nextSeq(store.comments) })),
            )
          }
          return decodeV1(json).pipe(
            Effect.flatMap((v1) => {
              const migrated = migrateV1(v1, options.makeId)
              const backupPath = resolve(dirname(options.storeFilePath), `${basename(options.storeFilePath, ".json")}.v1.backup.json`)
              return hasFile(backupPath).pipe(
                Effect.flatMap((backupExists) =>
                  Effect.tryPromise({
                    try: () => {
                      const target = backupExists
                        ? resolve(dirname(options.storeFilePath), `${basename(options.storeFilePath, ".json")}.v1.${process.pid}.${Date.now()}.backup.json`)
                        : backupPath
                      return mkdir(dirname(target), { recursive: true }).then(() => copyFile(options.storeFilePath, target))
                    },
                    catch: persistenceError,
                  }).pipe(
                    Effect.flatMap(() => Effect.tryPromise({ try: () => writer.write(persistable(migrated)), catch: persistenceError })),
                    Effect.as({ store: migrated, nextCommentSeq: migrated.nextCommentSeq ?? nextSeq(migrated.comments) }),
                  ),
                ),
              )
            }),
          )
        }),
      )
    }),
  )
}

const nextSeq = (comments: Record<string, ReadonlyArray<Comment>>) => Math.max(0, ...Object.values(comments).flat().map((c) => c.seq || 0)) + 1

export interface Interface {
    readonly submitDocument: (input: SubmitDocumentInput) => Effect.Effect<SubmitResult, DocumentReviewInvalidInput | DocumentReviewPersistenceError>
    readonly reviseDocument: (documentId: string, markdown: string) => Effect.Effect<SubmitResult, DocumentReviewNotFound | DocumentReviewInvalidInput | DocumentReviewPersistenceError>
    readonly listDocuments: () => Effect.Effect<ReadonlyArray<StoredDocument>>
    readonly listPublicationReceipts: () => Effect.Effect<ReadonlyArray<PublicationReceiptEntry>>
    readonly setPublicationReceipt: (documentId: string, receipt: PublicationReceipt) => Effect.Effect<StoredDocument, DocumentReviewNotFound | DocumentReviewPersistenceError>
    readonly clearPublicationReceipt: (documentId: string, expectedExportedAt?: string) => Effect.Effect<boolean, DocumentReviewNotFound | DocumentReviewPersistenceError>
    readonly getDocument: (documentId: string, revisionId?: string) => Effect.Effect<StoredDocument & { readonly revision: Revision }, DocumentReviewNotFound>
    readonly listRevisions: (documentId: string) => Effect.Effect<ReadonlyArray<Revision>, DocumentReviewNotFound>
    readonly diffRevisions: (documentId: string, fromRevisionId: string, toRevisionId: string) => Effect.Effect<RevisionDiff, DocumentReviewNotFound>
    readonly listComments: (documentId: string) => Effect.Effect<ReadonlyArray<Comment>, DocumentReviewNotFound>
    readonly addComment: (input: AddCommentInput) => Effect.Effect<Comment, DocumentReviewNotFound | DocumentReviewInvalidInput | DocumentReviewInvalidAnchor | DocumentReviewPersistenceError>
    readonly updateComment: (input: UpdateCommentInput) => Effect.Effect<Comment, DocumentReviewNotFound | DocumentReviewInvalidInput | DocumentReviewInvalidAnchor | DocumentReviewPersistenceError>
    readonly deleteComment: (documentId: string, commentId: string) => Effect.Effect<void, DocumentReviewNotFound | DocumentReviewPersistenceError>
    readonly clearComments: (documentId: string) => Effect.Effect<void, DocumentReviewNotFound | DocumentReviewPersistenceError>
    readonly deleteDocument: (documentId: string) => Effect.Effect<void, DocumentReviewNotFound | DocumentReviewPersistenceError>
    readonly waitForFeedback: (documentId: string, timeout: Duration.Duration) => Effect.Effect<WaitForFeedbackResult, DocumentReviewNotFound>
    readonly acknowledgeFeedback: (documentId: string, lastSeq: number) => Effect.Effect<void, DocumentReviewNotFound | DocumentReviewInvalidInput | DocumentReviewPersistenceError>
    readonly changes: () => Stream.Stream<DocumentReviewEvent>
  }

export class Service extends Context.Service<Service, Interface>()("behold/DocumentReviews") {}

export const layer = (rawOptions: DocumentReviewsOptions): Layer.Layer<Service, DocumentReviewPersistenceError> =>
    Layer.effect(Service)(Effect.gen(function*() {
      const options = { now: () => new Date().toISOString(), makeId: randomUUID, ...rawOptions }
      const writer = createSerializedAtomicJsonWriter<PersistentStoreV2>({ directory: options.directory, filePath: options.storeFilePath })
       const initial = yield* loadState(options, writer)
      const ref = yield* SynchronizedRef.make<State>(initial)
      const pubsub = yield* PubSub.unbounded<DocumentReviewEvent>()
      const publish = (event: DocumentReviewEvent) => PubSub.publish(pubsub, event).pipe(Effect.asVoid)
      const persist = (store: PersistentStoreV2) => Effect.tryPromise({ try: () => writer.write(persistable(store)), catch: persistenceError })

       const mutate = <A, E>(f: (state: State) => Effect.Effect<Mutation<A>, E>) =>
         SynchronizedRef.modifyEffect(ref, (state) => f(state).pipe(Effect.flatMap(([result, next, events]) => {
           if (next.store === state.store && next.nextCommentSeq === state.nextCommentSeq) {
             return Effect.succeed([[result, events] as const, state] as const)
           }
           return persist(next.store).pipe(Effect.as([[result, events] as const, next] as const))
         }))).pipe(
          Effect.tap(([, events]) => Effect.forEach(events, publish, { discard: true })),
          Effect.map(([result]) => result),
        )

      const requireDocument = (store: PersistentStoreV2, documentId: string): Effect.Effect<StoredDocument, DocumentReviewNotFound> => {
        const document = store.documents.find((item) => item.id === documentId)
        return document ? Effect.succeed(document) : Effect.fail(new DocumentReviewNotFound({ message: `Document not found: ${documentId}` }))
      }

      const buildRevisionChange = (state: State, document: StoredDocument, markdown: string): Effect.Effect<Mutation<SubmitResult>, DocumentReviewInvalidInput> => {
        const normalized = normalizeMarkdown(markdown)
        if (normalized.trim() === "") return Effect.fail(new DocumentReviewInvalidInput({ message: "Markdown must not be empty." }))
        const current = state.store.revisions[document.id]?.find((item) => item.id === document.currentRevisionId)
        if (current?.contentHash === contentHash(normalized)) {
          return Effect.succeed([{ outcome: "unchanged", document } satisfies SubmitResult, state, []] as const)
        }
        const now = options.now()
        const revision = makeRevision({
          id: options.makeId(),
          number: document.version + 1,
          documentId: document.id,
          parentRevisionId: document.currentRevisionId,
          markdown: normalized,
          createdAt: now,
        })
        const updated = { ...document, title: revision.title, markdown: normalized, updatedAt: now, version: revision.number, currentRevisionId: revision.id }
        const store = {
          ...state.store,
          documents: state.store.documents.map((item) => (item.id === updated.id ? updated : item)),
          revisions: {
            ...state.store.revisions,
            [updated.id]: retainRevisions([...(state.store.revisions[updated.id] ?? []), revision]),
          },
        }
        return Effect.succeed([
          { outcome: "revised", document: updated, revision } satisfies SubmitResult,
          { ...state, store },
          [{ _tag: "document-updated", documentId: updated.id, revisionId: revision.id, outcome: "revised" } satisfies DocumentReviewEvent],
        ] as const)
      }

      const pendingFeedback = (documentId: string) =>
        SynchronizedRef.get(ref).pipe(
          Effect.flatMap((state) =>
            requireDocument(state.store, documentId).pipe(
              Effect.map(() => {
                const cursor = state.store.feedbackCursors?.[documentId] ?? 0
                const pending = (state.store.comments[documentId] ?? []).filter((comment) => comment.seq > cursor)
                if (pending.length === 0) return Option.none<WaitForFeedbackResult>()
                const lastSeq = pending.reduce((highest, comment) => Math.max(highest, comment.seq), cursor)
                return Option.some({ documentId, comments: pending, lastSeq, timedOut: false } satisfies WaitForFeedbackResult)
              }),
            ),
          ),
        )

      const feedbackTimeout = (documentId: string) =>
        SynchronizedRef.get(ref).pipe(
          Effect.flatMap((state) =>
            requireDocument(state.store, documentId).pipe(
              Effect.as({
                documentId,
                comments: [],
                lastSeq: state.store.feedbackCursors?.[documentId] ?? 0,
                timedOut: true,
              } satisfies WaitForFeedbackResult),
            ),
          ),
        )

      const api: Interface = {
        submitDocument: Effect.fn("DocumentReviews.submitDocument")(function*(input: SubmitDocumentInput) {
          const markdown = normalizeMarkdown(input.markdown)
          if (markdown.trim() === "") return yield* new DocumentReviewInvalidInput({ message: "Markdown must not be empty." })
          return yield* mutate((state): Effect.Effect<Mutation<SubmitResult>, DocumentReviewInvalidInput> => {
            const now = options.now()
            const existing = input.sourcePath ? state.store.documents.find((item) => item.sourcePath === input.sourcePath) : undefined
            if (existing) {
              return buildRevisionChange(state, existing, markdown)
            }
            const documentId = options.makeId()
            const revision = makeRevision({ id: options.makeId(), number: 1, documentId, markdown, createdAt: now })
            const document: StoredDocument = { id: documentId, title: revision.title, markdown, createdAt: now, updatedAt: now, sourcePath: input.sourcePath, version: 1, currentRevisionId: revision.id }
            const store = { ...state.store, documents: [...state.store.documents, document], revisions: { ...state.store.revisions, [documentId]: [revision] }, comments: { ...state.store.comments, [documentId]: state.store.comments[documentId] ?? [] } }
            return Effect.succeed([{ outcome: "created", document, revision } satisfies SubmitResult, { ...state, store }, [{ _tag: "document-updated", documentId, revisionId: revision.id, outcome: "created" }]] as const)
          })
        }) as Interface["submitDocument"],
        reviseDocument: Effect.fn("DocumentReviews.reviseDocument")(function*(documentId: string, markdown: string) {
          return yield* mutate((state) => Effect.gen(function*() {
          const document = yield* requireDocument(state.store, documentId)
          if (document.sourcePath) {
            return yield* new DocumentReviewInvalidInput({ message: "This document is file-backed. Edit its source file and resubmit the same sourcePath." })
          }
          return yield* buildRevisionChange(state, document, markdown)
        }))
        }) as Interface["reviseDocument"],
        listDocuments: Effect.fn("DocumentReviews.listDocuments")(function*() {
          const state = yield* SynchronizedRef.get(ref)
          return state.store.documents
        }),
        listPublicationReceipts: Effect.fn("DocumentReviews.listPublicationReceipts")(function*() {
          const state = yield* SynchronizedRef.get(ref)
          return state.store.documents.flatMap((document) => document.publication ? [{ documentId: document.id, publication: document.publication }] : [])
        }),
        setPublicationReceipt: Effect.fn("DocumentReviews.setPublicationReceipt")(function*(documentId: string, receipt: PublicationReceipt) {
          return yield* mutate((state) => Effect.gen(function*() {
            const document = yield* requireDocument(state.store, documentId)
            const updated = { ...document, publication: receipt }
            const clearedDocumentIds: Array<string> = []
            const documents = state.store.documents.map((item) => {
              if (item.id === documentId) return updated
              if (item.publication?.url === receipt.url) {
                clearedDocumentIds.push(item.id)
                return { ...item, publication: undefined }
              }
              return item
            })
            const store = { ...state.store, documents }
            return [updated, { ...state, store }, [
              ...clearedDocumentIds.map((clearedDocumentId) => ({ _tag: "publication-updated", documentId: clearedDocumentId }) satisfies DocumentReviewEvent),
              { _tag: "publication-updated", documentId, publication: receipt } satisfies DocumentReviewEvent,
            ]] as const
          }))
        }) as Interface["setPublicationReceipt"],
        clearPublicationReceipt: Effect.fn("DocumentReviews.clearPublicationReceipt")(function*(documentId: string, expectedExportedAt?: string) {
          return yield* mutate((state) => Effect.gen(function*() {
            const document = yield* requireDocument(state.store, documentId)
            const existing = document.publication
            if (!existing || (expectedExportedAt !== undefined && existing.exportedAt !== expectedExportedAt)) {
              return [false, state, []] as const
            }
            const updated = { ...document, publication: undefined }
            const store = { ...state.store, documents: state.store.documents.map((item) => (item.id === documentId ? updated : item)) }
            return [true, { ...state, store }, [{ _tag: "publication-updated", documentId } satisfies DocumentReviewEvent]] as const
          }))
        }) as Interface["clearPublicationReceipt"],
        getDocument: Effect.fn("DocumentReviews.getDocument")(function*(documentId: string, revisionId?: string) {
          const state = yield* SynchronizedRef.get(ref)
          const document = yield* requireDocument(state.store, documentId)
          const revision = state.store.revisions[documentId]?.find((item) => item.id === (revisionId ?? document.currentRevisionId))
          if (!revision) return yield* new DocumentReviewNotFound({ message: `Revision not found: ${revisionId ?? document.currentRevisionId}` })
          return { ...document, markdown: revision.markdown, title: revision.title, updatedAt: revision.createdAt, version: revision.number, revision }
        }),
        listRevisions: Effect.fn("DocumentReviews.listRevisions")(function*(documentId: string) {
          const state = yield* SynchronizedRef.get(ref)
          yield* requireDocument(state.store, documentId)
          return state.store.revisions[documentId] ?? []
        }),
        diffRevisions: Effect.fn("DocumentReviews.diffRevisions")(function*(documentId: string, fromRevisionId: string, toRevisionId: string) {
          const state = yield* SynchronizedRef.get(ref)
          yield* requireDocument(state.store, documentId)
          const revisions = state.store.revisions[documentId] ?? []
          const from = revisions.find((item) => item.id === fromRevisionId)
          const to = revisions.find((item) => item.id === toRevisionId)
          if (!from || !to) return yield* new DocumentReviewNotFound({ message: "Revision not found." })
          const patch = createTwoFilesPatch(from.id, to.id, from.markdown, to.markdown)
          let additions = 0
          let deletions = 0
          for (const line of patch.split("\n")) {
            if (line.startsWith("+") && !line.startsWith("+++")) additions++
            if (line.startsWith("-") && !line.startsWith("---")) deletions++
          }
          return { patch, additions, deletions }
        }),
        listComments: Effect.fn("DocumentReviews.listComments")(function*(documentId: string) {
          const state = yield* SynchronizedRef.get(ref)
          yield* requireDocument(state.store, documentId)
          return state.store.comments[documentId] ?? []
        }),
        addComment: Effect.fn("DocumentReviews.addComment")(function*(input: AddCommentInput) {
          if (input.content.trim() === "") return yield* new DocumentReviewInvalidInput({ message: "Comment content must not be empty." })
          return yield* mutate((state) => Effect.gen(function*() {
          yield* requireDocument(state.store, input.documentId)
          if (input.anchor) yield* validateAnchor(state.store, input.documentId, input.anchor)
          const now = options.now()
          const comment: Comment = { id: options.makeId(), createdAt: now, updatedAt: now, content: input.content, status: "open", location: normalizeLegacyLocation(input.location, input.anchor), seq: state.nextCommentSeq, anchor: input.anchor }
          const comments = [...(state.store.comments[input.documentId] ?? []), comment]
          const store = { ...state.store, comments: { ...state.store.comments, [input.documentId]: comments }, nextCommentSeq: state.nextCommentSeq + 1 }
          return [comment, { store, nextCommentSeq: state.nextCommentSeq + 1 }, [{ _tag: "comments-updated", documentId: input.documentId } satisfies DocumentReviewEvent]] as const
        }))
        }) as Interface["addComment"],
        updateComment: Effect.fn("DocumentReviews.updateComment")(function*(input: UpdateCommentInput) {
          if (input.content !== undefined && input.content.trim() === "") return yield* new DocumentReviewInvalidInput({ message: "Comment content must not be empty." })
          return yield* mutate((state) => Effect.gen(function*() {
          yield* requireDocument(state.store, input.documentId)
          if (input.anchor) yield* validateAnchor(state.store, input.documentId, input.anchor)
          const comments = state.store.comments[input.documentId] ?? []
          const comment = comments.find((item) => item.id === input.commentId)
          if (!comment) return yield* new DocumentReviewNotFound({ message: `Comment not found: ${input.commentId}` })
          const now = options.now()
          const status = input.status ?? comment.status
           const feedbackChanged = input.content !== undefined || input.anchor !== undefined
           const nextCommentSeq = feedbackChanged ? state.nextCommentSeq + 1 : state.nextCommentSeq
           const updated: Comment = { ...comment, content: input.content ?? comment.content, status, anchor: input.anchor ?? comment.anchor, seq: feedbackChanged ? state.nextCommentSeq : comment.seq, updatedAt: now, resolvedAt: input.status === undefined ? comment.resolvedAt : status === "resolved" ? (comment.resolvedAt ?? now) : undefined }
           const store = { ...state.store, comments: { ...state.store.comments, [input.documentId]: comments.map((item) => (item.id === input.commentId ? updated : item)) }, nextCommentSeq }
           return [updated, { store, nextCommentSeq }, [{ _tag: "comments-updated", documentId: input.documentId } satisfies DocumentReviewEvent]] as const
        }))
        }) as Interface["updateComment"],
        deleteComment: Effect.fn("DocumentReviews.deleteComment")(function*(documentId: string, commentId: string) {
          return yield* mutate((state) => Effect.gen(function*() {
          yield* requireDocument(state.store, documentId)
          const comments = state.store.comments[documentId] ?? []
          if (!comments.some((item) => item.id === commentId)) return yield* new DocumentReviewNotFound({ message: `Comment not found: ${commentId}` })
          const store = { ...state.store, comments: { ...state.store.comments, [documentId]: comments.filter((item) => item.id !== commentId) } }
          return [undefined, { ...state, store }, [{ _tag: "comments-updated", documentId } satisfies DocumentReviewEvent]] as const
        }))
        }),
        clearComments: Effect.fn("DocumentReviews.clearComments")(function*(documentId: string) {
          return yield* mutate((state) => Effect.gen(function*() {
          yield* requireDocument(state.store, documentId)
          const store = { ...state.store, comments: { ...state.store.comments, [documentId]: [] } }
          return [undefined, { ...state, store }, [{ _tag: "comments-updated", documentId } satisfies DocumentReviewEvent]] as const
        }))
        }),
        deleteDocument: Effect.fn("DocumentReviews.deleteDocument")(function*(documentId: string) {
          return yield* mutate((state) => Effect.gen(function*() {
          yield* requireDocument(state.store, documentId)
          const { [documentId]: _revisions, ...revisions } = state.store.revisions
          const { [documentId]: _comments, ...comments } = state.store.comments
          const { [documentId]: _cursor, ...feedbackCursors } = state.store.feedbackCursors ?? {}
          const store = { ...state.store, documents: state.store.documents.filter((item) => item.id !== documentId), revisions, comments, feedbackCursors }
          return [undefined, { ...state, store }, [{ _tag: "document-deleted", documentId } satisfies DocumentReviewEvent]] as const
        }))
        }),
        waitForFeedback: Effect.fn("DocumentReviews.waitForFeedback")(function*(documentId: string, timeout: Duration.Duration) {
          return yield* Effect.scoped(Effect.gen(function*() {
          const waitMillis = Duration.toMillis(timeout)
          const subscription = yield* PubSub.subscribe(pubsub)
          const immediate = yield* pendingFeedback(documentId)
          if (Option.isSome(immediate)) return immediate.value
          if (waitMillis <= 0) return yield* feedbackTimeout(documentId)

           const waitForPending = Effect.gen(function*() {
             while (true) {
               const event = yield* PubSub.take(subscription)
               if (event._tag !== "comments-updated" || event.documentId !== documentId) continue
               const pending = yield* pendingFeedback(documentId)
               if (Option.isSome(pending)) return pending.value
             }
           })
           const delivered = yield* waitForPending.pipe(Effect.timeoutOption(Duration.min(timeout, Duration.minutes(5))))
           return Option.isSome(delivered) ? delivered.value : yield* feedbackTimeout(documentId)
        }))
        }),
        acknowledgeFeedback: Effect.fn("DocumentReviews.acknowledgeFeedback")(function*(documentId: string, lastSeq: number) {
          if (!Number.isInteger(lastSeq) || lastSeq < 0) {
            return yield* new DocumentReviewInvalidInput({ message: "Feedback sequence must be a non-negative integer." })
          }
          return yield* mutate((state) => Effect.gen(function*() {
            yield* requireDocument(state.store, documentId)
            const highestSeq = Math.max(0, ...(state.store.comments[documentId] ?? []).map((comment) => comment.seq))
            if (lastSeq > highestSeq) {
              return yield* new DocumentReviewInvalidInput({ message: "Feedback sequence exceeds the latest comment." })
            }
            const current = state.store.feedbackCursors?.[documentId] ?? 0
            const store = current >= lastSeq
              ? state.store
              : { ...state.store, feedbackCursors: { ...state.store.feedbackCursors, [documentId]: lastSeq } }
            return [undefined, { ...state, store }, []] as const
          }))
        }),
        changes: () => Stream.fromPubSub(pubsub),
      }
      return Service.of(api)
    }))

export * as DocumentReviews from "./document-reviews"

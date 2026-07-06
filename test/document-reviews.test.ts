import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Duration, Effect, Fiber } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { DocumentReviewInvalidAnchor, DocumentReviews, type CommentAnchor } from "../server/document-reviews"
import type { PublicationReceipt } from "../shared/document-contracts"

const roots: Array<string> = []
let id = 0
let time = 0

const makeRoot = async () => {
  const root = join(process.cwd(), ".tmp-document-reviews", `${Date.now()}-${Math.random()}`)
  roots.push(root)
  await mkdir(root, { recursive: true })
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  id = 0
  time = 0
})

const makeLayer = (root: string) =>
  DocumentReviews.layer({
    directory: root,
    storeFilePath: join(root, "store.json"),
    now: () => `2026-01-01T00:00:${String(++time).padStart(2, "0")}.000Z`,
    makeId: () => `id-${++id}`,
  })

const run = <A, E>(root: string, effect: Effect.Effect<A, E, DocumentReviews.Service>) => Effect.runPromise(effect.pipe(Effect.provide(makeLayer(root))))

const receipt = (overrides: Partial<PublicationReceipt> = {}): PublicationReceipt => ({
  slug: "doc",
  url: "https://example.com/doc",
  exportedAt: "2026-01-01T00:00:00.000Z",
  publishedRevisionId: "revision-1",
  remoteStatus: "published",
  checkedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
})

describe("DocumentReviews", () => {
  it("migrates original pre-version stores with normalized defaults", async () => {
    const root = await makeRoot()
    await writeFile(
      join(root, "store.json"),
      JSON.stringify({
        documents: [{ id: "doc-original", title: "Original", markdown: "# Original", createdAt: "created", sourcePath: "/original.md" }],
        comments: { "doc-original": [{ id: "comment-original", createdAt: "comment-created", content: "legacy", location: { selectedText: "Original" } }] },
      }),
    )

    const result = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      return { doc: yield* service.getDocument("doc-original"), comments: yield* service.listComments("doc-original"), revisions: yield* service.listRevisions("doc-original") }
    }))

    expect(result.doc.version).toBe(1)
    expect(result.doc.updatedAt).toBe("created")
    expect(result.revisions).toHaveLength(1)
    expect(result.comments[0]).toMatchObject({ id: "comment-original", updatedAt: "comment-created", status: "open", seq: 1 })
    const stored = JSON.parse(await readFile(join(root, "store.json"), "utf8"))
    expect(stored.documents[0].history).toBeUndefined()
    expect(stored.documents[0].currentRevisionId).toBe("id-1")
  })

  it("migrates V1 stores, creates a backup, and preserves legacy comments", async () => {
    const root = await makeRoot()
    await writeFile(
      join(root, "store.json"),
      JSON.stringify({
        documents: [{ id: "doc-1", title: "Old", markdown: "# Old\r\nText", createdAt: "then", updatedAt: "then", sourcePath: "/tmp/old.md", version: 1, history: [] }],
        comments: { "doc-1": [
          { id: "c1", createdAt: "then", updatedAt: "then", content: "legacy", status: "open", location: { sectionIndex: 0, sectionType: "markdown", selectedText: "Old", contextBefore: "", contextAfter: "" }, seq: 1 },
          { id: "c2", createdAt: "then", content: "missing location", seq: 2 },
        ] },
        nextCommentSeq: 3,
      }),
    )

    const result = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      return { doc: yield* service.getDocument("doc-1"), comments: yield* service.listComments("doc-1"), revisions: yield* service.listRevisions("doc-1") }
    }))

    expect(result.doc.currentRevisionId).toBe("id-1")
    expect(result.doc.markdown).toBe("# Old\nText")
    expect(result.comments[0]?.anchor).toBeUndefined()
    expect(result.comments[0]?.location).toMatchObject({ selectedText: "Old" })
    expect(result.comments[1]?.location).toEqual({ sectionIndex: 0, sectionType: "markdown", selectedText: "", contextBefore: "", contextAfter: "" })
    expect(result.revisions).toHaveLength(1)
    await expect(readFile(join(root, "store.v1.backup.json"), "utf8")).resolves.toContain('"documents"')
    const stored = JSON.parse(await readFile(join(root, "store.json"), "utf8"))
    expect(stored.schemaVersion).toBe(2)
  })

  it("preserves legacy history snapshots as revisions before current markdown", async () => {
    const root = await makeRoot()
    await writeFile(
      join(root, "store.json"),
      JSON.stringify({
        documents: [{
          id: "doc-history",
          title: "Current",
          markdown: "# Current",
          createdAt: "t0",
          updatedAt: "t3",
          sourcePath: "/history.md",
          version: 3,
          history: [
            { version: 1, title: "First", markdown: "# First", createdAt: "t1" },
            { version: 2, title: "Second", markdown: "# Second", createdAt: "t2" },
          ],
        }],
        comments: {},
        feedbackCursors: { "doc-history": 7 },
        nextCommentSeq: 8,
      }),
    )

    const result = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      const revisions = yield* service.listRevisions("doc-history")
      const doc = yield* service.getDocument("doc-history")
      const wait = yield* service.waitForFeedback("doc-history", 0)
      return { revisions, doc, wait }
    }))

    expect(result.revisions.map((revision) => [revision.number, revision.title, revision.markdown, revision.createdAt])).toEqual([
      [1, "First", "# First", "t1"],
      [2, "Second", "# Second", "t2"],
      [3, "Current", "# Current", "t3"],
    ])
    expect(result.doc.currentRevisionId).toBe("id-3")
    expect(result.wait.lastSeq).toBe(7)
    expect(result.wait.timedOut).toBe(true)
  })

  it("distinguishes unchanged and revised sourcePath submissions", async () => {
    const root = await makeRoot()
    const result = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      const created = yield* service.submitDocument({ markdown: "# A\r\ntext", sourcePath: "/a.md" })
      const unchanged = yield* service.submitDocument({ markdown: "# A\ntext", sourcePath: "/a.md" })
      const revised = yield* service.submitDocument({ markdown: "# A\ntext\nmore", sourcePath: "/a.md" })
      const revisions = yield* service.listRevisions(created.document.id)
      return { created, unchanged, revised, revisions }
    }))

    expect(result.created.outcome).toBe("created")
    expect(result.unchanged.outcome).toBe("unchanged")
    expect(result.unchanged.revision).toBeUndefined()
    expect(result.revised.outcome).toBe("revised")
    expect(result.revisions.map((revision) => revision.number)).toEqual([1, 2])
  })

  it("uses the first meaningful line when a document has no level-one heading", async () => {
    const root = await makeRoot()
    const titles = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      const prose = yield* service.submitDocument({ markdown: "\nA prose title\n\nBody" })
      const subheading = yield* service.submitDocument({ markdown: "## A subheading\n\nBody" })
      return [prose.document.title, subheading.document.title]
    }))

    expect(titles).toEqual(["A prose title", "A subheading"])
  })

  it("revises inline documents explicitly and rejects explicit revisions for source-backed documents", async () => {
    const root = await makeRoot()
    const result = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      const firstInline = yield* service.submitDocument({ markdown: "# Inline" })
      const secondInline = yield* service.submitDocument({ markdown: "# Inline" })
      const revised = yield* service.reviseDocument(firstInline.document.id, "# Inline\nchanged")
      const unchanged = yield* service.reviseDocument(firstInline.document.id, "# Inline\nchanged")
      const source = yield* service.submitDocument({ markdown: "# Source", sourcePath: "/source.md" })
      const sourceRevise = yield* Effect.exit(service.reviseDocument(source.document.id, "# Source\nchanged"))
      const revisions = yield* service.listRevisions(firstInline.document.id)
      return { firstInline, secondInline, revised, unchanged, sourceRevise, revisions }
    }))

    expect(result.secondInline.document.id).not.toBe(result.firstInline.document.id)
    expect(result.revised.outcome).toBe("revised")
    expect(result.unchanged.outcome).toBe("unchanged")
    expect(result.unchanged.revision).toBeUndefined()
    expect(result.revisions.map((revision) => revision.number)).toEqual([1, 2])
    expect(result.sourceRevise._tag).toBe("Failure")
  })

  it("derives durable unified diffs from persisted revisions", async () => {
    const root = await makeRoot()
    const ids = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      const first = yield* service.submitDocument({ markdown: "# A\none\n", sourcePath: "/a.md" })
      const second = yield* service.submitDocument({ markdown: "# A\ntwo\nthree\n", sourcePath: "/a.md" })
      return { documentId: first.document.id, from: first.revision!.id, to: second.revision!.id }
    }))

    const diff = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      return yield* service.diffRevisions(ids.documentId, ids.from, ids.to)
    }))

    expect(diff.patch).toContain("-one")
    expect(diff.patch).toContain("+two")
    expect(diff.patch).toContain("+three")
    expect(diff.additions).toBe(2)
    expect(diff.deletions).toBe(1)
  })

  it("validates exact anchors by position so duplicate quotes remain safe", async () => {
    const root = await makeRoot()
    const result = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      const submitted = yield* service.submitDocument({ markdown: "same\nsame\n" })
      const revisionId = submitted.revision!.id
      const anchor: CommentAnchor = { revisionId, plane: "rendered-text-v1", range: { start: 5, end: 9 }, quote: { exact: "same", prefix: "same\n", suffix: "\n" }, source: { startUtf16: 5, endUtf16: 9, startLine: 2, endLine: 2 } }
      const comment = yield* service.addComment({ documentId: submitted.document.id, content: "second same", anchor })
      return comment
    }))

    expect(result.anchor?.range).toEqual({ start: 5, end: 9 })
    expect(result.anchor?.source?.startLine).toBe(2)
  })

  it("rejects source metadata when the Markdown quote is ambiguous", async () => {
    const root = await makeRoot()
    const exit = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      const submitted = yield* service.submitDocument({ markdown: "same\nsame\n" })
      return yield* Effect.exit(service.addComment({
        documentId: submitted.document.id,
        content: "ambiguous source",
        anchor: {
          revisionId: submitted.revision!.id,
          plane: "rendered-text-v1",
          range: { start: 5, end: 9 },
          quote: { exact: "same", prefix: "", suffix: "" },
          source: { startUtf16: 5, endUtf16: 9, startLine: 2, endLine: 2 },
        },
      }))
    }))

    expect(exit._tag).toBe("Failure")
  })

  it("supports legacy comments without anchors", async () => {
    const root = await makeRoot()
    const comments = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      const submitted = yield* service.submitDocument({ markdown: "# A" })
      yield* service.addComment({ documentId: submitted.document.id, content: "legacy", location: { sectionIndex: 0, sectionType: "markdown", selectedText: "A", contextBefore: "", contextAfter: "" } })
      return yield* service.listComments(submitted.document.id)
    }))

    expect(comments[0]?.anchor).toBeUndefined()
    expect(comments[0]?.location).toMatchObject({ selectedText: "A" })
  })

  it("redelivers feedback until it is explicitly acknowledged", async () => {
    const root = await makeRoot()
    const result = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      const submitted = yield* service.submitDocument({ markdown: "# Feedback" })
      yield* service.addComment({ documentId: submitted.document.id, content: "one" })
      yield* service.addComment({ documentId: submitted.document.id, content: "two" })
      const first = yield* service.waitForFeedback(submitted.document.id, Duration.zero)
      const repeated = yield* service.waitForFeedback(submitted.document.id, Duration.zero)
      yield* service.acknowledgeFeedback(submitted.document.id, first.lastSeq)
      const empty = yield* service.waitForFeedback(submitted.document.id, Duration.zero)
      const fiber = yield* service.waitForFeedback(submitted.document.id, Duration.seconds(1)).pipe(Effect.forkChild)
      yield* service.addComment({ documentId: submitted.document.id, content: "three" })
      const waited = yield* Fiber.join(fiber)
      return { first, repeated, empty, waited }
    }))

    expect(result.first.comments.map((comment) => comment.content)).toEqual(["one", "two"])
    expect(result.first.lastSeq).toBe(2)
    expect(result.repeated.comments.map((comment) => comment.content)).toEqual(["one", "two"])
    expect(result.empty).toMatchObject({ comments: [], lastSeq: 2, timedOut: true })
    expect(result.waited.comments.map((comment) => comment.content)).toEqual(["three"])
    expect(result.waited.lastSeq).toBe(3)
    expect(result.waited.timedOut).toBe(false)
  })

  it("delivers comment edits after acknowledgement", async () => {
    const root = await makeRoot()
    const result = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      const submitted = yield* service.submitDocument({ markdown: "# Feedback" })
      const comment = yield* service.addComment({ documentId: submitted.document.id, content: "original" })
      yield* service.acknowledgeFeedback(submitted.document.id, comment.seq)
      const edited = yield* service.updateComment({ documentId: submitted.document.id, commentId: comment.id, content: "edited" })
      const feedback = yield* service.waitForFeedback(submitted.document.id, Duration.zero)
      return { edited, feedback }
    }))

    expect(result.edited.seq).toBeGreaterThan(1)
    expect(result.feedback.comments.map((comment) => comment.content)).toEqual(["edited"])
    expect(result.feedback.lastSeq).toBe(result.edited.seq)
  })

  it("keeps waiting through status-only comment events", async () => {
    const root = await makeRoot()
    const result = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      const submitted = yield* service.submitDocument({ markdown: "# Feedback" })
      const comment = yield* service.addComment({ documentId: submitted.document.id, content: "original" })
      yield* service.acknowledgeFeedback(submitted.document.id, comment.seq)
      const fiber = yield* service.waitForFeedback(submitted.document.id, Duration.seconds(1)).pipe(Effect.forkChild)
      yield* service.updateComment({ documentId: submitted.document.id, commentId: comment.id, status: "resolved" })
      yield* service.addComment({ documentId: submitted.document.id, content: "new feedback" })
      return yield* Fiber.join(fiber)
    }))

    expect(result.comments.map((comment) => comment.content)).toEqual(["new feedback"])
    expect(result.timedOut).toBe(false)
  })

  it("clears resolvedAt when reopening a resolved comment", async () => {
    const root = await makeRoot()
    const result = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      const submitted = yield* service.submitDocument({ markdown: "# Comment" })
      const comment = yield* service.addComment({ documentId: submitted.document.id, content: "review" })
      const resolved = yield* service.updateComment({ documentId: submitted.document.id, commentId: comment.id, status: "resolved" })
      const reopened = yield* service.updateComment({ documentId: submitted.document.id, commentId: comment.id, status: "open" })
      return { resolved, reopened }
    }))

    expect(result.resolved.resolvedAt).toBeDefined()
    expect(result.reopened.resolvedAt).toBeUndefined()
  })

  it("does not mutate state when anchor validation fails", async () => {
    const root = await makeRoot()
    const result = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      const submitted = yield* service.submitDocument({ markdown: "hello" })
      const bad: CommentAnchor = { revisionId: submitted.revision!.id, plane: "rendered-text-v1", range: { start: 0, end: 5 }, quote: { exact: "nope", prefix: "", suffix: "" }, source: { startUtf16: 0, endUtf16: 5, startLine: 1, endLine: 1 } }
      const exit = yield* Effect.exit(service.addComment({ documentId: submitted.document.id, content: "bad", anchor: bad }))
      const comments = yield* service.listComments(submitted.document.id)
      return { exit, comments }
    }))

    expect(result.exit._tag).toBe("Failure")
    if (result.exit._tag === "Failure") expect(String(result.exit.cause)).toContain(DocumentReviewInvalidAnchor.name)
    expect(result.comments).toEqual([])
  })

  it("retains the current revision and twenty previous revisions", async () => {
    const root = await makeRoot()
    const revisions = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      const submitted = yield* service.submitDocument({ markdown: "# Bounded" })
      for (let version = 2; version <= 26; version++) {
        yield* service.reviseDocument(submitted.document.id, `# Bounded\n${version}`)
      }
      return yield* service.listRevisions(submitted.document.id)
    }))

    expect(revisions).toHaveLength(21)
    expect(revisions.map((revision) => revision.number)).toEqual(Array.from({ length: 21 }, (_, index) => index + 6))
    expect(revisions[0]?.parentRevisionId).toBeUndefined()
  })

  it("keeps revision retention bounded when comments reference old revisions", async () => {
    const root = await makeRoot()
    const result = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      const submitted = yield* service.submitDocument({ markdown: "# Anchored\norigin" })
      const originRevisionId = submitted.revision!.id
      yield* service.addComment({
        documentId: submitted.document.id,
        content: "keep origin",
        anchor: {
          revisionId: originRevisionId,
          plane: "rendered-text-v1",
          range: { start: 0, end: 6 },
          quote: { exact: "origin", prefix: "", suffix: "" },
          source: { startUtf16: 11, endUtf16: 17, startLine: 2, endLine: 2 },
        },
      })
      for (let version = 2; version <= 26; version++) {
        yield* service.reviseDocument(submitted.document.id, `# Anchored\nversion ${version}`)
      }
      return yield* service.listRevisions(submitted.document.id)
    }))

    expect(result).toHaveLength(21)
    expect(result.map((revision) => revision.number)).toEqual(Array.from({ length: 21 }, (_, index) => index + 6))
    expect(result[0]?.parentRevisionId).toBeUndefined()
  })

  it("serializes concurrent mutations without losing revisions", async () => {
    const root = await makeRoot()
    const revisions = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      yield* service.submitDocument({ markdown: "# A\n0", sourcePath: "/a.md" })
      yield* Effect.all([
        service.submitDocument({ markdown: "# A\n1", sourcePath: "/a.md" }),
        service.submitDocument({ markdown: "# A\n2", sourcePath: "/a.md" }),
        service.submitDocument({ markdown: "# A\n3", sourcePath: "/a.md" }),
      ], { concurrency: "unbounded" })
      const docs = yield* service.listDocuments()
      return yield* service.listRevisions(docs[0]!.id)
    }))

    expect(revisions.map((revision) => revision.number)).toEqual([1, 2, 3, 4])
  })

  it("persists publication receipts across service restarts", async () => {
    const root = await makeRoot()
    const created = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      const submitted = yield* service.submitDocument({ markdown: "# Published" })
      const publication = receipt({ publishedRevisionId: submitted.revision!.id })
      const updated = yield* service.setPublicationReceipt(submitted.document.id, publication)
      const receipts = yield* service.listPublicationReceipts()
      return { documentId: submitted.document.id, updated, receipts, publication }
    }))

    expect(created.updated.publication).toEqual(created.publication)
    expect(created.receipts).toEqual([{ documentId: created.documentId, publication: created.publication }])

    const restarted = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      return {
        doc: yield* service.getDocument(created.documentId),
        receipts: yield* service.listPublicationReceipts(),
      }
    }))

    expect(restarted.doc.publication).toEqual(created.publication)
    expect(restarted.receipts).toEqual([{ documentId: created.documentId, publication: created.publication }])
  })

  it("preserves publication receipts across revision retention", async () => {
    const root = await makeRoot()
    const result = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      const submitted = yield* service.submitDocument({ markdown: "# Published" })
      const publication = receipt({ publishedRevisionId: submitted.revision!.id })
      yield* service.setPublicationReceipt(submitted.document.id, publication)
      for (let version = 2; version <= 26; version++) {
        yield* service.reviseDocument(submitted.document.id, `# Published\n${version}`)
      }
      return {
        document: yield* service.getDocument(submitted.document.id),
        revisions: yield* service.listRevisions(submitted.document.id),
      }
    }))

    expect(result.revisions).toHaveLength(21)
    expect(result.document.publication?.publishedRevisionId).toBe("id-2")
    expect(result.document.publication?.url).toBe("https://example.com/doc")
  })

  it("updates publication receipt status without changing document revision metadata", async () => {
    const root = await makeRoot()
    const result = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      const submitted = yield* service.submitDocument({ markdown: "# Published" })
      const before = yield* service.getDocument(submitted.document.id)
      const first = receipt({ publishedRevisionId: submitted.revision!.id, remoteStatus: "published", checkedAt: "check-1" })
      yield* service.setPublicationReceipt(submitted.document.id, first)
      const second = { ...first, remoteStatus: "missing" as const, checkedAt: "check-2" }
      const updated = yield* service.setPublicationReceipt(submitted.document.id, second)
      return { before, updated, after: yield* service.getDocument(submitted.document.id) }
    }))

    expect(result.updated.publication?.remoteStatus).toBe("missing")
    expect(result.updated.publication?.checkedAt).toBe("check-2")
    expect(result.after.updatedAt).toBe(result.before.updatedAt)
    expect(result.after.currentRevisionId).toBe(result.before.currentRevisionId)
    expect(result.after.version).toBe(result.before.version)
  })

  it("only conditionally clears matching publication receipts", async () => {
    const root = await makeRoot()
    const result = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      const submitted = yield* service.submitDocument({ markdown: "# Published" })
      const older = receipt({ exportedAt: "older", publishedRevisionId: submitted.revision!.id })
      const newer = { ...older, exportedAt: "newer" }
      yield* service.setPublicationReceipt(submitted.document.id, older)
      yield* service.setPublicationReceipt(submitted.document.id, newer)
      const skipped = yield* service.clearPublicationReceipt(submitted.document.id, "older")
      const afterSkipped = yield* service.getDocument(submitted.document.id)
      const cleared = yield* service.clearPublicationReceipt(submitted.document.id, "newer")
      const afterCleared = yield* service.getDocument(submitted.document.id)
      return { skipped, afterSkipped, cleared, afterCleared }
    }))

    expect(result.skipped).toBe(false)
    expect(result.afterSkipped.publication?.exportedAt).toBe("newer")
    expect(result.cleared).toBe(true)
    expect(result.afterCleared.publication).toBeUndefined()
  })

  it("moves duplicate publication URL ownership to the most recent document", async () => {
    const root = await makeRoot()
    const result = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      const first = yield* service.submitDocument({ markdown: "# First" })
      const second = yield* service.submitDocument({ markdown: "# Second" })
      yield* service.setPublicationReceipt(first.document.id, receipt({ slug: "first", publishedRevisionId: first.revision!.id }))
      const secondReceipt = receipt({ slug: "second", publishedRevisionId: second.revision!.id })
      yield* service.setPublicationReceipt(second.document.id, secondReceipt)
      return {
        first: yield* service.getDocument(first.document.id),
        second: yield* service.getDocument(second.document.id),
        receipts: yield* service.listPublicationReceipts(),
      }
    }))

    expect(result.first.publication).toBeUndefined()
    expect(result.second.publication?.slug).toBe("second")
    expect(result.receipts).toHaveLength(1)
    expect(result.receipts[0]?.documentId).toBe(result.second.id)
  })

  it("loads V2 stores without publication receipts", async () => {
    const root = await makeRoot()
    await writeFile(
      join(root, "store.json"),
      JSON.stringify({
        schemaVersion: 2,
        documents: [{ id: "doc-old-v2", title: "Old V2", markdown: "# Old V2", createdAt: "created", updatedAt: "updated", version: 1, currentRevisionId: "rev-old-v2" }],
        revisions: { "doc-old-v2": [{ id: "rev-old-v2", number: 1, documentId: "doc-old-v2", title: "Old V2", markdown: "# Old V2", contentHash: "hash", createdAt: "created" }] },
        comments: {},
      }),
    )

    const result = await run(root, Effect.gen(function*() {
      const service = yield* DocumentReviews.Service
      return { doc: yield* service.getDocument("doc-old-v2"), receipts: yield* service.listPublicationReceipts() }
    }))

    expect(result.doc.publication).toBeUndefined()
    expect(result.receipts).toEqual([])
  })
})

import { describe, expect, it } from "vitest"
import {
  createPublishedAnnotation,
  deletePublishedAnnotation,
  exportPublishedDocumentMarkdown,
  formatPublishedFeedbackMarkdown,
  listPublishedAnnotations,
  loadPublishedAnnotations,
  publishedAnnotationsStorageKey,
  publishedSnapshotRevisionId,
  savePublishedAnnotations,
  serializePublishedAnnotations,
  updatePublishedAnnotation,
  type PublishedAnnotation,
  type PublishedAnnotationInput,
  type PublishedAnnotationStorage,
  type PublishedSnapshotIdentity,
} from "../src/lib/published-annotations"

const snapshot: PublishedSnapshotIdentity = {
  slug: "public-demo",
  exportedAt: "2026-07-05T12:00:00.000Z",
}

const input = (overrides: Partial<PublishedAnnotationInput> = {}): PublishedAnnotationInput => ({
  id: "annotation-1",
  anchor: {
    sectionIndex: 1,
    sectionTitle: "Details",
    selectedText: "A selected sentence.",
    contextBefore: "Before ",
    contextAfter: " After",
    renderedRange: { start: 7, end: 27 },
  },
  content: "Please clarify this.",
  createdAt: "2026-07-05T12:01:00.000Z",
  ...overrides,
})

class MemoryStorage implements PublishedAnnotationStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

describe("published annotations", () => {
  it("isolates annotations by immutable published snapshot identity", () => {
    const annotations = createPublishedAnnotation([], input())
    const serialized = serializePublishedAnnotations(snapshot, annotations)
    const republished = { ...snapshot, exportedAt: "2026-07-05T12:02:00.000Z" }
    const otherSlug = { ...snapshot, slug: "other-demo" }

    expect(listPublishedAnnotations(snapshot, serialized)).toEqual(annotations)
    expect(listPublishedAnnotations(republished, serialized)).toEqual([])
    expect(listPublishedAnnotations(otherSlug, serialized)).toEqual([])
    expect(publishedAnnotationsStorageKey(republished)).not.toBe(publishedAnnotationsStorageKey(snapshot))
    expect(publishedAnnotationsStorageKey(otherSlug)).not.toBe(publishedAnnotationsStorageKey(snapshot))
    expect(publishedSnapshotRevisionId(republished)).not.toBe(publishedSnapshotRevisionId(snapshot))
    expect(publishedSnapshotRevisionId(otherSlug)).not.toBe(publishedSnapshotRevisionId(snapshot))
  })

  it("parses malformed and unsupported storage defensively", () => {
    const malformedEntries = [
      "not json",
      "null",
      JSON.stringify({ version: 2, snapshot, annotations: [] }),
      JSON.stringify({ version: 1, snapshot, annotations: "nope" }),
      JSON.stringify({ version: 1, snapshot: { slug: snapshot.slug }, annotations: [] }),
    ]

    for (const serialized of malformedEntries) {
      expect(listPublishedAnnotations(snapshot, serialized)).toEqual([])
    }

    const valid = createPublishedAnnotation([], input())
    const mixed = JSON.parse(serializePublishedAnnotations(snapshot, valid)) as { annotations: Array<unknown> }
    mixed.annotations.push(
      { ...valid[0], id: "" },
      { ...valid[0], id: "bad-date", createdAt: "yesterday" },
      { ...valid[0], id: "bad-anchor", anchor: { selectedText: "quote", sectionIndex: -1 } },
      { ...valid[0], id: "bad-range", anchor: { ...valid[0].anchor, renderedRange: { start: 8, end: 7 } } },
    )
    expect(listPublishedAnnotations(snapshot, JSON.stringify(mixed))).toEqual(valid)
  })

  it("creates, updates, deletes, and round-trips annotations", () => {
    const created = createPublishedAnnotation([], input())
    expect(created).toEqual([{ ...input(), updatedAt: input().createdAt }])
    expect(createPublishedAnnotation(created, input())).toEqual(created)

    const updated = updatePublishedAnnotation(created, "annotation-1", {
      content: "This is clearer now.",
      updatedAt: "2026-07-05T12:03:00.000Z",
    })
    expect(updated[0]).toMatchObject({
      id: "annotation-1",
      content: "This is clearer now.",
      createdAt: "2026-07-05T12:01:00.000Z",
      updatedAt: "2026-07-05T12:03:00.000Z",
    })
    expect(updatePublishedAnnotation(updated, "missing", {
      content: "Ignored",
      updatedAt: "2026-07-05T12:04:00.000Z",
    })).toEqual(updated)
    expect(deletePublishedAnnotation(updated, "annotation-1")).toEqual([])
    expect(listPublishedAnnotations(snapshot, serializePublishedAnnotations(snapshot, updated))).toEqual(updated)
  })

  it("orders annotations by creation time and then stable ID", () => {
    const annotations = [
      createPublishedAnnotation([], input({ id: "z", createdAt: "2026-07-05T12:02:00.000Z" }))[0],
      createPublishedAnnotation([], input({ id: "b", createdAt: "2026-07-05T12:01:00.000Z" }))[0],
      createPublishedAnnotation([], input({ id: "a", createdAt: "2026-07-05T12:01:00.000Z" }))[0],
    ] as ReadonlyArray<PublishedAnnotation>

    expect(listPublishedAnnotations(snapshot, serializePublishedAnnotations(snapshot, annotations)).map(({ id }) => id))
      .toEqual(["a", "b", "z"])
  })

  it("tolerates unavailable, throwing, and quota-failing localStorage", () => {
    const storage = new MemoryStorage()
    const annotations = createPublishedAnnotation([], input())

    expect(savePublishedAnnotations(snapshot, annotations, storage)).toBe(true)
    expect(loadPublishedAnnotations(snapshot, storage)).toEqual(annotations)
    expect(savePublishedAnnotations(snapshot, [], storage)).toBe(true)
    expect(storage.values.size).toBe(0)
    expect(loadPublishedAnnotations(snapshot, null)).toEqual([])
    expect(savePublishedAnnotations(snapshot, annotations, null)).toBe(false)

    const throwingStorage: PublishedAnnotationStorage = {
      getItem: () => { throw new DOMException("Denied", "SecurityError") },
      setItem: () => { throw new DOMException("Full", "QuotaExceededError") },
      removeItem: () => { throw new DOMException("Denied", "SecurityError") },
    }
    expect(loadPublishedAnnotations(snapshot, throwingStorage)).toEqual([])
    expect(savePublishedAnnotations(snapshot, annotations, throwingStorage)).toBe(false)
  })
})

describe("published annotation Markdown exports", () => {
  it("formats deterministic, readable feedback and safely escapes headings", () => {
    const annotations = createPublishedAnnotation(
      createPublishedAnnotation([], input({
        id: "later",
        anchor: {
          sectionIndex: 2,
          sectionTitle: "API [draft]\n# unsafe <tag>",
          selectedText: "first line\n\n> quoted line",
        },
        content: "Check **both** cases.\nThen revise.",
        createdAt: "2026-07-05T12:02:00.000Z",
      })),
      input({ id: "earlier", anchor: { sectionIndex: 0, selectedText: "Intro" } }),
    )

    expect(formatPublishedFeedbackMarkdown({
      title: "Demo [draft]\n# private <notes>",
      publicUrl: "https://behold.test/published/public demo\nignored",
      annotations,
    })).toBe(`# Feedback on Demo \\[draft\\] \\# private &lt;notes&gt;

Source: <https://behold.test/published/public%20demoignored>

## 1. Section 1

**Selected quote**

> Intro

**Comment**

> Please clarify this.

## 2. API \\[draft\\] \\# unsafe &lt;tag&gt;

**Selected quote**

> first line
>
> > quoted line

**Comment**

> Check **both** cases.
> Then revise.
`)
  })

  it("formats empty feedback", () => {
    expect(formatPublishedFeedbackMarkdown({
      title: "Demo",
      publicUrl: "https://behold.test/published/demo",
      annotations: [],
    })).toBe(`# Feedback on Demo

Source: <https://behold.test/published/demo>

_No annotations._
`)
  })

  it("returns the original snapshot Markdown without annotations or normalization", () => {
    const markdown = "# Demo\r\n\r\nOriginal text.  \r\n"
    expect(exportPublishedDocumentMarkdown({ markdown })).toBe(markdown)
  })
})

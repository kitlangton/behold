import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { decodePublishedDocumentSnapshot, type PublishedDocumentSnapshot } from "../src/lib/document-viewer"
import { preparePublishedSnapshot } from "../src/lib/published"

const baseSnapshot = (): PublishedDocumentSnapshot => ({
  slug: "demo",
  title: "Demo",
  markdown: "# Demo\n\n```text\n+------+\\n| doc |\\n+------+\n```",
  exportedAt: "2026-07-04T00:00:00.000Z",
  sourceDocumentId: "doc-1",
  sourcePath: "/Users/example/project/demo.md",
  document: {
    sections: [{ _tag: "markdown", markdown: "# Demo\n\nHello" }],
  },
})

describe("preparePublishedSnapshot", () => {
  it("redacts the local document source path", () => {
    const published = preparePublishedSnapshot(baseSnapshot())

    expect(published.sourcePath).toBeUndefined()
    expect(published.sourceDocumentId).toBeUndefined()
    expect(published.document.sections).toEqual([{ _tag: "markdown", markdown: "# Demo\n\nHello" }])
  })
})

describe("published snapshot boundary schema", () => {
  it("decodes markdown-only snapshots", async () => {
    const jsonRoundTripped = JSON.parse(JSON.stringify(preparePublishedSnapshot(baseSnapshot())))
    const decoded = await Effect.runPromise(decodePublishedDocumentSnapshot(jsonRoundTripped))

    expect(decoded.sourcePath).toBeUndefined()
    expect(decoded.document.sections).toEqual([{ _tag: "markdown", markdown: "# Demo\n\nHello" }])
  })

  it("filters legacy code-reference sections when decoding old snapshots", async () => {
    const legacy = {
      ...JSON.parse(JSON.stringify(preparePublishedSnapshot(baseSnapshot()))),
      document: {
        codeReferenceCount: 1,
        loadedReferenceCount: 1,
        failedReferenceCount: 0,
        sections: [
          { _tag: "markdown", markdown: "# Demo" },
          { _tag: "code-reference", displayPath: "old.ts", fullSource: "const old = true" },
        ],
      },
    }
    const decoded = await Effect.runPromise(decodePublishedDocumentSnapshot(legacy))

    expect(decoded.document.sections).toEqual([{ _tag: "markdown", markdown: "# Demo" }])
  })

  it("rejects malformed fields at the exported schema helper", async () => {
    const malformed = { ...JSON.parse(JSON.stringify(preparePublishedSnapshot(baseSnapshot()))), exportedAt: 123 }

    await expect(Effect.runPromise(decodePublishedDocumentSnapshot(malformed))).rejects.toMatchObject({
      _tag: "DocumentViewerBoundaryError",
      kind: "schema",
    })
  })
})

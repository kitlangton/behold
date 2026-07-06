// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import { buildCommentAnchor, resolveCommentRange } from "../src/lib/comment-anchors"
import type { DocumentComment } from "../src/lib/document-viewer"

const select = (element: HTMLElement, node: Text, start: number, end: number) => {
  const range = element.ownerDocument.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  return range
}

describe("comment anchors", () => {
  it("restores the selected duplicate by immutable rendered-text offsets", () => {
    const element = document.createElement("div")
    element.dataset.sectionIndex = "0"
    element.append("same then same")
    const node = element.firstChild as Text
    const created = buildCommentAnchor(element, select(element, node, 10, 14), "revision-1", "same then same")
    expect(created?.anchor.range).toEqual({ start: 10, end: 14 })

    const comment: DocumentComment = {
      id: "comment-1",
      seq: 1,
      createdAt: "now",
      updatedAt: "now",
      content: "second occurrence",
      status: "open",
      location: created!.location,
      anchor: created!.anchor,
    }
    expect(resolveCommentRange(element, comment, "revision-1")?.toString()).toBe("same")
    expect(resolveCommentRange(element, comment, "revision-1")?.startOffset).toBe(10)
  })

  it("does not guess when a quote becomes ambiguous on another revision", () => {
    const element = document.createElement("div")
    element.append("same same")
    const comment: DocumentComment = {
      id: "comment-1",
      seq: 1,
      createdAt: "now",
      updatedAt: "now",
      content: "ambiguous",
      status: "open",
      location: { sectionIndex: 0, sectionType: "markdown", selectedText: "same", contextBefore: "", contextAfter: "" },
      anchor: {
        revisionId: "revision-1",
        plane: "rendered-text-v1",
        range: { start: 0, end: 4 },
        quote: { exact: "same", prefix: "", suffix: "" },
      },
    }
    expect(resolveCommentRange(element, comment, "revision-2")).toBeNull()
  })

  it("relocates a duplicate when one side of its quote context remains unique", () => {
    const element = document.createElement("div")
    element.append("first same second same changed suffix")
    const comment: DocumentComment = {
      id: "comment-1",
      seq: 1,
      createdAt: "now",
      updatedAt: "now",
      content: "second occurrence",
      status: "open",
      location: { sectionIndex: 0, sectionType: "markdown", selectedText: "same", contextBefore: "first same second ", contextAfter: " old suffix" },
      anchor: {
        revisionId: "revision-1",
        plane: "rendered-text-v1",
        range: { start: 18, end: 22 },
        quote: { exact: "same", prefix: "first same second ", suffix: " old suffix" },
      },
    }
    expect(resolveCommentRange(element, comment, "revision-2")?.startOffset).toBe(18)
  })

  it("records exact markdown source lines only for an unambiguous source quote", () => {
    const element = document.createElement("div")
    element.append("target")
    const node = element.firstChild as Text
    const unique = buildCommentAnchor(element, select(element, node, 0, 6), "revision-1", "# Heading\n\ntarget\n")
    const duplicate = buildCommentAnchor(element, select(element, node, 0, 6), "revision-1", "target\ntarget\n")

    expect(unique?.anchor.source).toMatchObject({ startUtf16: 11, endUtf16: 17, startLine: 3, endLine: 3 })
    expect(duplicate?.anchor.source).toBeUndefined()
  })
})

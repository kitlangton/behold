// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import App, { BeholdWordmark, CommentPopover, DocumentLoadState, MermaidZoomOverlay, RailContent, type RailProps } from "./App"
import * as documentViewer from "./lib/document-viewer"
import { publishedAnnotationsStorageKey } from "./lib/published-annotations"
import type { PublishedDocumentSnapshot } from "./lib/published"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  window.history.replaceState(null, "", "/")
})

describe("BeholdWordmark", () => {
  it("blinks when the eye is clicked", () => {
    vi.useFakeTimers()
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1)
    render(() => <BeholdWordmark />)

    const eye = screen.getByRole("button", { name: "Blink Behold eye" })
    fireEvent.click(eye)
    expect(eye.classList.contains("wordmark-eye-blinking")).toBe(true)

    vi.advanceTimersByTime(140)
    expect(eye.classList.contains("wordmark-eye-blinking")).toBe(false)
  })
})

describe("DocumentLoadState", () => {
  it("shows source loading before rendering state", () => {
    render(() => (
      <DocumentLoadState
        sourceLoading={true}
        sourceError=""
        rendering={true}
        hasDocument={false}
        editorOpen={false}
        hasSections={false}
      />
    ))

    expect(screen.getByText("Loading document…")).toBeTruthy()
    expect(screen.queryByText("Rendering…")).toBeNull()
  })

  it("announces source errors instead of an empty-document message", () => {
    render(() => (
      <DocumentLoadState
        sourceLoading={false}
        sourceError="Unable to load published snapshot."
        rendering={false}
        hasDocument={false}
        editorOpen={false}
        hasSections={false}
      />
    ))

    expect(screen.getByRole("alert").textContent).toBe("Unable to load published snapshot.")
    expect(screen.queryByText("Nothing to render yet.")).toBeNull()
  })
})

describe("RailContent", () => {
  const renderRail = (overrides: Partial<RailProps> = {}) => {
    const props: RailProps = {
      isPublishedView: false,
      publishedTitle: "",
      publishedSlug: "",
      publishStatus: "",
      publication: null,
      publishing: false,
      hasDocument: true,
      canPublish: true,
      recentDocuments: [
        { id: "active", title: "Active document", createdAt: "2026-07-04T12:00:00.000Z", updatedAt: "2026-07-05T12:00:00.000Z", url: "/?doc=active", version: 2, currentRevisionId: "revision-2" },
        { id: "other", title: "Other document", createdAt: "2026-07-03T12:00:00.000Z", updatedAt: "2026-07-03T12:00:00.000Z", url: "/?doc=other", version: 1, currentRevisionId: "other-revision" },
      ],
      activeDocumentId: "active",
      revisions: [
        { id: "revision-1", revisionId: "revision-1", version: 1, title: "Active document", createdAt: "2026-07-04T12:00:00.000Z" },
        { id: "revision-2", revisionId: "revision-2", version: 2, title: "Active document", createdAt: "2026-07-05T12:00:00.000Z", parentRevisionId: "revision-1" },
      ],
      displayedRevisionId: "revision-2",
      currentRevisionId: "revision-2",
      diffView: false,
      comments: [],
      activeCommentId: null,
      clearingComments: false,
      deletingDocument: false,
      sourceStatus: "",
      editorOpen: false,
      headings: [],
      showActions: true,
      hasPublishedSnapshot: false,
      onPublish: vi.fn(),
      onUnpublish: vi.fn(),
      onCopyAnnotations: vi.fn(),
      onCopyMarkdown: vi.fn(),
      onClearComments: vi.fn(),
      onDeleteDocument: vi.fn(),
      onViewRevision: vi.fn(),
      onViewDiff: vi.fn(),
      onCommentHover: vi.fn(),
      onCommentEdit: vi.fn(),
      ...overrides,
    }
    render(() => <RailContent {...props} />)
    return props
  }

  it("collapses documents by default and limits deletion to the active document", () => {
    const props = renderRail()

    expect(screen.queryByText("Actions")).toBeNull()
    const documents = document.querySelector("details.rail-docs") as HTMLDetailsElement
    expect(documents.open).toBe(false)
    fireEvent.click(screen.getByText("Documents"))
    expect(documents.open).toBe(true)
    expect(screen.getByRole("link", { name: "Active document" }).getAttribute("aria-current")).toBe("page")
    expect(screen.getAllByRole("button", { name: /^Delete / })).toHaveLength(1)

    fireEvent.click(screen.getByRole("button", { name: "Delete Active document" }))
    expect(props.onDeleteDocument).toHaveBeenCalledOnce()
  })

  it("places the outline before document controls", () => {
    renderRail({
      headings: [
        { id: "overview", text: "Overview", depth: 1 },
        { id: "details", text: "Details", depth: 2 },
      ],
    })

    const outline = screen.getByRole("navigation", { name: "Document outline" })
    const documents = document.querySelector("details.rail-docs") as HTMLDetailsElement
    expect(outline.compareDocumentPosition(documents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("shows compact relative revision dates and opens a revision from the whole row", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-05T12:30:00.000Z"))
    const props = renderRail()

    expect(screen.queryByText("Current")).toBeNull()
    expect(screen.queryByText("Changes")).toBeNull()
    expect(screen.getByText("30m ago")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /v2.*30m ago/ }))
    expect(props.onViewRevision).toHaveBeenCalledWith(props.revisions[1])
  })

  it("hides history when the document has only one revision", () => {
    renderRail({ revisions: [{ id: "revision-1", revisionId: "revision-1", version: 1, title: "Active document", createdAt: "2026-07-05T12:00:00.000Z" }] })

    expect(screen.queryByText("History")).toBeNull()
  })

  it("offers compact exports and local notes in published view", () => {
    const comment: documentViewer.DocumentComment = {
      id: "annotation-1",
      createdAt: "2026-07-05T12:00:00.000Z",
      updatedAt: "2026-07-05T12:00:00.000Z",
      content: "Local note",
      status: "open",
      seq: 1,
      location: { sectionIndex: 0, sectionType: "markdown", selectedText: "Selected text", contextBefore: "", contextAfter: "" },
    }
    const props = renderRail({
      isPublishedView: true,
      publishedTitle: "Public Demo",
      publishedSlug: "public-demo",
      hasPublishedSnapshot: true,
      activeDocumentId: "",
      revisions: [],
      comments: [comment],
    })

    fireEvent.click(screen.getByRole("button", { name: "Copy annotations" }))
    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }))
    fireEvent.click(screen.getByRole("button", { name: /Local note/ }))

    expect(props.onCopyAnnotations).toHaveBeenCalledOnce()
    expect(props.onCopyMarkdown).toHaveBeenCalledOnce()
    expect(props.onCommentEdit).toHaveBeenCalledWith("annotation-1")
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull()
  })

  it("shows open and unpublish controls for a current public copy", () => {
    const props = renderRail({
      publication: {
        slug: "active-document",
        url: "https://behold.example/published/active-document",
        exportedAt: "2026-07-05T12:00:00.000Z",
        publishedRevisionId: "revision-2",
        remoteStatus: "published",
        checkedAt: "2026-07-05T12:01:00.000Z",
      },
    })

    expect(screen.getByText("Current version is public")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe("https://behold.example/published/active-document")
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }))
    expect(props.onUnpublish).toHaveBeenCalledOnce()
  })

  it("offers update, republish, and retry from reconciled publication state", () => {
    const receipt: documentViewer.PublicationReceipt = {
      slug: "active-document",
      url: "https://behold.example/published/active-document",
      exportedAt: "2026-07-05T12:00:00.000Z",
      publishedRevisionId: "revision-1",
      remoteStatus: "published",
      checkedAt: "2026-07-05T12:01:00.000Z",
    }
    const update = renderRail({ publication: receipt })
    fireEvent.click(screen.getByRole("button", { name: "Update" }))
    expect(update.onPublish).toHaveBeenCalledOnce()
    cleanup()

    renderRail({ publication: { ...receipt, remoteStatus: "missing" } })
    expect(screen.getByRole("button", { name: "Republish" })).toBeTruthy()
    expect(screen.getByText("Remote copy missing")).toBeTruthy()
    cleanup()

    renderRail({ publication: { ...receipt, publishedRevisionId: "revision-2", remoteStatus: "unavailable" } })
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy()
    expect(screen.getByText("Remote status unavailable")).toBeTruthy()
  })
})

describe("CommentPopover", () => {
  it("prefills an existing annotation and only saves changed content", () => {
    const onSave = vi.fn()
    render(() => (
      <CommentPopover
        pending={{
          commentId: "comment-1",
          initialText: "Existing annotation",
          sectionLabel: "Section 1",
          rect: { top: 0, bottom: 20, left: 0, width: 120 },
          location: {
            sectionIndex: 0,
            sectionType: "markdown",
            selectedText: "selected text",
            contextBefore: "",
            contextAfter: "",
          },
        }}
        saving={false}
        onSave={onSave}
        onCancel={() => undefined}
      />
    ))

    const textarea = screen.getByRole("textbox", { name: "Add annotation" })
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement
    expect((textarea as HTMLTextAreaElement).value).toBe("Existing annotation")
    expect(save.disabled).toBe(true)

    fireEvent.input(textarea, { target: { value: "Updated annotation" } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    expect(onSave).toHaveBeenCalledWith("Updated annotation")
  })

  it("offers a quiet delete action only for an editable local annotation", () => {
    const onDelete = vi.fn()
    render(() => (
      <CommentPopover
        pending={{
          commentId: "annotation-1",
          initialText: "Existing annotation",
          sectionLabel: "Section 1",
          rect: { top: 0, bottom: 20, left: 0, width: 120 },
          location: { sectionIndex: 0, sectionType: "markdown", selectedText: "selected text", contextBefore: "", contextAfter: "" },
        }}
        saving={false}
        onSave={() => undefined}
        onCancel={() => undefined}
        onDelete={onDelete}
      />
    ))

    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    expect(onDelete).toHaveBeenCalledOnce()
  })
})

const publishedSnapshot: PublishedDocumentSnapshot = {
  slug: "public-demo",
  title: "Public Demo",
  markdown: "# Public Demo\n\nSelect this sentence.\n",
  exportedAt: "2026-07-05T12:00:00.000Z",
  document: { sections: [{ _tag: "markdown", markdown: "# Public Demo\n\nSelect this sentence.\n" }] },
}

const installLandingAppEnvironment = () => {
  window.history.replaceState(null, "", "/")
  vi.spyOn(documentViewer, "runDocumentViewerPromise").mockRejectedValue(new Error("Local document API unavailable"))
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1)
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined)
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined)
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } })
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal("EventSource", class {
    addEventListener() {}
    removeEventListener() {}
    close() {}
  })
}

const installPublishedAppEnvironment = () => {
  window.history.replaceState(null, "", "/published/public-demo")
  const stored = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  })
  vi.spyOn(documentViewer, "runDocumentViewerPromise").mockResolvedValue(publishedSnapshot as never)
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1)
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined)
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined)
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } })
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    disconnect() {}
  })
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: 20, bottom: 36, left: 40, right: 180, width: 140, height: 16, x: 40, y: 20, toJSON: () => ({}) }),
  })
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [{ top: 20, bottom: 36, left: 40, right: 180, width: 140, height: 16, x: 40, y: 20, toJSON: () => ({}) }],
  })
}

describe("landing page", () => {
  it("shows one-command setup, rich product guidance, and copy actions", async () => {
    installLandingAppEnvironment()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    render(() => <App />)

    expect(await screen.findByRole("navigation", { name: "Document outline" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "Install" })).toBeTruthy()
    expect(document.querySelector(".timeline-block")).toBeTruthy()
    expect(document.querySelector(".definitions-block")).toBeTruthy()
    expect(document.querySelector(".shell-block")).toBeTruthy()
    expect(document.querySelector(".tree-block")).toBeTruthy()
    expect(document.querySelector(".diff-block")).toBeTruthy()
    expect(document.querySelector(".http-block")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull()

    fireEvent.click(screen.getAllByRole("button", { name: "Copy code" })[0])
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("bunx @kitlangton/behold setup"))

    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    expect(writeText.mock.calls[1]?.[0]).toContain("bunx @kitlangton/behold setup")
    expect(writeText.mock.calls[1]?.[0]).toContain("```timeline")
  })
})

describe("published snapshot annotations", () => {
  it("creates, edits, and deletes annotations locally without calling hosted comment APIs", async () => {
    installPublishedAppEnvironment()
    const createHostedComment = vi.spyOn(documentViewer, "createDocumentComment")
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001")
    render(() => <App />)

    const sentence = await screen.findByText("Select this sentence.")
    const text = sentence.firstChild
    if (!text) throw new Error("Missing rendered sentence text")
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, "Select this sentence.".length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.mouseUp(sentence.closest(".document-flow")!)
    fireEvent.click(screen.getByRole("button", { name: "Annotate" }))
    fireEvent.input(screen.getByRole("textbox", { name: "Add annotation" }), { target: { value: "Local note" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await screen.findByText("Local note")
    const storageKey = publishedAnnotationsStorageKey(publishedSnapshot)
    expect(window.localStorage.getItem(storageKey)).toContain("Local note")
    expect(createHostedComment).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: /Local note/ }))
    const editor = screen.getByRole("textbox", { name: "Add annotation" })
    fireEvent.input(editor, { target: { value: "Updated local note" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await screen.findByText("Updated local note")
    expect(window.localStorage.getItem(storageKey)).toContain("Updated local note")

    fireEvent.click(screen.getByRole("button", { name: /Updated local note/ }))
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    await waitFor(() => expect(screen.queryByRole("button", { name: /Updated local note/ })).toBeNull())
    expect(window.localStorage.getItem(storageKey)).toBeNull()
    expect(createHostedComment).not.toHaveBeenCalled()
  })

  it("copies truthful feedback and clean source Markdown", async () => {
    installPublishedAppEnvironment()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    render(() => <App />)

    await screen.findByText("Select this sentence.")
    const copyAnnotations = screen.getAllByRole("button", { name: "Copy annotations" })
    expect(copyAnnotations).toHaveLength(2)
    fireEvent.click(copyAnnotations[0])
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText).toHaveBeenLastCalledWith(`# Feedback on Public Demo

Source: <${window.location.href}>

_No annotations._
`)
    expect(await screen.findByText("Copied annotations with no notes.")).toBeTruthy()

    fireEvent.click(screen.getAllByRole("button", { name: "Copy Markdown" })[0])
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    expect(writeText).toHaveBeenLastCalledWith(publishedSnapshot.markdown)
    expect(await screen.findByText("Copied original Markdown.")).toBeTruthy()
  })
})

describe("MermaidZoomOverlay", () => {
  it("closes when the enlarged diagram is clicked and restores focus", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0)
      return 1
    })
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined)
    const trigger = document.createElement("button")
    document.body.append(trigger)
    trigger.focus()
    const onClose = vi.fn()

    render(() => (
      <MermaidZoomOverlay
        zoom={{
          svg: '<svg viewBox="0 0 100 50" aria-label="Example diagram"></svg>',
          origin: { top: 10, left: 10, width: 100, height: 50 },
        }}
        onClose={onClose}
      />
    ))

    const dialog = await screen.findByRole("dialog", { name: "Diagram preview" })
    const closeButton = screen.getByRole("button", { name: "Close diagram preview" })
    expect(dialog.getAttribute("aria-modal")).toBe("true")
    await waitFor(() => expect(document.activeElement).toBe(closeButton))

    fireEvent.click(screen.getByLabelText("Example diagram"))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    trigger.remove()
  })
})

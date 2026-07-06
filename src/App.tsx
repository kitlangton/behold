import { Dialog as KobalteDialog } from "@kobalte/core/dialog"
import { ToastRegion, showToast } from "./toast"
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js"
import { extractHeadings, hasFencedCode, hasMermaidFence, markdownInlineToText, renderMarkdownToHtml, type TocEntry } from "./lib/markdown"
import { initHighlighter } from "./lib/highlighter"
import {
  clearDocumentComments,
  createDocumentComment,
  deleteHostedDocument,
  diffDocumentRevisions,
  loadDocument,
  loadDocumentComments,
  loadDocumentRevision,
  loadDocumentRevisions,
  loadHostedDocument,
  loadPublishedDocumentSnapshot,
  loadRecentDocuments,
  loadRemoteMarkdown,
  publishDocumentSnapshot,
  runDocumentViewerPromise,
  updateDocumentCommentContent,
  type DocumentComment,
  type DocumentCommentAnchor,
  type DocumentCommentLocation,
  type DocumentRevision,
  type PublishRemoteResult,
  type RecentDocument,
  type RenderedDocument,
  type RenderedDocumentSection,
} from "./lib/document-viewer"
import { buildCommentAnchor, resolveCommentRange } from "./lib/comment-anchors"
import { preparePublishedSnapshot, type PublishedDocumentSnapshot } from "./lib/published"
import {
  createPublishedAnnotation,
  deletePublishedAnnotation,
  exportPublishedDocumentMarkdown,
  formatPublishedFeedbackMarkdown,
  loadPublishedAnnotations,
  publishedSnapshotRevisionId,
  savePublishedAnnotations,
  updatePublishedAnnotation,
  type PublishedAnnotation,
} from "./lib/published-annotations"

type MermaidRenderer = typeof import("beautiful-mermaid")["renderMermaidSVG"]

export interface PendingComment {
  readonly location: DocumentCommentLocation
  readonly anchor?: DocumentCommentAnchor
  readonly sectionLabel: string
  readonly rect: { top: number; bottom: number; left: number; width: number }
  readonly commentId?: string
  readonly initialText?: string
}

interface CommentHighlightRect {
  readonly commentId: string
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
}

export function BeholdWordmark() {
  const [blinking, setBlinking] = createSignal(false)
  let eye: SVGSVGElement | undefined
  let pupil: SVGCircleElement | undefined
  let blinkTimer = 0

  const blink = () => {
    if (blinkTimer) return
    setBlinking(true)
    blinkTimer = window.setTimeout(() => {
      setBlinking(false)
      blinkTimer = 0
    }, 140)
  }

  onCleanup(() => {
    if (blinkTimer) window.clearTimeout(blinkTimer)
  })

  onMount(() => {
    const eyeElement = eye
    const pupilElement = pupil
    if (!eyeElement || !pupilElement || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return

    const target = { x: 0, y: 0 }
    const position = { x: 0, y: 0 }
    const velocity = { x: 0, y: 0 }
    const orbitPosition = { x: 13, y: 0 }
    const orbitVelocity = { x: 0, y: -2.8 }
    let frame = 0
    let previousTime: number | undefined

    const reset = () => {
      target.x = 0
      target.y = 0
    }
    const follow = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") return
      const rect = eyeElement.getBoundingClientRect()
      const x = event.clientX - (rect.left + rect.width / 2)
      const y = event.clientY - (rect.top + rect.height / 2)
      const distance = Math.hypot(x, y)
      const offset = Math.min(14, distance / 18)
      target.x = distance === 0 ? 0 : x / distance * offset
      target.y = distance === 0 ? 0 : y / distance * offset
    }
    const animate = (time: number) => {
      const delta = previousTime === undefined ? 1 : Math.min((time - previousTime) / (1000 / 60), 2)
      previousTime = time

      const followDamping = 0.72 ** delta
      velocity.x = (velocity.x + (target.x - position.x) * 0.12 * delta) * followDamping
      velocity.y = (velocity.y + (target.y - position.y) * 0.12 * delta) * followDamping
      position.x += velocity.x * delta
      position.y += velocity.y * delta

      const orbitDamping = 0.92 ** delta
      orbitVelocity.x = (orbitVelocity.x - orbitPosition.x * 0.05 * delta) * orbitDamping
      orbitVelocity.y = (orbitVelocity.y - orbitPosition.y * 0.05 * delta) * orbitDamping
      orbitPosition.x += orbitVelocity.x * delta
      orbitPosition.y += orbitVelocity.y * delta

      pupilElement.setAttribute("transform", `translate(${position.x + orbitPosition.x} ${position.y + orbitPosition.y})`)
      frame = window.requestAnimationFrame(animate)
    }

    window.addEventListener("pointermove", follow)
    window.addEventListener("blur", reset)
    document.documentElement.addEventListener("pointerleave", reset)
    frame = window.requestAnimationFrame(animate)

    onCleanup(() => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener("pointermove", follow)
      window.removeEventListener("blur", reset)
      document.documentElement.removeEventListener("pointerleave", reset)
    })
  })

  return (
    <span class="wordmark">
      <button type="button" class="wordmark-eye" classList={{ "wordmark-eye-blinking": blinking() }} aria-label="Blink Behold eye" onClick={blink}>
        <svg ref={(element) => (eye = element)} class="wordmark-icon" viewBox="0 0 256 256" aria-hidden="true">
          <path d="M247.31 124.76c-.35-.79-8.82-19.58-27.65-38.41C194.57 61.26 162.88 48 128 48S61.43 61.26 36.34 86.35C17.51 105.18 9 124 8.69 124.76a8 8 0 0 0 0 6.5c.35.79 8.82 19.57 27.65 38.4C61.43 194.74 93.12 208 128 208s66.57-13.26 91.66-38.34c18.83-18.83 27.3-37.61 27.65-38.4a8 8 0 0 0 0-6.5Z" />
          <circle ref={(element) => (pupil = element)} class="wordmark-pupil" cx="128" cy="128" r="36" />
        </svg>
      </button>
      <span>Behold</span>
    </span>
  )
}

const scrollStoragePrefix = "behold:scroll:"

const landingMarkdown = `# Behold

Turn plans, proposals, and technical notes into a focused review surface. Your documents and feedback stay local until you explicitly publish a frozen snapshot.

## Install

Run one command. Behold detects your coding agents, registers itself, starts the local viewer, and opens it in your browser.

\`\`\`shell
$ bunx @kitlangton/behold setup
\`\`\`

Requires Bun 1.3 or newer. Restart an agent that was already running.

Then ask your agent naturally: **“Put this architecture proposal in Behold.”**

## How it works

\`\`\`timeline
title: From draft to feedback
events:
  - title: Present
    detail: Your agent sends Markdown or an existing file to the local viewer.
    status: complete
  - title: Review
    detail: Read the rendered document and attach comments to exact passages.
    status: current
  - title: Revise
    detail: Feedback returns to the agent and revisions update in place.
    status: pending
  - title: Publish, optionally
    detail: Create a frozen public snapshot only when you choose to.
    status: pending
\`\`\`

## Built for technical work

\`\`\`definitions
Portable Markdown: Documents remain readable outside Behold.
Contextual feedback: Comments stay anchored to the revision and passage they reference.
Live revisions: Reposting a file updates the same review without replacing its URL.
Rich primitives: Diagrams, trees, diffs, schemas, terminal output, timelines, and API references render semantically.
\`\`\`

## A small sampler

Agents can mix ordinary Markdown with semantic blocks that remain useful as source text.

\`\`\`tree
behold/
├── local/       # private, live review
├── revisions/   # retained history
└── published/   # explicit frozen snapshots
\`\`\`

\`\`\`diff
@@ -1,2 +1,2 @@
-Review the draft after implementation.
+Review the draft before implementation.
 Keep the feedback attached to the exact revision.
\`\`\`

\`\`\`http
GET /api/documents/demo HTTP/1.1
Accept: application/json

HTTP/1.1 200 OK
Content-Type: application/json

{"title":"Release plan","version":3}
\`\`\`

\`\`\`typescript title="review.ts" start="8" highlight="9"
const feedback = await collectFeedback(document)
return applyRevision(document, feedback)
\`\`\`
`

const readThemeToken = (name: string, fallback: string) => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

const mermaidOptions = () => ({
  bg: readThemeToken("--bg-inset", "#0e0e0e"),
  fg: readThemeToken("--fg-strong", "#f1efe8"),
  line: readThemeToken("--line-strong", "#3d3d3d"),
  accent: readThemeToken("--accent", "#7b96ff"),
  muted: readThemeToken("--fg-muted", "#8b8983"),
  surface: readThemeToken("--bg-inset", "#0e0e0e"),
  border: readThemeToken("--line-strong", "#3d3d3d"),
  font: '"Berkeley Mono", "JetBrains Mono Variable", "SFMono-Regular", ui-monospace, Consolas, monospace',
  nodeSpacing: 32,
  layerSpacing: 48,
  padding: 24,
})

const mermaidB64Pattern = /data-mermaid-b64="([^"]+)"/
let mermaidRenderer: MermaidRenderer | null = null
let mermaidRendererPromise: Promise<MermaidRenderer> | null = null

const quotePreview = (value: string, maxLength = 120) => {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`
}

const formatRelativeTime = (value: string, now = Date.now()) => {
  const elapsed = Math.max(0, now - Date.parse(value))
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (elapsed < minute) return "now"
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m ago`
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h ago`
  if (elapsed < 30 * day) return `${Math.floor(elapsed / day)}d ago`
  if (elapsed < 365 * day) return `${Math.floor(elapsed / (30 * day))}mo ago`
  return `${Math.floor(elapsed / (365 * day))}y ago`
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "published-doc"

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const buildScrollStorageKey = () => `${scrollStoragePrefix}${window.location.pathname}${window.location.search}`

const readStoredScrollPosition = (): { x: number; y: number } | null => {
  const raw = window.sessionStorage.getItem(buildScrollStorageKey())
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown }
    if (typeof parsed.x === "number" && typeof parsed.y === "number") return { x: parsed.x, y: parsed.y }
  } catch {
    // invalid scroll cache is ignored
  }
  return null
}

const writeCurrentScrollPosition = () => {
  window.sessionStorage.setItem(buildScrollStorageKey(), JSON.stringify({ x: window.scrollX, y: window.scrollY }))
}

const buildCommentsSignature = (comments: ReadonlyArray<DocumentComment>) =>
  comments.map((comment) => `${comment.id}:${comment.updatedAt}:${comment.status}:${comment.resolvedAt ?? ""}:${comment.content}`).join("|")

const findSectionElement = (node: Node | null): HTMLElement | null => {
  let current: Node | null = node
  while (current !== null) {
    if (current instanceof HTMLElement && current.dataset.sectionIndex !== undefined) return current
    const root = current.getRootNode()
    current = root instanceof ShadowRoot && root.host !== current ? root.host : current.parentNode
  }
  return null
}

const loadMermaidRenderer = () => {
  mermaidRendererPromise ??= import("beautiful-mermaid")
    .then(({ renderMermaidSVG }) => {
      mermaidRenderer = renderMermaidSVG
      return renderMermaidSVG
    })
    .catch((error) => {
      mermaidRendererPromise = null
      throw error
    })
  return mermaidRendererPromise
}

function renderMermaidInHtml(html: string): string {
  const render = mermaidRenderer
  if (!render) return html
  return html.replace(/<div class="mermaid-block" data-mermaid-b64="([^"]+)"><\/div>/g, (_match, encoded: string) => {
    const raw = decodeURIComponent(escape(globalThis.atob(encoded)))
    // beautiful-mermaid understands <br/> line breaks and <b>/<i>/<em>/<strong>/<u>
    // emphasis natively; only <code> renders as an escaped literal, so strip it.
    // Rewriting <br/> into real newlines here would split quoted labels mid-string
    // and corrupt the parse into phantom nodes.
    const source = raw.replace(/<\/?code>/gi, "")
    try {
      return `<div class="mermaid-block"><button class="mermaid-zoom-trigger" type="button" aria-label="Open diagram preview">${render(source, mermaidOptions())}</button></div>`
    } catch {
      const escaped = source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      return `<div class="mermaid-block mermaid-unsupported"><pre><code>${escaped}</code></pre></div>`
    }
  })
}

const errorMessage = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback)

function MarkdownBlock(props: { readonly text: string; readonly highlighterRevision: number }) {
  const [mermaidRevision, setMermaidRevision] = createSignal(0)

  createEffect(() => {
    if (!hasMermaidFence(props.text) || mermaidRenderer) return
    let cancelled = false
    void loadMermaidRenderer().then(() => {
      if (!cancelled) setMermaidRevision((current) => current + 1)
    }).catch((error) => {
      if (!cancelled) showToast({ variant: "error", description: errorMessage(error, "Unable to load diagram renderer.") })
    })
    onCleanup(() => {
      cancelled = true
    })
  })

  const html = createMemo(() => {
    void props.highlighterRevision
    void mermaidRevision()
    const raw = renderMarkdownToHtml(props.text)
    return mermaidB64Pattern.test(raw) ? renderMermaidInHtml(raw) : raw
  })

  const onClick: JSX.EventHandlerUnion<HTMLDivElement, MouseEvent> = (event) => {
    if (!(event.target instanceof Element)) return
    const button = event.target.closest<HTMLButtonElement>(".code-copy-button")
    if (!button) return
    event.preventDefault()
    event.stopPropagation()
    const source = button.closest<HTMLElement>(".code-block-shell")?.dataset.copyCode
    if (source === undefined) return
    void navigator.clipboard.writeText(source).then(() => {
      button.dataset.label = "Copied"
      button.setAttribute("aria-label", "Code copied")
      window.setTimeout(() => {
        if (!button.isConnected) return
        button.dataset.label = "Copy"
        button.setAttribute("aria-label", "Copy code")
      }, 1_500)
    }).catch((error) => {
      showToast({ variant: "error", description: errorMessage(error, "Unable to copy code.") })
    })
  }

  return <div class="markdown-block" innerHTML={html()} onClick={onClick} />
}

function useActiveHeading(ids: () => ReadonlyArray<string>) {
  const [activeId, setActiveId] = createSignal("")
  let lastY = 0

  createEffect(() => {
    const elements = ids().flatMap((id) => {
      const element = document.getElementById(id)
      return element ? [element] : []
    })
    if (elements.length === 0) return
    const visibleSet = new Set<string>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) entry.isIntersecting ? visibleSet.add(entry.target.id) : visibleSet.delete(entry.target.id)
        const scrollingDown = window.scrollY >= lastY
        lastY = window.scrollY
        if (visibleSet.size === 0) return
        const sorted = elements.filter((element) => visibleSet.has(element.id))
        setActiveId(scrollingDown ? sorted[sorted.length - 1].id : sorted[0].id)
      },
      { rootMargin: "0px 0px -75% 0px" },
    )
    for (const element of elements) observer.observe(element)
    onCleanup(() => observer.disconnect())
  })

  return activeId
}

interface OutlineGeometry {
  readonly path: string
  readonly total: number
  readonly spans: ReadonlyArray<readonly [number, number]>
  readonly width: number
  readonly height: number
}

interface SpringValue {
  position: number
  velocity: number
}

const stepSpring = (spring: SpringValue, target: number, dt: number) => {
  const acceleration = 460 * (target - spring.position) - 44 * spring.velocity
  spring.velocity += acceleration * dt
  spring.position += spring.velocity * dt
}

function DocumentOutline(props: { readonly entries: ReadonlyArray<TocEntry> }) {
  const ids = createMemo(() => props.entries.map((entry) => entry.id))
  const activeId = useActiveHeading(ids)
  let list: HTMLDivElement | undefined
  let highlight: SVGPathElement | undefined
  let entryElements: Array<HTMLAnchorElement | undefined> = []
  const [geometry, setGeometry] = createSignal<OutlineGeometry>()

  const measure = () => {
    const elements = props.entries.map((_, index) => entryElements[index])
    if (!list || elements.some((element) => !element || element.offsetHeight === 0) || elements.length < 2) {
      setGeometry(undefined)
      return
    }
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    const bend = 5
    const xs = props.entries.map((entry) => (entry.depth - 1) * 0.7 * rem + 0.5)
    const spans: Array<readonly [number, number]> = []
    let path = ""
    let total = 0
    let previousX = 0
    let previousY = 0
    elements.forEach((element, index) => {
      const x = xs[index]
      const top = element!.offsetTop
      const bottom = top + element!.offsetHeight
      const startY = index > 0 && xs[index - 1] !== x ? top + bend : top
      const endY = index < elements.length - 1 && xs[index + 1] !== x ? bottom - bend : bottom
      if (index === 0) {
        path = `M ${x} ${startY}`
      } else {
        total += Math.hypot(x - previousX, startY - previousY)
        path += ` L ${x} ${startY}`
      }
      spans.push([total, total + (endY - startY)])
      total += endY - startY
      path += ` L ${x} ${endY}`
      previousX = x
      previousY = endY
    })
    setGeometry({ path, total, spans, width: Math.max(...xs) + 1, height: list.scrollHeight })
  }

  const start: SpringValue = { position: 0, velocity: 0 }
  const end: SpringValue = { position: 0, velocity: 0 }
  let targetStart = 0
  let targetEnd = 0
  let frame = 0
  let lastTime = 0
  let settledOnce = false

  const applyHighlight = () => {
    const total = geometry()?.total ?? 0
    highlight?.setAttribute("stroke-dasharray", `${Math.max(end.position - start.position, 0)} ${total + 1}`)
    highlight?.setAttribute("stroke-dashoffset", `${-start.position}`)
  }

  const tick = (time: number) => {
    const dt = Math.min((time - lastTime) / 1000, 1 / 30)
    lastTime = time
    stepSpring(start, targetStart, dt)
    stepSpring(end, targetEnd, dt)
    applyHighlight()
    const settled =
      Math.abs(start.position - targetStart) < 0.3 && Math.abs(start.velocity) < 3 &&
      Math.abs(end.position - targetEnd) < 0.3 && Math.abs(end.velocity) < 3
    if (settled) {
      start.position = targetStart
      end.position = targetEnd
      start.velocity = 0
      end.velocity = 0
      applyHighlight()
      frame = 0
      return
    }
    frame = requestAnimationFrame(tick)
  }

  onMount(() => {
    measure()
    void document.fonts?.ready.then(measure)
    if (typeof ResizeObserver !== "undefined" && list) {
      const observer = new ResizeObserver(measure)
      observer.observe(list)
      onCleanup(() => observer.disconnect())
    }
    onCleanup(() => cancelAnimationFrame(frame))
  })

  createEffect(() => {
    void props.entries
    entryElements = entryElements.slice(0, props.entries.length)
    settledOnce = false
    measure()
  })

  createEffect(() => {
    const currentGeometry = geometry()
    const active = activeId()
    if (!currentGeometry || !highlight) return
    const index = props.entries.findIndex((entry) => entry.id === active)
    const span = index >= 0 ? currentGeometry.spans[index] : undefined
    highlight.style.opacity = span ? "1" : "0"
    if (!span) return
    targetStart = span[0]
    targetEnd = span[1]
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (!settledOnce || reduceMotion) {
      start.position = targetStart
      end.position = targetEnd
      start.velocity = 0
      end.velocity = 0
      settledOnce = true
      applyHighlight()
      return
    }
    if (frame === 0) {
      lastTime = performance.now()
      frame = requestAnimationFrame(tick)
    }
  })

  return (
    <Show when={props.entries.length >= 2}>
      <nav class="rail-block" aria-label="Document outline">
        <p class="rail-label">Outline</p>
        <div class="outline-list" ref={list}>
          <Show when={geometry()}>
            {(shape) => (
              <svg class="outline-rail" width={shape().width} height={shape().height} viewBox={`0 0 ${shape().width} ${shape().height}`} aria-hidden="true">
                <path class="outline-rail-base" d={shape().path} />
                <path class="outline-rail-highlight" ref={highlight} d={shape().path} />
              </svg>
            )}
          </Show>
          <For each={props.entries}>
            {(entry, index) => (
              <a
                href={`#${entry.id}`}
                class="outline-entry"
                classList={{ "outline-entry-active": entry.id === activeId() }}
                style={{ "padding-left": `${0.85 + (entry.depth - 1) * 0.7}rem` }}
                ref={(element) => (entryElements[index()] = element)}
              >
                {entry.text}
              </a>
            )}
          </For>
        </div>
      </nav>
    </Show>
  )
}

export function CommentPopover(props: {
  readonly pending: PendingComment
  readonly onSave: (text: string) => void
  readonly onCancel: () => void
  readonly onDelete?: () => void
  readonly saving: boolean
}) {
  const [text, setText] = createSignal(props.pending.initialText ?? "")
  const canSave = () => text().trim() !== "" && text().trim() !== (props.pending.initialText?.trim() ?? "")
  let input!: HTMLTextAreaElement

  onMount(() => input?.focus())
  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onCancel()
    }
    window.addEventListener("keydown", onKeyDown)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown))
  })

  const width = Math.min(320, window.innerWidth - 32)
  const selectionCenter = props.pending.rect.left + props.pending.rect.width / 2
  const left = clamp(selectionCenter - width / 2, window.scrollX + 16, window.scrollX + window.innerWidth - width - 16)

  return (
    <aside class="comment-popover" role="dialog" aria-modal="false" aria-labelledby="comment-popover-title" style={{ top: `${props.pending.rect.bottom + 8}px`, left: `${left}px`, width: `${width}px` }}>
      <label id="comment-popover-title" class="visually-hidden" for="comment-draft">Add annotation</label>
      <textarea
        id="comment-draft"
        name="comment"
        class="comment-popover-input"
        placeholder="What should change?"
        value={text()}
        ref={(element) => (input = element)}
        onInput={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event: KeyboardEvent) => {
          if (event.key === "Enter" && !event.shiftKey && canSave()) {
            event.preventDefault()
            props.onSave(text().trim())
          }
        }}
      />
      <div class="comment-popover-actions">
        <Show when={props.pending.commentId && props.onDelete}>
          <button type="button" class="action comment-popover-delete" onClick={() => props.onDelete?.()}>Delete</button>
        </Show>
        <button type="button" class="action" onClick={props.onCancel}>Cancel</button>
        <button type="button" class="action comment-popover-save" onClick={() => props.onSave(text().trim())} disabled={props.saving || !canSave()}>
          {props.saving ? "Saving…" : "Save"}
        </button>
      </div>
    </aside>
  )
}

interface MermaidZoomSource {
  readonly svg: string
  readonly origin: { readonly top: number; readonly left: number; readonly width: number; readonly height: number }
}

export function MermaidZoomOverlay(props: { readonly zoom: MermaidZoomSource; readonly onClose: () => void }) {
  const [active, setActive] = createSignal(false)
  const [dialogOpen, setDialogOpen] = createSignal(true)
  let closeTimer = 0
  let closeButton: HTMLButtonElement | undefined
  const restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null

  const margin = Math.min(48, window.innerWidth * 0.05)
  const aspect = props.zoom.origin.width / Math.max(props.zoom.origin.height, 1)
  const targetWidth = Math.min(window.innerWidth - margin * 2, (window.innerHeight - margin * 2) * aspect)
  const targetHeight = targetWidth / aspect
  const targetLeft = (window.innerWidth - targetWidth) / 2
  const targetTop = (window.innerHeight - targetHeight) / 2
  const collapsedTransform = `translate(${props.zoom.origin.left - targetLeft}px, ${props.zoom.origin.top - targetTop}px) scale(${props.zoom.origin.width / targetWidth}, ${props.zoom.origin.height / targetHeight})`

  const close = () => {
    if (closeTimer) return
    setActive(false)
    closeTimer = window.setTimeout(() => {
      setDialogOpen(false)
      window.requestAnimationFrame(() => {
        if (restoreFocusTo?.isConnected) restoreFocusTo.focus()
        props.onClose()
      })
    }, 280)
  }

  onMount(() => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => setActive(true)))
    onCleanup(() => {
      if (closeTimer) window.clearTimeout(closeTimer)
    })
  })

  return (
    <KobalteDialog open={dialogOpen()} onOpenChange={(open) => { if (!open) close() }} modal preventScroll={false}>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay class="mermaid-zoom-backdrop" classList={{ "mermaid-zoom-active": active() }} onWheel={(event) => event.preventDefault()} />
        <KobalteDialog.Content
          class="mermaid-zoom-stage"
          aria-modal="true"
          onClick={close}
          onWheel={(event) => event.preventDefault()}
          style={{
            top: `${targetTop}px`,
            left: `${targetLeft}px`,
            width: `${targetWidth}px`,
            height: `${targetHeight}px`,
            transform: active() ? "none" : collapsedTransform,
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            closeButton?.focus()
          }}
        >
          <KobalteDialog.Title class="visually-hidden">Diagram preview</KobalteDialog.Title>
          <div class="mermaid-zoom-canvas" innerHTML={props.zoom.svg} />
          <button ref={(element) => (closeButton = element)} type="button" class="mermaid-zoom-close" aria-label="Close diagram preview" onClick={close}>Close</button>
        </KobalteDialog.Content>
      </KobalteDialog.Portal>
    </KobalteDialog>
  )
}

export function DocumentLoadState(props: {
  readonly sourceLoading: boolean
  readonly sourceError: string
  readonly rendering: boolean
  readonly hasDocument: boolean
  readonly editorOpen: boolean
  readonly hasSections: boolean
}) {
  return (
    <Show when={!props.hasDocument && !props.editorOpen}>
      <Switch>
        <Match when={props.sourceLoading}><p class="muted-copy">Loading document…</p></Match>
        <Match when={props.sourceError}><p class="muted-copy load-error" role="alert">{props.sourceError}</p></Match>
        <Match when={props.rendering}><p class="muted-copy">Rendering…</p></Match>
        <Match when={!props.hasSections}><p class="muted-copy">Nothing to render yet.</p></Match>
      </Switch>
    </Show>
  )
}

function DocumentSections(props: { readonly sections: ReadonlyArray<RenderedDocumentSection>; readonly highlighterRevision: number }) {
  return (
    <For each={props.sections}>
      {(section, index) => (
        <div data-section-index={index()} data-section-type={section._tag} class="document-section">
          <MarkdownBlock text={section.markdown} highlighterRevision={props.highlighterRevision} />
        </div>
      )}
    </For>
  )
}

export interface RailProps {
  readonly isPublishedView: boolean
  readonly publishedTitle: string
  readonly publishedSlug: string
  readonly publishStatus: string
  readonly publishedRemote: PublishRemoteResult | null
  readonly publishing: boolean
  readonly hasDocument: boolean
  readonly recentDocuments: ReadonlyArray<RecentDocument>
  readonly activeDocumentId: string
  readonly revisions: ReadonlyArray<DocumentRevision>
  readonly displayedRevisionId: string
  readonly currentRevisionId: string
  readonly diffView: boolean
  readonly comments: ReadonlyArray<DocumentComment>
  readonly activeCommentId: string | null
  readonly clearingComments: boolean
  readonly deletingDocument: boolean
  readonly sourceStatus: string
  readonly editorOpen: boolean
  readonly headings: ReadonlyArray<TocEntry>
  readonly showActions: boolean
  readonly hasPublishedSnapshot: boolean
  readonly onPublish: () => void
  readonly onCopyAnnotations: () => void
  readonly onCopyMarkdown: () => void
  readonly onClearComments: () => void
  readonly onDeleteDocument: () => void
  readonly onViewRevision: (revision: DocumentRevision) => void
  readonly onViewDiff: (revision: DocumentRevision) => void
  readonly onCommentHover: (commentId: string | null) => void
  readonly onCommentEdit: (commentId: string) => void
}

export function RailContent(props: RailProps) {
  return (
    <div class="rail-content">
      <DocumentOutline entries={props.headings} />

      <Show when={props.showActions && !props.isPublishedView}>
        <div class="rail-block">
          <p class="rail-label">Document</p>
          <div class="rail-actions">
            <Show
              when={props.hasDocument}
              fallback={<button type="button" class="action" onClick={props.onCopyMarkdown}>Copy Markdown</button>}
            >
              <button type="button" class="action action-accent" onClick={props.onPublish} disabled={props.publishing}>{props.publishing ? "Publishing…" : "Publish"}</button>
            </Show>
          </div>
        </div>
      </Show>

      <Show when={props.isPublishedView}>
        <div class="rail-block">
          <p class="rail-label">Published</p>
          <p class="rail-text">{props.publishedTitle || props.publishedSlug}</p>
          <div class="rail-actions rail-actions-inline">
            <button type="button" class="action" onClick={props.onCopyAnnotations} disabled={!props.hasPublishedSnapshot}>Copy annotations</button>
            <button type="button" class="action" onClick={props.onCopyMarkdown} disabled={!props.hasPublishedSnapshot}>Copy Markdown</button>
          </div>
        </div>
      </Show>

      <Show when={props.activeDocumentId && props.revisions.length > 1}>
        <div class="rail-block">
          <p class="rail-label">History</p>
          <div class="revision-list">
            <For each={[...props.revisions].reverse()}>
              {(revision) => (
                <button
                  type="button"
                  class="revision-link"
                  classList={{ "revision-link-active": !props.diffView && revision.id === props.displayedRevisionId }}
                  aria-current={!props.diffView && revision.id === props.displayedRevisionId ? "true" : undefined}
                  onClick={() => props.onViewRevision(revision)}
                >
                  <span>v{revision.version}</span>
                  <time class="revision-date" dateTime={revision.createdAt} title={new Date(revision.createdAt).toLocaleString()}>{formatRelativeTime(revision.createdAt)}</time>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={!props.isPublishedView && (props.publishStatus || props.publishedRemote)}>
        <div class="rail-block">
          <Show when={props.publishedRemote} fallback={<p class="rail-text">{props.publishStatus}</p>}>
            {(remote) => <a class="rail-link" href={remote().url} target="_blank" rel="noreferrer">{remote().url.replace(/^https?:\/\//, "")}</a>}
          </Show>
        </div>
      </Show>

      <Show when={(props.isPublishedView || props.activeDocumentId) && !props.diffView && props.comments.length > 0}>
        <div class="rail-block">
          <div class="rail-block-header">
            <p class="rail-label">Notes <span class="rail-count">{props.comments.length}</span></p>
            <Show when={!props.isPublishedView}>
              <button type="button" class="action" onClick={props.onClearComments} disabled={props.clearingComments}>Clear</button>
            </Show>
          </div>
          <div class="notes-list">
            <For each={props.comments}>
              {(comment) => (
                <article
                  class="note-item"
                  classList={{ "note-item-active": props.activeCommentId === comment.id }}
                  role="button"
                  tabIndex={0}
                  onMouseEnter={() => props.onCommentHover(comment.id)}
                  onMouseLeave={() => props.onCommentHover(null)}
                  onFocus={() => props.onCommentHover(comment.id)}
                  onBlur={() => props.onCommentHover(null)}
                  onClick={() => props.onCommentEdit(comment.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      props.onCommentEdit(comment.id)
                    }
                  }}
                >
                  <blockquote class="note-item-quote">{quotePreview(comment.location.selectedText, 80)}</blockquote>
                  <p class="note-item-text">{comment.content}</p>
                  <Show when={!props.isPublishedView && comment.anchor}><span class="note-item-meta">v{props.revisions.find((revision) => revision.id === comment.anchor?.revisionId)?.version ?? "?"}</span></Show>
                </article>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={!props.isPublishedView && props.recentDocuments.length > 0}>
        <details class="rail-block rail-docs">
          <summary class="rail-label rail-docs-summary">
            <span>Documents</span>
            <span class="rail-count">{props.recentDocuments.length}</span>
          </summary>
          <div class="document-list">
            <For each={props.recentDocuments}>
              {(recentDocument) => {
                const title = markdownInlineToText(recentDocument.title)
                const active = () => recentDocument.id === props.activeDocumentId
                return (
                  <div class="document-row" classList={{ "document-row-active": active() }}>
                    <a href={recentDocument.url} class="document-link" aria-current={active() ? "page" : undefined}>
                      {title}
                    </a>
                    <Show when={active()}>
                      <button
                        type="button"
                        class="document-delete"
                        aria-label={`Delete ${title}`}
                        onClick={props.onDeleteDocument}
                        disabled={props.deletingDocument}
                      >
                        {props.deletingDocument ? "Deleting…" : "Delete"}
                      </button>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </details>
      </Show>
    </div>
  )
}

function MobileSidebarDrawer(props: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly restoreFocus: () => void
  readonly children: JSX.Element
}) {
  let closeButton: HTMLButtonElement | undefined

  return (
    <KobalteDialog open={props.open} onOpenChange={props.onOpenChange} modal>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay class="drawer-backdrop" />
        <KobalteDialog.Content
          id="mobile-sidebar"
          class="drawer-panel"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            closeButton?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            props.restoreFocus()
          }}
        >
          <div class="drawer-header">
            <KobalteDialog.Title class="drawer-title">Behold</KobalteDialog.Title>
            <button ref={(element) => (closeButton = element)} type="button" class="action" aria-label="Close menu" onClick={() => props.onOpenChange(false)}>Close</button>
          </div>
          {props.children}
        </KobalteDialog.Content>
      </KobalteDialog.Portal>
    </KobalteDialog>
  )
}

export default function App() {
  const initialQuery = new URLSearchParams(window.location.search)
  const initialDocumentId = initialQuery.get("doc")?.trim() ?? ""
  const initialMarkdownUrl = initialQuery.get("src")?.trim() ?? ""
  const publishedPath = window.location.pathname.startsWith("/published/")
    ? window.location.pathname.slice("/published/".length)
    : undefined
  let publishedPathError = ""
  let decodedPublishedPath = ""
  if (publishedPath !== undefined) {
    try {
      decodedPublishedPath = decodeURIComponent(publishedPath)
    } catch {
      publishedPathError = "The published document URL is malformed."
    }
  }
  const initialPublishedSlug = publishedPath === undefined
    ? initialQuery.get("published")?.trim() ?? ""
    : decodedPublishedPath
  const isPublishedView = initialPublishedSlug !== ""
  let mobileMenuButton: HTMLButtonElement | undefined
  let activeDocumentIdRef = initialDocumentId
  let activeDocumentUpdatedAtRef = ""
  let initialScrollRestored = false
  let renderedMarkdownRef = ""
  let pendingScrollRestore: { x: number; y: number } | null = null

  const [renderedMarkdown, setRenderedMarkdown] = createSignal("")
  const [markdownUrl, setMarkdownUrl] = createSignal(initialMarkdownUrl)
  const [sourceStatus, setSourceStatus] = createSignal("")
  const [sourceLoading, setSourceLoading] = createSignal(isPublishedView || initialDocumentId !== "" || initialMarkdownUrl !== "")
  const [sourceError, setSourceError] = createSignal(publishedPathError)
  const [document, setDocument] = createSignal<RenderedDocument | null>(null)
  const [rendering, setRendering] = createSignal(true)
  const [activeDocumentId, setActiveDocumentId] = createSignal(initialDocumentId)
  const [publishedSnapshot, setPublishedSnapshot] = createSignal<PublishedDocumentSnapshot | null>(null)
  const [publishStatus, setPublishStatus] = createSignal("")
  const [publishedRemote, setPublishedRemote] = createSignal<PublishRemoteResult | null>(null)
  const [publishing, setPublishing] = createSignal(false)
  const [recentDocuments, setRecentDocuments] = createSignal<ReadonlyArray<RecentDocument>>([])
  const [revisions, setRevisions] = createSignal<ReadonlyArray<DocumentRevision>>([])
  const [currentRevisionId, setCurrentRevisionId] = createSignal("")
  const [displayedRevisionId, setDisplayedRevisionId] = createSignal("")
  const [diffView, setDiffView] = createSignal(false)
  const [comments, setComments] = createSignal<ReadonlyArray<DocumentComment>>([])
  const [publishedAnnotations, setPublishedAnnotations] = createSignal<ReadonlyArray<PublishedAnnotation>>([])
  const [selectionPill, setSelectionPill] = createSignal<PendingComment | null>(null)
  const [pendingComment, setPendingComment] = createSignal<PendingComment | null>(null)
  const [savingComment, setSavingComment] = createSignal(false)
  const [clearingComments, setClearingComments] = createSignal(false)
  const [deletingDocument, setDeletingDocument] = createSignal(false)
  const [highlighterRevision, setHighlighterRevision] = createSignal(0)
  const [mermaidZoom, setMermaidZoom] = createSignal<MermaidZoomSource | null>(null)
  const [highlightRects, setHighlightRects] = createSignal<ReadonlyArray<{ top: number; left: number; width: number; height: number }>>([])
  const [commentHighlightRects, setCommentHighlightRects] = createSignal<ReadonlyArray<CommentHighlightRect>>([])
  const [hoveredCommentId, setHoveredCommentId] = createSignal<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const editorOpen = () => !isPublishedView && initialDocumentId === "" && initialMarkdownUrl === ""
  const headings = createMemo(() => extractHeadings(editorOpen() && !document() ? landingMarkdown : renderedMarkdown()))
  const canPublish = () => !!document() && (!activeDocumentId() || (!diffView() && displayedRevisionId() === currentRevisionId()))
  const displayedComments = createMemo<ReadonlyArray<DocumentComment>>(() => {
    const snapshot = publishedSnapshot()
    if (!isPublishedView || !snapshot) return comments()
    const revisionId = publishedSnapshotRevisionId(snapshot)
    return publishedAnnotations().map((annotation, index) => ({
      id: annotation.id,
      createdAt: annotation.createdAt,
      updatedAt: annotation.updatedAt,
      content: annotation.content,
      status: "open",
      seq: index + 1,
      location: {
        sectionIndex: annotation.anchor.sectionIndex,
        sectionType: "markdown",
        selectedText: annotation.anchor.selectedText,
        contextBefore: annotation.anchor.contextBefore ?? "",
        contextAfter: annotation.anchor.contextAfter ?? "",
        sectionTitle: annotation.anchor.sectionTitle,
      },
      anchor: annotation.anchor.renderedRange ? {
        revisionId,
        plane: "rendered-text-v1",
        range: annotation.anchor.renderedRange,
        quote: {
          exact: annotation.anchor.selectedText,
          prefix: annotation.anchor.contextBefore ?? "",
          suffix: annotation.anchor.contextAfter ?? "",
        },
      } : undefined,
    }))
  })

  const getCommentRects = (comment: DocumentComment): ReadonlyArray<CommentHighlightRect> => {
    if (diffView() || !displayedRevisionId()) return []
    const section = window.document.querySelector<HTMLElement>(`[data-section-index="${comment.location.sectionIndex}"]`)
    if (!section) return []
    const range = resolveCommentRange(section, comment, displayedRevisionId())
    if (!range) return []
    return Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({
        commentId: comment.id,
        top: rect.top + window.scrollY,
        left: rect.left + window.scrollX,
        width: rect.width,
        height: rect.height,
      }))
  }

  const commentIdAtPoint = (pageX: number, pageY: number) =>
    commentHighlightRects().find((rect) => pageX >= rect.left && pageX <= rect.left + rect.width && pageY >= rect.top && pageY <= rect.top + rect.height)?.commentId ?? null

  const openCommentEditor = (commentId: string) => {
    const comment = displayedComments().find((entry) => entry.id === commentId)
    if (!comment) return
    const rects = getCommentRects(comment)
    if (rects.length === 0) return
    const top = Math.min(...rects.map((rect) => rect.top))
    const bottom = Math.max(...rects.map((rect) => rect.top + rect.height))
    const left = Math.min(...rects.map((rect) => rect.left))
    const right = Math.max(...rects.map((rect) => rect.left + rect.width))
    setSelectionPill(null)
    setHighlightRects([])
    setPendingComment({
      commentId: comment.id,
      initialText: comment.content,
      location: comment.location,
      anchor: comment.anchor,
      sectionLabel: `Section ${comment.location.sectionIndex + 1}`,
      rect: { top, bottom, left, width: right - left },
    })
  }

  const onFlowClick = (event: MouseEvent) => {
    const block = event.target instanceof Element ? event.target.closest(".mermaid-block") : null
    const svg = block?.querySelector("svg")
    if (svg) {
      const rect = svg.getBoundingClientRect()
      setMermaidZoom({ svg: svg.outerHTML, origin: { top: rect.top, left: rect.left, width: rect.width, height: rect.height } })
      return
    }
    if (!window.getSelection()?.isCollapsed) return
    const commentId = commentIdAtPoint(event.pageX, event.pageY)
    if (commentId) openCommentEditor(commentId)
  }

  const onFlowMouseMove = (event: MouseEvent) => setHoveredCommentId(commentIdAtPoint(event.pageX, event.pageY))

  const clearPendingComment = () => {
    setSelectionPill(null)
    setPendingComment(null)
    setHighlightRects([])
  }

  const refreshRecentDocuments = async (signal?: AbortSignal) => {
    const result = await runDocumentViewerPromise(loadRecentDocuments(), signal)
    setRecentDocuments(result.documents)
    return result
  }

  const refreshComments = async (documentId: string, signal?: AbortSignal) => {
    const result = await runDocumentViewerPromise(loadDocumentComments(documentId), signal)
    const signature = buildCommentsSignature(result.comments)
    setComments((current) => (buildCommentsSignature(current) === signature ? current : result.comments))
    return result
  }

  const refreshRevisions = async (documentId: string, signal?: AbortSignal) => {
    const result = await runDocumentViewerPromise(loadDocumentRevisions(documentId), signal)
    setRevisions(result.versions)
    setCurrentRevisionId(result.currentRevisionId)
    return result
  }

  const updateCommentHighlights = () => {
    setCommentHighlightRects(displayedComments().flatMap(getCommentRects))
  }

  const refreshActiveDocument = async (signal?: AbortSignal) => {
    const documentId = activeDocumentIdRef
    if (!documentId) return
    const wasViewingCurrent = !displayedRevisionId() || displayedRevisionId() === currentRevisionId()
    const nextDocument = await runDocumentViewerPromise(loadHostedDocument(documentId), signal)
    if (nextDocument.updatedAt === activeDocumentUpdatedAtRef) return
    activeDocumentUpdatedAtRef = nextDocument.updatedAt
    setCurrentRevisionId(nextDocument.currentRevisionId)
    await refreshRevisions(documentId, signal)
    if (diffView() || !wasViewingCurrent) return
    setDisplayedRevisionId(nextDocument.revisionId)
    if (nextDocument.markdown === renderedMarkdownRef) return
    writeCurrentScrollPosition()
    pendingScrollRestore = { x: window.scrollX, y: window.scrollY }
    setRenderedMarkdown(nextDocument.markdown)
    await refreshRecentDocuments(signal)
  }

  const viewRevision = async (revision: DocumentRevision) => {
    const documentId = activeDocumentId()
    if (!documentId || revision.id === displayedRevisionId() && !diffView()) return
    try {
      const loaded = await runDocumentViewerPromise(loadDocumentRevision(documentId, revision.id))
      setDiffView(false)
      setDisplayedRevisionId(loaded.id)
      setRenderedMarkdown(loaded.markdown)
      clearPendingComment()
      setSourceStatus(loaded.id === currentRevisionId() ? `Current version ${loaded.version}.` : `Viewing historical version ${loaded.version}.`)
    } catch (error) {
      showToast({ variant: "error", description: errorMessage(error, "Unable to load revision.") })
    }
  }

  const viewRevisionDiff = async (revision: DocumentRevision) => {
    const documentId = activeDocumentId()
    if (!documentId || !revision.parentRevisionId) return
    try {
      const result = await runDocumentViewerPromise(diffDocumentRevisions(documentId, revision.parentRevisionId, revision.id))
      setDiffView(true)
      setDisplayedRevisionId(revision.id)
      setRenderedMarkdown(`\`\`\`diff\n${result.patch.replace(/\n$/, "")}\n\`\`\``)
      clearPendingComment()
      setSourceStatus(`Changes in version ${revision.version}: +${result.additions} -${result.deletions}.`)
    } catch (error) {
      showToast({ variant: "error", description: errorMessage(error, "Unable to load revision diff.") })
    }
  }

  const buildCurrentPublishedSnapshot = (): PublishedDocumentSnapshot | null => {
    const currentDocument = document()
    if (!currentDocument) return null
    const title = headings()[0]?.text ?? (activeDocumentId() ? `Hosted ${activeDocumentId()}` : "Behold")
    const slugBase = publishedSnapshot()?.slug ?? title
    return preparePublishedSnapshot({
      slug: slugify(slugBase),
      title,
      markdown: renderedMarkdown(),
      exportedAt: new Date().toISOString(),
      sourceDocumentId: activeDocumentId() || undefined,
      document: currentDocument,
    })
  }

  const publishCurrentDocument = async () => {
    if (!canPublish()) {
      showToast({ variant: "error", description: "Return to the current document version before publishing." })
      return
    }
    const snapshot = buildCurrentPublishedSnapshot()
    if (!snapshot) {
      setPublishStatus("Nothing to publish yet.")
      showToast({ variant: "error", description: "Nothing to publish yet." })
      return
    }
    const slugInput = window.prompt("Publish slug", snapshot.slug)
    if (slugInput === null) return
    const nextSnapshot: PublishedDocumentSnapshot = { ...snapshot, slug: slugify(slugInput), exportedAt: new Date().toISOString() }
    setPublishing(true)
    setPublishStatus("Publishing…")
    try {
      const result = await runDocumentViewerPromise(publishDocumentSnapshot(nextSnapshot))
      setPublishedRemote(result)
      setPublishStatus(result.updated ? `Updated ${result.url}` : `Published ${result.url}`)
      showToast({ variant: "success", description: result.updated ? `Updated ${result.url}` : `Published ${result.url}` })
    } catch (error) {
      const message = errorMessage(error, "Unable to publish document.")
      setPublishStatus(message)
      showToast({ variant: "error", description: message })
    } finally {
      setPublishing(false)
    }
  }

  const deleteCurrentDocument = async () => {
    const documentId = activeDocumentId()
    if (!documentId) return
    const title = headings()[0]?.text ?? "this hosted document"
    if (!window.confirm(`Delete “${title}” and its comments?`)) return

    setDeletingDocument(true)
    try {
      await runDocumentViewerPromise(deleteHostedDocument(documentId))
      window.location.assign("/")
    } catch (error) {
      showToast({ variant: "error", description: errorMessage(error, "Unable to delete hosted document.") })
      setDeletingDocument(false)
    }
  }

  const captureSelectionForComment = () => {
    const currentDocument = document()
    const snapshot = publishedSnapshot()
    const revisionId = snapshot ? publishedSnapshotRevisionId(snapshot) : displayedRevisionId()
    if ((!isPublishedView && !activeDocumentIdRef) || !currentDocument || diffView() || !revisionId) {
      clearPendingComment()
      return
    }
    const selection = window.getSelection()
    const selectedText = selection?.toString().trim() ?? ""
    if (!selection || selection.isCollapsed || selectedText === "") {
      clearPendingComment()
      return
    }
    const anchorSection = findSectionElement(selection.anchorNode)
    const focusSection = findSectionElement(selection.focusNode)
    if (!anchorSection || !focusSection || anchorSection !== focusSection) {
      clearPendingComment()
      return
    }
    const sectionIndex = Number(anchorSection.dataset.sectionIndex)
    if (!Number.isInteger(sectionIndex) || sectionIndex < 0 || sectionIndex >= currentDocument.sections.length) {
      clearPendingComment()
      return
    }
    const range = selection.getRangeAt(0).cloneRange()
    const anchored = buildCommentAnchor(anchorSection, range, revisionId, renderedMarkdown())
    if (!anchored) {
      clearPendingComment()
      return
    }
    const rect = range.getBoundingClientRect()
    setHighlightRects(
      Array.from(range.getClientRects()).map((entry) => ({ top: entry.top + window.scrollY, left: entry.left + window.scrollX, width: entry.width, height: entry.height })),
    )
    setPendingComment(null)
    setSelectionPill({
      location: { ...anchored.location, sectionIndex },
      anchor: anchored.anchor,
      sectionLabel: `Section ${sectionIndex + 1}`,
      rect: { top: rect.top + window.scrollY, bottom: rect.bottom + window.scrollY, left: rect.left + window.scrollX, width: rect.width },
    })
  }

  const saveComment = async (text: string) => {
    const pending = pendingComment()
    if (!pending || !text) return

    if (isPublishedView) {
      const snapshot = publishedSnapshot()
      if (!snapshot) return
      setSavingComment(true)
      const now = new Date().toISOString()
      const next = pending.commentId
        ? updatePublishedAnnotation(publishedAnnotations(), pending.commentId, { content: text, updatedAt: now })
        : createPublishedAnnotation(publishedAnnotations(), {
            id: globalThis.crypto.randomUUID(),
            anchor: {
              sectionIndex: pending.location.sectionIndex,
              sectionTitle: pending.location.sectionTitle,
              selectedText: pending.location.selectedText,
              contextBefore: pending.location.contextBefore,
              contextAfter: pending.location.contextAfter,
              renderedRange: pending.anchor?.range,
            },
            content: text,
            createdAt: now,
          })
      setPublishedAnnotations(next)
      const persisted = savePublishedAnnotations(snapshot, next)
      clearPendingComment()
      window.getSelection()?.removeAllRanges()
      showToast({
        variant: persisted ? "success" : "error",
        description: persisted
          ? pending.commentId ? "Annotation updated." : "Annotation added."
          : "Annotation changed in this tab, but local storage is unavailable.",
      })
      setSavingComment(false)
      return
    }

    const activeId = activeDocumentId()
    if (!activeId) return
    setSavingComment(true)
    try {
      const result = pending.commentId
        ? await runDocumentViewerPromise(updateDocumentCommentContent(activeId, pending.commentId, text))
        : await runDocumentViewerPromise(createDocumentComment(activeId, text, pending.location, pending.anchor))
      setComments((current) => pending.commentId
        ? current.map((comment) => comment.id === result.comment.id ? result.comment : comment)
        : [...current, result.comment])
      clearPendingComment()
      window.getSelection()?.removeAllRanges()
      showToast({ variant: "success", description: pending.commentId ? "Comment updated." : "Comment added." })
    } catch (error) {
      showToast({ variant: "error", description: errorMessage(error, pending.commentId ? "Unable to update comment." : "Unable to create comment.") })
    } finally {
      setSavingComment(false)
    }
  }

  const deletePublishedComment = () => {
    const snapshot = publishedSnapshot()
    const commentId = pendingComment()?.commentId
    if (!snapshot || !commentId) return
    const next = deletePublishedAnnotation(publishedAnnotations(), commentId)
    setPublishedAnnotations(next)
    const persisted = savePublishedAnnotations(snapshot, next)
    clearPendingComment()
    window.getSelection()?.removeAllRanges()
    showToast({
      variant: persisted ? "success" : "error",
      description: persisted ? "Annotation deleted." : "Annotation deleted in this tab, but local storage is unavailable.",
    })
  }

  const copyPublishedText = async (text: string, description: string) => {
    try {
      await navigator.clipboard.writeText(text)
      showToast({ variant: "success", description })
    } catch (error) {
      showToast({ variant: "error", description: errorMessage(error, "Unable to copy to the clipboard.") })
    }
  }

  const copyAnnotations = () => {
    const snapshot = publishedSnapshot()
    if (!snapshot) return
    const count = publishedAnnotations().length
    void copyPublishedText(
      formatPublishedFeedbackMarkdown({ title: snapshot.title, publicUrl: window.location.href, annotations: publishedAnnotations() }),
      count === 0 ? "Copied annotations with no notes." : `Copied ${count} ${count === 1 ? "annotation" : "annotations"}.`,
    )
  }

  const copyMarkdown = () => {
    const snapshot = publishedSnapshot()
    const markdown = snapshot
      ? exportPublishedDocumentMarkdown(snapshot)
      : editorOpen()
        ? landingMarkdown
        : renderedMarkdown()
    if (markdown.trim() === "") return
    void copyPublishedText(markdown, snapshot ? "Copied original Markdown." : "Copied Markdown.")
  }

  const clearAllComments = async () => {
    if (!activeDocumentId() || comments().length === 0) return
    setClearingComments(true)
    try {
      const result = await runDocumentViewerPromise(clearDocumentComments(activeDocumentId()))
      setComments(result.comments)
      clearPendingComment()
      window.getSelection()?.removeAllRanges()
      showToast({ variant: "success", description: "Comments cleared." })
    } catch (error) {
      showToast({ variant: "error", description: errorMessage(error, "Unable to clear comments.") })
    } finally {
      setClearingComments(false)
    }
  }

  createEffect(() => {
    const markdown = renderedMarkdown() || (editorOpen() ? landingMarkdown : "")
    if (!hasFencedCode(markdown)) return
    let cancelled = false
    void initHighlighter().then(() => {
      if (!cancelled) setHighlighterRevision((current) => current + 1)
    }).catch((error) => {
      if (!cancelled) showToast({ variant: "error", description: errorMessage(error, "Unable to load syntax highlighting.") })
    })
    onCleanup(() => {
      cancelled = true
    })
  })

  createEffect(() => {
    activeDocumentIdRef = activeDocumentId()
  })

  createEffect(() => {
    activeDocumentId()
    markdownUrl()
    initialScrollRestored = false
  })

  createEffect(() => {
    renderedMarkdownRef = renderedMarkdown()
  })

  onMount(() => {
    const onScroll = () => writeCurrentScrollPosition()
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    onCleanup(() => window.removeEventListener("scroll", onScroll))
  })

  createEffect(() => {
    void document()
    void displayedComments()
    void highlighterRevision()
    let secondRaf = 0
    const raf = window.requestAnimationFrame(() => {
      secondRaf = window.requestAnimationFrame(updateCommentHighlights)
    })
    onCleanup(() => {
      window.cancelAnimationFrame(raf)
      if (secondRaf) window.cancelAnimationFrame(secondRaf)
    })
  })

  createEffect(() => {
    document()
    const flow = window.document.querySelector(".document-flow")
    if (!flow) return
    const observer = new ResizeObserver(updateCommentHighlights)
    observer.observe(flow)
    onCleanup(() => observer.disconnect())
  })

  onMount(() => {
    let cancelled = false
    const onResize = () => updateCommentHighlights()
    window.addEventListener("resize", onResize)
    void window.document.fonts.ready.then(() => {
      if (!cancelled) updateCommentHighlights()
    })
    onCleanup(() => {
      cancelled = true
      window.removeEventListener("resize", onResize)
    })
  })

  createEffect(() => {
    document()
    const scrollPosition = pendingScrollRestore ?? (!initialScrollRestored ? readStoredScrollPosition() : null)
    if (!scrollPosition) return
    pendingScrollRestore = null
    initialScrollRestored = true
    let secondRaf = 0
    const raf = window.requestAnimationFrame(() => {
      secondRaf = window.requestAnimationFrame(() => window.scrollTo({ left: scrollPosition.x, top: scrollPosition.y, behavior: "instant" }))
    })
    onCleanup(() => {
      window.cancelAnimationFrame(raf)
      if (secondRaf) window.cancelAnimationFrame(secondRaf)
    })
  })

  createEffect(() => {
    if (isPublishedView) {
      setRendering(false)
      return
    }
    const markdown = renderedMarkdown()
    if (markdown.trim() === "") {
      setDocument(null)
      setRendering(false)
      return
    }
    const controller = new AbortController()
    setRendering(true)
    void runDocumentViewerPromise(loadDocument(markdown), controller.signal)
      .then(setDocument)
      .catch((error) => {
        if (!controller.signal.aborted) showToast({ variant: "error", description: errorMessage(error, "Unable to render document.") })
      })
      .finally(() => {
        if (!controller.signal.aborted) setRendering(false)
      })
    onCleanup(() => controller.abort())
  })

  createEffect(() => {
    if (isPublishedView) {
      setRecentDocuments([])
      return
    }
    const controller = new AbortController()
    void refreshRecentDocuments(controller.signal).catch(() => {
      if (!controller.signal.aborted) setRecentDocuments([])
    })
    onCleanup(() => controller.abort())
  })

  createEffect(() => {
    const activeId = activeDocumentId()
    if (isPublishedView || !activeId) {
      setComments([])
      return
    }
    const controller = new AbortController()
    void refreshComments(activeId, controller.signal).catch(() => {
      if (!controller.signal.aborted) {
        setComments([])
      }
    })
    onCleanup(() => controller.abort())
  })

  onMount(() => {
    const controller = new AbortController()
    const documentId = initialDocumentId
    if (documentId) {
      void (async () => {
        setSourceLoading(true)
        setSourceError("")
        setSourceStatus("Loading document…")
        try {
          const result = await runDocumentViewerPromise(loadHostedDocument(documentId), controller.signal)
          activeDocumentIdRef = documentId
          activeDocumentUpdatedAtRef = result.updatedAt
          setActiveDocumentId(documentId)
          setCurrentRevisionId(result.currentRevisionId)
          setDisplayedRevisionId(result.revisionId)
          setRenderedMarkdown(result.markdown)
          await refreshRevisions(documentId, controller.signal)
          setSourceStatus("")
        } catch (error) {
          if (!controller.signal.aborted) {
            const message = errorMessage(error, "Unable to load document.")
            setSourceError(message)
            setSourceStatus(message)
          }
        } finally {
          if (!controller.signal.aborted) setSourceLoading(false)
        }
      })()
    } else if (initialPublishedSlug) {
      void (async () => {
        setSourceLoading(true)
        setSourceError("")
        setSourceStatus("Loading published document…")
        try {
          const snapshot = await runDocumentViewerPromise(loadPublishedDocumentSnapshot(initialPublishedSlug), controller.signal)
          setPublishedSnapshot(snapshot)
          setPublishedAnnotations(loadPublishedAnnotations(snapshot))
          setDisplayedRevisionId(publishedSnapshotRevisionId(snapshot))
          setRenderedMarkdown(snapshot.markdown)
          setDocument(snapshot.document)
          setRendering(false)
          setSourceStatus(`Loaded published snapshot ${snapshot.slug}.`)
        } catch (error) {
          if (!controller.signal.aborted) {
            const message = errorMessage(error, "Unable to load published snapshot.")
            setSourceError(message)
            setSourceStatus(message)
          }
        } finally {
          if (!controller.signal.aborted) setSourceLoading(false)
        }
      })()
    } else {
      const src = initialMarkdownUrl
      if (src) {
        void (async () => {
          setSourceLoading(true)
          setSourceError("")
          setSourceStatus("Loading markdown source…")
          try {
            const result = await runDocumentViewerPromise(loadRemoteMarkdown(src), controller.signal)
            if (!result.ok) {
              setSourceError(result.message)
              setSourceStatus(result.message)
              return
            }
            setMarkdownUrl(src)
            activeDocumentUpdatedAtRef = ""
            setActiveDocumentId("")
            setRenderedMarkdown(result.markdown)
            setSourceStatus(`Loaded markdown from ${result.sourceUrl}.`)
          } catch (error) {
            if (!controller.signal.aborted) {
              const message = errorMessage(error, "Unable to load markdown source.")
              setSourceError(message)
              setSourceStatus(message)
            }
          } finally {
            if (!controller.signal.aborted) setSourceLoading(false)
          }
        })()
      }
    }
    onCleanup(() => controller.abort())
  })

  onMount(() => {
    if (isPublishedView) return
    const source = new EventSource("/api/events")
    const refreshControllers = {
      document: undefined as AbortController | undefined,
      comments: undefined as AbortController | undefined,
      recent: undefined as AbortController | undefined,
    }
    const replaceController = (kind: keyof typeof refreshControllers) => {
      refreshControllers[kind]?.abort()
      const controller = new AbortController()
      refreshControllers[kind] = controller
      return controller
    }
    const parseEvent = (event: MessageEvent<string>) => {
      try {
        return JSON.parse(event.data) as { documentId?: string }
      } catch {
        return null
      }
    }
    const onDocumentUpdated = (event: MessageEvent<string>) => {
      const payload = parseEvent(event)
      if (payload?.documentId && payload.documentId === activeDocumentIdRef) {
        const controller = replaceController("document")
        void refreshActiveDocument(controller.signal).catch((error) => {
          if (!controller.signal.aborted) showToast({ variant: "error", description: errorMessage(error, "Unable to refresh document.") })
        })
      }
    }
    const onCommentsUpdated = (event: MessageEvent<string>) => {
      const payload = parseEvent(event)
      if (payload?.documentId && payload.documentId === activeDocumentIdRef) {
        const controller = replaceController("comments")
        void refreshComments(payload.documentId, controller.signal).catch((error) => {
          if (!controller.signal.aborted) showToast({ variant: "error", description: errorMessage(error, "Unable to refresh comments.") })
        })
      }
    }
    const onRecentDocumentsUpdated = () => {
      const controller = replaceController("recent")
      void refreshRecentDocuments(controller.signal).catch((error) => {
        if (!controller.signal.aborted) showToast({ variant: "error", description: errorMessage(error, "Unable to refresh recent documents.") })
      })
    }
    const onDocumentDeleted = (event: MessageEvent<string>) => {
      const payload = parseEvent(event)
      if (payload?.documentId && payload.documentId === activeDocumentIdRef) window.location.assign("/")
    }
    source.addEventListener("document-updated", onDocumentUpdated as EventListener)
    source.addEventListener("document-deleted", onDocumentDeleted as EventListener)
    source.addEventListener("comments-updated", onCommentsUpdated as EventListener)
    source.addEventListener("recent-documents-updated", onRecentDocumentsUpdated)
    onCleanup(() => {
      source.removeEventListener("document-updated", onDocumentUpdated as EventListener)
      source.removeEventListener("document-deleted", onDocumentDeleted as EventListener)
      source.removeEventListener("comments-updated", onCommentsUpdated as EventListener)
      source.removeEventListener("recent-documents-updated", onRecentDocumentsUpdated)
      source.close()
      refreshControllers.document?.abort()
      refreshControllers.comments?.abort()
      refreshControllers.recent?.abort()
    })
  })

  createEffect(() => {
    const pill = selectionPill()
    if (!pill) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearPendingComment()
        return
      }
      const target = event.target
      const isTyping = target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable)
      if (event.key.toLowerCase() === "a" && !event.metaKey && !event.ctrlKey && !event.altKey && !isTyping) {
        event.preventDefault()
        setPendingComment(pill)
        setSelectionPill(null)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown))
  })

  const renderRail = (mobile: boolean) => (
    <RailContent
      isPublishedView={isPublishedView}
      publishedTitle={publishedSnapshot()?.title ?? ""}
      publishedSlug={initialPublishedSlug}
      publishStatus={publishStatus()}
      publishedRemote={publishedRemote()}
      publishing={publishing()}
      hasDocument={canPublish()}
      recentDocuments={recentDocuments()}
      activeDocumentId={activeDocumentId()}
      revisions={revisions()}
      displayedRevisionId={displayedRevisionId()}
      currentRevisionId={currentRevisionId()}
      diffView={diffView()}
      comments={displayedComments()}
      activeCommentId={hoveredCommentId()}
      clearingComments={clearingComments()}
      deletingDocument={deletingDocument()}
      sourceStatus={sourceStatus()}
      editorOpen={editorOpen()}
      headings={headings()}
      showActions={mobile}
      hasPublishedSnapshot={publishedSnapshot() !== null}
      onPublish={() => void publishCurrentDocument()}
      onCopyAnnotations={copyAnnotations}
      onCopyMarkdown={copyMarkdown}
      onClearComments={() => void clearAllComments()}
      onDeleteDocument={() => void deleteCurrentDocument()}
      onViewRevision={(revision) => {
        if (mobile) setSidebarOpen(false)
        void viewRevision(revision)
      }}
      onViewDiff={(revision) => {
        if (mobile) setSidebarOpen(false)
        void viewRevisionDiff(revision)
      }}
      onCommentHover={setHoveredCommentId}
      onCommentEdit={(commentId) => {
        if (mobile) setSidebarOpen(false)
        openCommentEditor(commentId)
      }}
    />
  )

  return (
    <main class="app-root">
      <ToastRegion />
      <header class="topbar">
        <div class="page-grid topbar-grid">
          <div class="topbar-row">
            <BeholdWordmark />
            <nav class="topbar-tabs" aria-label="Document actions">
              <Show when={isPublishedView} fallback={
                <Show
                  when={canPublish()}
                  fallback={<button type="button" class="tab tab-desktop" onClick={copyMarkdown}>Copy Markdown</button>}
                >
                  <button type="button" class="tab tab-desktop" onClick={() => void publishCurrentDocument()} disabled={publishing()}>{publishing() ? "Publishing…" : "Publish"}</button>
                </Show>
              }>
                <button type="button" class="tab tab-desktop" onClick={copyAnnotations} disabled={!publishedSnapshot()}>Copy annotations</button>
                <button type="button" class="tab tab-desktop" onClick={copyMarkdown} disabled={!publishedSnapshot()}>Copy Markdown</button>
              </Show>
              <button
                ref={(element) => (mobileMenuButton = element)}
                type="button"
                class="tab tab-menu"
                aria-expanded={sidebarOpen()}
                aria-controls="mobile-sidebar"
                onClick={() => setSidebarOpen((open) => !open)}
              >
                Menu
              </button>
            </nav>
          </div>
        </div>
      </header>
      <div class="hatch" aria-hidden="true"><div class="page-grid hatch-grid"><div class="hatch-cell" /></div></div>
      <MobileSidebarDrawer
        open={sidebarOpen()}
        onOpenChange={setSidebarOpen}
        restoreFocus={() => window.requestAnimationFrame(() => mobileMenuButton?.focus())}
      >
        {renderRail(true)}
      </MobileSidebarDrawer>
      <div class="page-grid body-grid">
        <aside class="rail" aria-label="Document rail">
          <div class="rail-sticky">
            {renderRail(false)}
          </div>
        </aside>
        <section class="content" aria-label="Document preview">
          <DocumentLoadState
            sourceLoading={sourceLoading()}
            sourceError={sourceError()}
            rendering={rendering()}
            hasDocument={!!document()}
            editorOpen={editorOpen()}
            hasSections={(document()?.sections.length ?? 0) > 0}
          />
          <Show when={!rendering() && !document() && editorOpen()}>
            <article class="document-flow" onClick={onFlowClick}><MarkdownBlock text={landingMarkdown} highlighterRevision={highlighterRevision()} /></article>
          </Show>
          <Show when={document()}>
            {(currentDocument) => (
              <article class="document-flow" classList={{ "document-flow-comment-hover": hoveredCommentId() !== null }} onClick={onFlowClick} onMouseMove={onFlowMouseMove} onMouseLeave={() => setHoveredCommentId(null)} onMouseUp={captureSelectionForComment} onKeyUp={captureSelectionForComment}>
                <DocumentSections sections={currentDocument().sections} highlighterRevision={highlighterRevision()} />
              </article>
            )}
          </Show>
        </section>
      </div>
      <For each={highlightRects()}>{(rect) => <div class="selection-highlight" style={{ top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` }} />}</For>
      <For each={commentHighlightRects()}>{(rect) => <div class="comment-highlight" classList={{ "comment-highlight-active": rect.commentId === hoveredCommentId() || rect.commentId === pendingComment()?.commentId }} style={{ top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` }} />}</For>
      <Show when={!pendingComment() && selectionPill()}>
        {(pill) => (
          <button
            type="button"
            class="annotate-pill"
            style={{
              top: `${pill().rect.top - 6}px`,
              left: `${clamp(pill().rect.left + pill().rect.width / 2, window.scrollX + 72, window.scrollX + window.innerWidth - 72)}px`,
            }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setPendingComment(pill())
              setSelectionPill(null)
            }}
          >
            Annotate
          </button>
        )}
      </Show>
      <Show keyed when={pendingComment()}>{(pending) => <CommentPopover pending={pending} onSave={(text) => void saveComment(text)} onCancel={clearPendingComment} onDelete={isPublishedView && pending.commentId ? deletePublishedComment : undefined} saving={savingComment()} />}</Show>
      <Show when={mermaidZoom()}>{(zoom) => <MermaidZoomOverlay zoom={zoom()} onClose={() => setMermaidZoom(null)} />}</Show>
    </main>
  )
}

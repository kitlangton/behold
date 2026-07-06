import type { DocumentComment, DocumentCommentAnchor, DocumentCommentLocation } from "./document-viewer"

const contextSize = 80

const textNodes = (element: HTMLElement): ReadonlyArray<Text> => {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const nodes: Array<Text> = []
  let current = walker.nextNode()
  while (current) {
    nodes.push(current as Text)
    current = walker.nextNode()
  }
  return nodes
}

const renderedText = (element: HTMLElement) => textNodes(element).map((node) => node.data).join("")

const boundaryOffset = (element: HTMLElement, node: Node, offset: number): number | null => {
  const range = element.ownerDocument.createRange()
  range.selectNodeContents(element)
  try {
    range.setEnd(node, offset)
  } catch {
    return null
  }
  return range.toString().length
}

const lineForOffset = (text: string, offset: number) => text.slice(0, offset).split("\n").length

const allOccurrences = (text: string, exact: string): ReadonlyArray<number> => {
  const offsets: Array<number> = []
  let offset = text.indexOf(exact)
  while (offset >= 0) {
    offsets.push(offset)
    offset = text.indexOf(exact, offset + 1)
  }
  return offsets
}

const matchesContext = (text: string, offset: number, exact: string, prefix: string, suffix: string) => {
  const before = text.slice(Math.max(0, offset - prefix.length), offset)
  const after = text.slice(offset + exact.length, offset + exact.length + suffix.length)
  return (prefix === "" || before.endsWith(prefix)) && (suffix === "" || after.startsWith(suffix))
}

const uniqueQuoteOffset = (text: string, exact: string, prefix: string, suffix: string): number | null => {
  const occurrences = allOccurrences(text, exact)
  if (occurrences.length === 1) return occurrences[0]
  const contextual = occurrences.filter((offset) => matchesContext(text, offset, exact, prefix, suffix))
  if (contextual.length === 1) return contextual[0]
  const prefixMatches = occurrences.filter((offset) => matchesContext(text, offset, exact, prefix, ""))
  if (prefix !== "" && prefixMatches.length === 1) return prefixMatches[0]
  const suffixMatches = occurrences.filter((offset) => matchesContext(text, offset, exact, "", suffix))
  return suffix !== "" && suffixMatches.length === 1 ? suffixMatches[0] : null
}

export const findTextRangeAt = (element: HTMLElement, start: number, end: number): Range | null => {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return null
  const nodes = textNodes(element)
  let cursor = 0
  let startNode: Text | undefined
  let endNode: Text | undefined
  let startOffset = 0
  let endOffset = 0

  for (const node of nodes) {
    const next = cursor + node.data.length
    if (!startNode && start >= cursor && start <= next) {
      startNode = node
      startOffset = start - cursor
    }
    if (!endNode && end >= cursor && end <= next) {
      endNode = node
      endOffset = end - cursor
      break
    }
    cursor = next
  }
  if (!startNode || !endNode) return null

  const range = element.ownerDocument.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  return range
}

export const buildCommentAnchor = (
  element: HTMLElement,
  range: Range,
  revisionId: string,
  markdown: string,
): { readonly anchor: DocumentCommentAnchor; readonly location: DocumentCommentLocation } | null => {
  const startBoundary = boundaryOffset(element, range.startContainer, range.startOffset)
  const endBoundary = boundaryOffset(element, range.endContainer, range.endOffset)
  if (startBoundary === null || endBoundary === null) return null

  const text = renderedText(element)
  const raw = text.slice(startBoundary, endBoundary)
  const leading = raw.length - raw.trimStart().length
  const trailing = raw.length - raw.trimEnd().length
  const start = startBoundary + leading
  const end = endBoundary - trailing
  const exact = text.slice(start, end)
  if (exact === "") return null

  const prefix = text.slice(Math.max(0, start - contextSize), start)
  const suffix = text.slice(end, end + contextSize)
  const sourceOffset = uniqueQuoteOffset(markdown, exact, prefix, suffix)
  const source = sourceOffset === null
    ? undefined
    : {
        startUtf16: sourceOffset,
        endUtf16: sourceOffset + exact.length,
        startLine: lineForOffset(markdown, sourceOffset),
        endLine: lineForOffset(markdown, sourceOffset + exact.length),
      }

  return {
    anchor: {
      revisionId,
      plane: "rendered-text-v1",
      range: { start, end },
      quote: { exact, prefix, suffix },
      source,
    },
    location: {
      sectionIndex: Number(element.dataset.sectionIndex ?? 0),
      sectionType: "markdown",
      selectedText: exact,
      contextBefore: prefix,
      contextAfter: suffix,
      focusStartLine: source?.startLine,
      focusEndLine: source?.endLine,
    },
  }
}

export const resolveCommentRange = (
  element: HTMLElement,
  comment: DocumentComment,
  displayedRevisionId: string,
): Range | null => {
  const text = renderedText(element)
  const anchor = comment.anchor
  if (anchor) {
    if (
      anchor.revisionId === displayedRevisionId &&
      text.slice(anchor.range.start, anchor.range.end) === anchor.quote.exact
    ) {
      return findTextRangeAt(element, anchor.range.start, anchor.range.end)
    }
    const relocated = uniqueQuoteOffset(text, anchor.quote.exact, anchor.quote.prefix, anchor.quote.suffix)
    return relocated === null ? null : findTextRangeAt(element, relocated, relocated + anchor.quote.exact.length)
  }

  const { selectedText, contextBefore, contextAfter } = comment.location
  const legacyOffset = uniqueQuoteOffset(text, selectedText, contextBefore, contextAfter)
  return legacyOffset === null ? null : findTextRangeAt(element, legacyOffset, legacyOffset + selectedText.length)
}

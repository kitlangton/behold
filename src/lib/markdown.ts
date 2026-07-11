import { Marked, type Tokens } from "marked"
import { highlight } from "./highlighter"
import { parseFenceInfo, renderEnhancedCodeBlock, renderRichBlock } from "./rich-blocks"
import { safeResourceUrl } from "./safe-url"

export interface TocEntry {
  readonly id: string
  readonly text: string
  readonly depth: number
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")

export const markdownInlineToText = (text: string): string =>
  text.replace(/`([^`]*)`/g, "$1").replace(/\*\*(.+?)\*\*/g, "$1")

export const hasFencedCode = (text: string): boolean => /^ {0,3}(?:`{3,}|~{3,})/m.test(text)

export const hasMermaidFence = (text: string): boolean => /^ {0,3}(?:`{3,}|~{3,})mermaid(?:\s|$)/m.test(text)

const treeLinePattern = /^([\s│├└┬─]*)(.*)$/

const treeGuideClass = (character: string): string => {
  switch (character) {
    case "│": return "tree-guide-vertical"
    case "├": return "tree-guide-branch"
    case "└": return "tree-guide-elbow"
    case "┬": return "tree-guide-tee"
    case "─": return "tree-guide-horizontal"
    default: return "tree-guide-space"
  }
}

const renderTreeGuide = (guide: string): string => {
  const characters = Array.from(guide).flatMap((character) => character === "\t" ? [" ", " ", " ", " "] : [character])
  return characters.map((character) => `<span class="tree-guide-cell ${treeGuideClass(character)}"></span>`).join("")
}

const treeLevel = (guide: string): number => {
  const branch = Math.max(guide.lastIndexOf("├"), guide.lastIndexOf("└"), guide.lastIndexOf("┬"))
  return branch < 0 ? 1 : Math.floor(branch / 4) + 2
}

const renderTreeBlock = (source: string): string => {
  const lines = source.replace(/\s+$/, "").split("\n")
  const rendered = lines.map((line) => {
    const match = treeLinePattern.exec(line)
    const guide = match?.[1] ?? ""
    const rest = match?.[2] ?? line
    const commentIndex = rest.search(/\s#(?:\s|$)|^#(?:\s|$)/)
    const body = commentIndex >= 0 ? rest.slice(0, commentIndex) : rest
    const comment = commentIndex >= 0 ? rest.slice(commentIndex) : ""
    const nameClass = body.trimEnd().endsWith("/") ? "tree-dir" : "tree-name"
    const parts = [
      guide === "" ? "" : `<span class="tree-guide" aria-hidden="true">${renderTreeGuide(guide)}</span>`,
      body === "" ? "" : `<span class="${nameClass}">${escapeHtml(body)}</span>`,
      comment === "" ? "" : `<span class="tree-comment">${escapeHtml(comment)}</span>`,
    ]
    return `<div class="tree-line" role="treeitem" aria-level="${treeLevel(guide)}">${parts.join("")}</div>`
  })
  return `<div class="tree-block" role="tree" aria-label="Tree">${rendered.join("")}</div>`
}

const renderDiffBlock = (source: string): string => {
  const rendered = source.replace(/\n$/, "").split("\n").map((line) => {
    const isFileHeader = line.startsWith("+++ ") || line.startsWith("--- ")
    const kind = line.startsWith("@@")
      ? "hunk"
      : !isFileHeader && line.startsWith("+")
        ? "added"
        : !isFileHeader && line.startsWith("-")
          ? "removed"
          : isFileHeader || /^(diff --git|index |new file mode |deleted file mode |rename (from|to) |\\ No newline)/.test(line)
            ? "meta"
            : "context"
    const hasMarker = kind === "added" || kind === "removed" || (kind === "context" && line.startsWith(" "))
    const marker = hasMarker ? line[0] : ""
    const content = hasMarker ? line.slice(1) : line
    return `<span class="diff-line diff-${kind}"><span class="diff-marker">${escapeHtml(marker)}</span><span class="diff-content">${escapeHtml(content)}</span></span>`
  })
  return `<div class="diff-block" role="region" aria-label="Diff">${rendered.join("")}</div>`
}

const renderJsonKey = (key: string | undefined): string =>
  key === undefined
    ? ""
    : `<span class="json-key">${escapeHtml(JSON.stringify(key))}</span><span class="json-punctuation">: </span>`

const renderJsonPrimitive = (value: string | number | boolean | null): string => {
  const kind = value === null ? "null" : typeof value
  return `<span class="json-${kind}">${escapeHtml(JSON.stringify(value))}</span>`
}

const renderJsonValue = (value: unknown, key?: string, depth = 0): string => {
  const prefix = renderJsonKey(key)
  if (value === null || typeof value !== "object") {
    return `<div class="json-entry">${prefix}${renderJsonPrimitive(value as string | number | boolean | null)}</div>`
  }

  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value)
  const opening = Array.isArray(value) ? "[" : "{"
  const closing = Array.isArray(value) ? "]" : "}"
  if (entries.length === 0) {
    return `<div class="json-entry">${prefix}<span class="json-punctuation">${opening}${closing}</span></div>`
  }

  const count = `${entries.length} ${Array.isArray(value) ? (entries.length === 1 ? "item" : "items") : (entries.length === 1 ? "key" : "keys")}`
  const children = entries.map(([childKey, child]) => renderJsonValue(child, childKey, depth + 1)).join("")
  return `<details class="json-branch"${depth < 2 ? " open" : ""}><summary>${prefix}<span class="json-punctuation">${opening}</span><span class="json-count">${count}</span></summary><div class="json-children">${children}</div><div class="json-close">${closing}</div></details>`
}

const renderJsonBlock = (source: string): string | undefined => {
  try {
    return `<div class="json-block" role="region" aria-label="JSON">${renderJsonValue(JSON.parse(source))}</div>`
  } catch {
    return undefined
  }
}

const copyButtonIcons =
  `<svg class="copy-icon copy-icon-copy" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="1.5"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/></svg>` +
  `<svg class="copy-icon copy-icon-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`

const renderCopyableBlock = (html: string, source: string): string =>
  `<div class="code-block-shell" data-copy-code="${escapeHtml(source)}"><button type="button" class="code-copy-button" aria-label="Copy code" data-label="Copy">${copyButtonIcons}</button>${html}</div>`

const copySource = (language: string, source: string): string => {
  if (language !== "shell") return source
  const commands = source.split("\n").flatMap((line) => line.startsWith("$ ") ? [line.slice(2)] : [])
  return commands.length === 0 ? source : commands.join("\n")
}

const marked = new Marked({
  breaks: true,
  gfm: true,
})

marked.use({
  renderer: {
    html(token) {
      return escapeHtml(token.text)
    },
    heading(token) {
      const text = this.parser.parseInline(token.tokens)
      const id = slugify(token.text)
      return `<h${token.depth} id="${escapeHtml(id)}">${text}</h${token.depth}>\n`
    },
    table(token) {
      const renderRow = (cells: ReadonlyArray<Tokens.TableCell>) => `<tr>${cells.map((cell) => {
        const tag = cell.header ? "th" : "td"
        const align = cell.align ? ` align="${cell.align}"` : ""
        return `<${tag}${align}>${this.parser.parseInline(cell.tokens)}</${tag}>`
      }).join("")}</tr>`
      const body = token.rows.map(renderRow).join("")
      return `<div class="markdown-table-scroll"><table><thead>${renderRow(token.header)}</thead>${body ? `<tbody>${body}</tbody>` : ""}</table></div>\n`
    },
    code(token) {
      const fence = parseFenceInfo(token.lang)
      if (fence.language === "mermaid") {
        const encoded = globalThis.btoa(unescape(encodeURIComponent(token.text)))
        return renderCopyableBlock(`<div class="mermaid-block" data-mermaid-b64="${encoded}"></div>`, token.text)
      }
      if (fence.language === "tree") {
        return renderCopyableBlock(renderTreeBlock(token.text), token.text)
      }
      if (fence.language === "diff") {
        return renderCopyableBlock(renderDiffBlock(token.text), token.text)
      }
      if (fence.language === "json") {
        const rendered = renderJsonBlock(token.text)
        if (rendered !== undefined) return renderCopyableBlock(rendered, token.text)
      }
      const rich = renderRichBlock(fence.language, token.text, (value) => marked.parseInline(value, { async: false }) as string)
      if (rich !== undefined) return renderCopyableBlock(rich, copySource(fence.language, token.text))
      const enhanced = renderEnhancedCodeBlock(token.text, fence)
      if (enhanced !== undefined) return renderCopyableBlock(enhanced, token.text)
      const hasTui = /[│┌┐└┘├┤┬┴┼─╭╮╯╰▸▹]/.test(token.text)
      const cls = hasTui ? ' class="pre-tui"' : ""
      const highlighted = highlight(token.text, fence.language)
      if (highlighted) {
        return renderCopyableBlock(hasTui ? highlighted.replace("<pre", `<pre${cls}`) : highlighted, token.text)
      }
      return renderCopyableBlock(`<pre${cls}><code>${escapeHtml(token.text)}</code></pre>`, token.text)
    },
    link(token) {
      const href = safeResourceUrl(token.href, { allowMailto: true })
      const text = this.parser.parseInline(token.tokens)
      if (href === undefined) return text

      let html = `<a href="${escapeHtml(href)}"`
      if (token.title) html += ` title="${escapeHtml(token.title)}"`
      const url = href.startsWith("http://") || href.startsWith("https://") ? new URL(href) : undefined
      const favicon = url === undefined
        ? ""
        : `<span class="link-favicon${url.hostname === "github.com" ? " link-favicon-github" : ""}" style="background-image:url('${escapeHtml(url.hostname === "github.com" ? "https://github.com/favicon.ico" : `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=32`)}')" aria-hidden="true"></span>`
      html += `>${favicon}${text}</a>`
      return html
    },
    image(token) {
      const href = safeResourceUrl(token.href)
      const text = token.tokens ? this.parser.parseInline(token.tokens, this.parser.textRenderer) : token.text
      if (href === undefined) return escapeHtml(text)

      let html = `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"`
      if (token.title) html += ` title="${escapeHtml(token.title)}"`
      html += ">"
      return html
    },
  },
})

const calloutPattern = /<blockquote>\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*<br\s*\/?>/gi

const transformCallouts = (html: string): string =>
  html.replace(calloutPattern, (_match, type: string) => {
    const key = type.toLowerCase()
    return `<blockquote class="callout callout-${key}"><p>`
  })

export const renderMarkdownToHtml = (text: string): string => {
  try {
    return transformCallouts(marked.parse(text, { async: false }) as string)
  } catch {
    return escapeHtml(text)
  }
}

const headingPattern = /^(#{1,6})\s+(.+)$/gm

export const extractHeadings = (markdown: string): ReadonlyArray<TocEntry> => {
  const entries: TocEntry[] = []
  headingPattern.lastIndex = 0
  let match = headingPattern.exec(markdown)
  while (match) {
    const raw = markdownInlineToText(match[2])
    entries.push({ id: slugify(raw), text: raw, depth: match[1].length })
    match = headingPattern.exec(markdown)
  }
  return entries
}

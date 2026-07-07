import { describe, expect, it } from "vitest"
import { initHighlighter } from "../src/lib/highlighter"
import { extractHeadings, hasFencedCode, hasMermaidFence, renderMarkdownToHtml } from "../src/lib/markdown"

describe("markdown safety", () => {
  it("escapes raw HTML", () => {
    const html = renderMarkdownToHtml("Hello <script>alert(1)</script> <b>bold</b>")

    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;")
    expect(html).not.toContain("<script>")
  })

  it("rejects javascript and data links while retaining safe link text", () => {
    const html = renderMarkdownToHtml("[bad](javascript:alert(1)) [image](data:text/html,hi)")

    expect(html).toContain("bad")
    expect(html).toContain("image")
    expect(html).not.toContain("href=\"javascript:")
    expect(html).not.toContain("href=\"data:")
  })

  it("retains safe absolute, relative, hash, and mailto links", () => {
    const html = renderMarkdownToHtml("[site](https://example.com/a?b=1) [rel](./doc.md) [hash](#part) [mail](mailto:kit@example.com)")

    expect(html).toContain('href="https://example.com/a?b=1"')
    expect(html).toContain('class="link-favicon" style="background-image:url(\'https://www.google.com/s2/favicons?domain=example.com&amp;sz=32\')"')
    expect(html).toContain('href="./doc.md"')
    expect(html).toContain('href="#part"')
    expect(html).toContain('href="mailto:kit@example.com"')
    expect(html.match(/class="link-favicon"/g)).toHaveLength(1)
  })

  it("marks GitHub favicons for monochrome tinting", () => {
    const html = renderMarkdownToHtml("[issue](https://github.com/anomalyco/opencode/issues/35448)")

    expect(html).toContain('class="link-favicon link-favicon-github"')
    expect(html).toContain("background-image:url('https://github.com/favicon.ico')")
  })
})

describe("markdown outline", () => {
  it("includes every supported markdown heading level", () => {
    const headings = extractHeadings("# One\n\n#### Four\n\n##### Five\n\n###### Six")

    expect(headings).toEqual([
      { id: "one", text: "One", depth: 1 },
      { id: "four", text: "Four", depth: 4 },
      { id: "five", text: "Five", depth: 5 },
      { id: "six", text: "Six", depth: 6 },
    ])
  })
})

describe("typed fenced blocks", () => {
  it("detects backtick and tilde fences for lazy renderers", () => {
    expect(hasFencedCode("```ts\nconst value = 1\n```")).toBe(true)
    expect(hasFencedCode("~~~ts\nconst value = 1\n~~~")).toBe(true)
    expect(hasMermaidFence("~~~mermaid\nflowchart LR\n  A --> B\n~~~")).toBe(true)
  })

  it("adds an accessible copy control without exposing unescaped source", () => {
    const html = renderMarkdownToHtml('```text\nvalue "<&>"\n```')

    expect(html).toContain('class="code-copy-button"')
    expect(html).toContain('aria-label="Copy code"')
    expect(html).toContain('data-copy-code="value &quot;&lt;&amp;&gt;&quot;"')
    expect(html).not.toContain('data-copy-code="value "<&>""')
  })

  it("renders shell prompts separately and copies executable commands without prompts", () => {
    const html = renderMarkdownToHtml("```shell\n$ bunx @kitlangton/behold setup\nConfigured OpenCode\n```")

    expect(html).toContain('class="rich-block terminal-block shell-block"')
    expect(html).toContain('class="shell-prompt" aria-hidden="true">$</span>')
    expect(html).toContain('class="shell-line shell-output">Configured OpenCode</span>')
    expect(html).toContain('data-copy-code="bunx @kitlangton/behold setup"')
  })

  it("renders diffs as semantic lines and escapes their content", () => {
    const html = renderMarkdownToHtml("```diff\n@@ -1 +1 @@\n-old <value>\n+new <value>\n```")

    expect(html).toContain('class="diff-block"')
    expect(html).toContain('class="diff-line diff-hunk"')
    expect(html).toContain('class="diff-line diff-removed"')
    expect(html).toContain('class="diff-line diff-added"')
    expect(html).toContain("old &lt;value&gt;")
    expect(html).not.toContain("old <value>")
  })

  it("renders tree guides as connected semantic cells", () => {
    const html = renderMarkdownToHtml("```tree\nroot/\n├── first\n└── nested/\n    └── child # note\n```")

    expect(html).toContain('class="tree-block" role="tree" aria-label="Tree"')
    expect(html).toContain('class="tree-line" role="treeitem" aria-level="3"')
    expect(html).toContain('class="tree-guide-cell tree-guide-branch"')
    expect(html).toContain('class="tree-guide-cell tree-guide-elbow"')
    expect(html).toContain('<span class="tree-dir">nested/</span>')
    expect(html).toContain('<span class="tree-comment"> # note</span>')
  })

  it("renders valid JSON as a collapsible escaped tree", () => {
    const html = renderMarkdownToHtml('```json\n{"name":"<script>","items":[1,true,null]}\n```')

    expect(html).toContain('class="json-block"')
    expect(html).toContain('class="json-branch"')
    expect(html).toContain('class="json-string"')
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
  })

  it("falls invalid JSON back to an ordinary code block", () => {
    const html = renderMarkdownToHtml("```json\n{not json}\n```")

    expect(html).not.toContain('class="json-block"')
    expect(html).toContain("{not json}")
  })

  it("renders OpenAPI YAML as a compact API reference", () => {
    const html = renderMarkdownToHtml(`\`\`\`openapi
openapi: 3.1.0
info:
  title: Orders API
  version: 1.0.0
  description: Create **orders** with \`POST\` safely.
paths:
  /orders:
    post:
      summary: Create an order
      parameters:
        - name: Idempotency-Key
          in: header
          required: true
          schema: { type: string }
      responses:
        "201": { description: Created }
\`\`\``)

    expect(html).toContain('class="rich-block openapi-block"')
    expect(html).toContain("Orders API")
    expect(html).toContain('class="api-method api-method-post"')
    expect(html).toContain("Idempotency-Key")
    expect(html).toContain("Create <strong>orders</strong> with <code>POST</code> safely.")
  })

  it("renders HTTP wire messages as a request and response exchange", () => {
    const html = renderMarkdownToHtml(`\`\`\`http
POST /orders HTTP/1.1
Content-Type: application/json

{"sku":"book"}

HTTP/1.1 201 Created
Content-Type: application/json

{"id":"ord_123"}
\`\`\``)

    expect(html).toContain('class="rich-block http-block"')
    expect(html).toContain('class="http-message http-request"')
    expect(html).toContain('class="http-message http-response"')
    expect(html).toContain("ord_123")
  })

  it("renders ANSI terminal output while escaping its text", () => {
    const html = renderMarkdownToHtml("```terminal\n$ build\n\u001b[32mPASS\u001b[0m <script>\n```")

    expect(html).toContain('class="rich-block terminal-block"')
    expect(html).toContain('class="ansi-green"')
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
  })

  it("frames ordinary code with file, line, highlight, and caption metadata", () => {
    const html = renderMarkdownToHtml('```typescript title="src/order.ts" start=42 highlight=43 caption="Order validation"\nconst safe = true\nconst value = "<unsafe>"\n```')

    expect(html).toContain('class="code-frame"')
    expect(html).toContain("src/order.ts")
    expect(html).toContain('class="code-line code-line-highlight"')
    expect(html).toContain(">43<")
    expect(html).toContain("Order validation")
    expect(html).toContain("&lt;unsafe&gt;")
  })

  it("renders JSON Schema YAML as a nested property view", () => {
    const html = renderMarkdownToHtml(`\`\`\`schema
title: Order
type: object
required: [id]
properties:
  id:
    type: string
    description: Stable **order** \`identifier\`
  items:
    type: array
    items: { type: string }
\`\`\``)

    expect(html).toContain('class="rich-block schema-block"')
    expect(html).toContain("Order")
    expect(html).toContain("Stable <strong>order</strong> <code>identifier</code>")
    expect(html).toContain("required")
  })

  it("renders oneOf schemas as named alternatives instead of an empty type label", () => {
    const html = renderMarkdownToHtml(`\`\`\`schema
oneOf:
  - title: Durable update
    type: object
    required: [kind, seq]
    properties:
      kind: { const: durable }
      seq: { type: integer }
  - title: Ephemeral update
    type: object
    required: [kind]
    properties:
      kind: { const: ephemeral }
\`\`\``)

    expect(html).toContain("Alternative shapes")
    expect(html).toContain("Exactly one shape")
    expect(html).toContain("Durable update")
    expect(html).toContain("Ephemeral update")
    expect(html).toContain("seq")
    expect(html).not.toContain('>one of</span>')
  })

  it("syntax highlights JSON bodies in compact HTTP message sections", async () => {
    await initHighlighter()
    const html = renderMarkdownToHtml(`\`\`\`http
POST /api/sync HTTP/1.1
Content-Type: application/json

{"pos":"sync_01","timeout":30000}

HTTP/1.1 200 OK
Content-Type: application/json

{"pos":"sync_02","reset":false}
\`\`\``)

    expect(html).toContain('class="http-body http-body-json"')
    expect(html).toContain('style="color:')
    expect(html).toContain('<span class="http-label">Request</span>')
    expect(html).toContain('<span class="http-label">Response</span>')
    expect(html).not.toContain('<div class="http-label">')
  })

  it("renders YAML timelines with semantic statuses", () => {
    const html = renderMarkdownToHtml(`\`\`\`timeline
title: Release
items:
  - time: 09:00
    title: Tests pass
    status: complete
  - time: 09:10
    title: Publish package
    detail: Waiting for \`registry\` **propagation**
    status: current
\`\`\``)

    expect(html).toContain('class="rich-block timeline-block"')
    expect(html).toContain('class="timeline-entry timeline-complete"')
    expect(html).toContain('class="timeline-entry timeline-current"')
    expect(html).toContain("Waiting for <code>registry</code> <strong>propagation</strong>")
  })

  it("renders definition maps as a semantic glossary", () => {
    const html = renderMarkdownToHtml(`\`\`\`definitions
Hosted document:
  definition: A **mutable** local \`review\` artifact.
  aliases: [document]
Snapshot: An immutable public export.
\`\`\``)

    expect(html).toContain('class="rich-block definitions-block"')
    expect(html).toContain("Hosted document")
    expect(html).toContain("A <strong>mutable</strong> local <code>review</code> artifact.")
    expect(html).toContain("document")
  })

  it("wraps tables in a full-width scroll region", () => {
    const html = renderMarkdownToHtml(`| Name | Status |\n| --- | --- |\n| Behold | Ready |`)

    expect(html).toContain('<div class="markdown-table-scroll"><table>')
    expect(html).toContain("<thead><tr><th>Name</th><th>Status</th></tr></thead>")
    expect(html).toContain("<tbody><tr><td>Behold</td><td>Ready</td></tr></tbody>")
  })

  it.each(["openapi", "http", "schema", "timeline", "definitions"])("falls invalid %s input back to ordinary code", (language) => {
    const html = renderMarkdownToHtml(`\`\`\`${language}\nnot valid for this renderer\n\`\`\``)

    expect(html).not.toContain(`class="rich-block ${language}-block"`)
    expect(html).toContain("not valid for this renderer")
  })
})

import { parse as parseYaml } from "yaml"
import { highlightLines } from "./highlighter"
import { safeResourceUrl } from "./safe-url"

type Dictionary = Record<string, unknown>

export interface FenceInfo {
  readonly language: string
  readonly title?: string
  readonly caption?: string
  readonly start: number
  readonly highlights: ReadonlySet<number>
  readonly enhanced: boolean
}

export type RenderInlineMarkdown = (value: string) => string

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

const isDictionary = (value: unknown): value is Dictionary =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined

const textHtml = (value: string): string => escapeHtml(value).replaceAll("\n", "<br>")

const parseStructured = (source: string): unknown => {
  try {
    return JSON.parse(source)
  } catch {
    try {
      return parseYaml(source)
    } catch {
      return undefined
    }
  }
}

const parseHighlights = (value: string | undefined): ReadonlySet<number> => {
  const lines = new Set<number>()
  if (!value) return lines
  for (const part of value.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim())
    if (!match) continue
    const start = Number(match[1])
    const end = Number(match[2] ?? match[1])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start > 1_000) continue
    for (let line = start; line <= end; line += 1) lines.add(line)
  }
  return lines
}

export const parseFenceInfo = (raw: string | undefined): FenceInfo => {
  const value = raw?.trim() ?? ""
  const separator = value.search(/\s/)
  const language = (separator === -1 ? value : value.slice(0, separator)).toLowerCase()
  const metadata = separator === -1 ? "" : value.slice(separator + 1)
  const fields = new Map<string, string>()
  const fieldPattern = /([a-z][\w-]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/gi
  let match = fieldPattern.exec(metadata)
  while (match) {
    fields.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "")
    match = fieldPattern.exec(metadata)
  }
  const parsedStart = Number(fields.get("start") ?? "1")
  return {
    language,
    title: stringValue(fields.get("title")),
    caption: stringValue(fields.get("caption")),
    start: Number.isSafeInteger(parsedStart) && parsedStart > 0 ? parsedStart : 1,
    highlights: parseHighlights(fields.get("highlight")),
    enhanced: fields.has("title") || fields.has("caption") || fields.has("start") || fields.has("highlight"),
  }
}

export const renderEnhancedCodeBlock = (source: string, info: FenceInfo): string | undefined => {
  if (!info.enhanced || info.language === "") return undefined
  const sourceLines = source.split("\n")
  const highlighted = highlightLines(source, info.language)
  const lines = sourceLines.map((line, index) => {
    const number = info.start + index
    const content = highlighted?.[index] ?? escapeHtml(line)
    const selected = info.highlights.has(number) ? " code-line-highlight" : ""
    return `<span class="code-line${selected}"><span class="code-line-number" aria-hidden="true">${number}</span><span class="code-line-content">${content || "&#8203;"}</span></span>`
  }).join("")
  const label = info.title ?? info.language
  const heading = `<div class="code-frame-heading"><span class="code-frame-title">${escapeHtml(label)}</span><span class="code-frame-language">${escapeHtml(info.language)}</span></div>`
  const caption = info.caption ? `<p class="code-frame-caption">${textHtml(info.caption)}</p>` : ""
  return `<figure class="code-frame" aria-label="${escapeHtml(label)}">${heading}<div class="code-scroll"><pre class="code-listing"><code>${lines}</code></pre></div>${caption}</figure>`
}

const schemaType = (schema: Dictionary): string => {
  const explicit = schema.type
  if (Array.isArray(explicit)) return explicit.filter((item): item is string => typeof item === "string").join(" | ") || "value"
  if (typeof explicit === "string") return explicit
  if (typeof schema.$ref === "string") return schema.$ref.split("/").at(-1) ?? "reference"
  if (Array.isArray(schema.enum)) return "enum"
  if (schema.const !== undefined) return "literal"
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) return "union"
  if (Array.isArray(schema.allOf)) return "combined"
  if (isDictionary(schema.properties)) return "object"
  return "value"
}

const renderSchemaConstraints = (schema: Dictionary): string => {
  const constraints: string[] = []
  if (typeof schema.format === "string") constraints.push(schema.format)
  if (schema.const !== undefined) constraints.push(`value: ${JSON.stringify(schema.const)}`)
  if (Array.isArray(schema.enum)) constraints.push(`enum: ${schema.enum.map(String).join(", ")}`)
  if (schema.default !== undefined) constraints.push(`default: ${JSON.stringify(schema.default)}`)
  if (schema.example !== undefined) constraints.push(`example: ${JSON.stringify(schema.example)}`)
  if (typeof schema.pattern === "string") constraints.push(`pattern: ${schema.pattern}`)
  if (typeof schema.minimum === "number") constraints.push(`min: ${schema.minimum}`)
  if (typeof schema.maximum === "number") constraints.push(`max: ${schema.maximum}`)
  if (typeof schema.minLength === "number") constraints.push(`min length: ${schema.minLength}`)
  if (typeof schema.maxLength === "number") constraints.push(`max length: ${schema.maxLength}`)
  return constraints.length === 0 ? "" : `<p class="schema-constraints">${constraints.map(escapeHtml).join(" · ")}</p>`
}

const schemaComposition = (schema: Dictionary): { readonly values: ReadonlyArray<unknown>; readonly label: string; readonly title: string } | undefined => {
  if (Array.isArray(schema.oneOf)) return { values: schema.oneOf, label: "Exactly one shape", title: "Alternative shapes" }
  if (Array.isArray(schema.anyOf)) return { values: schema.anyOf, label: "Any matching shape", title: "Alternative shapes" }
  if (Array.isArray(schema.allOf)) return { values: schema.allOf, label: "Combined shapes", title: "Combined schema" }
  return undefined
}

function renderSchemaComposition(schema: Dictionary, renderInline: RenderInlineMarkdown, depth = 0): string {
  const composition = schemaComposition(schema)
  if (!composition || depth > 5) return ""
  const alternatives = composition.values.flatMap((value, index) => {
    if (!isDictionary(value)) return []
    const title = stringValue(value.title) ?? (typeof value.$ref === "string" ? value.$ref.split("/").at(-1) : undefined) ?? `Option ${index + 1}`
    const description = stringValue(value.description)
    const children = renderSchemaComposition(value, renderInline, depth + 1) || renderSchemaProperties(value, renderInline, depth + 1)
    return [`<section class="schema-alternative"><div class="schema-alternative-heading"><strong>${escapeHtml(title)}</strong><span class="schema-type">${escapeHtml(schemaType(value))}</span></div>${description ? `<p class="rich-prose">${renderInline(description)}</p>` : ""}${renderSchemaConstraints(value)}${children}</section>`]
  }).join("")
  if (alternatives === "") return ""
  return `<div class="schema-composition"><div class="schema-composition-heading"><strong>${composition.label}</strong><span>${composition.values.length} ${composition.values.length === 1 ? "option" : "options"}</span></div><div class="schema-alternatives">${alternatives}</div></div>`
}

function renderSchemaProperties(schema: Dictionary, renderInline: RenderInlineMarkdown, depth = 0): string {
  const properties = isDictionary(schema.properties) ? Object.entries(schema.properties) : []
  if (properties.length === 0 || depth > 5) {
    if (schemaType(schema) === "array" && isDictionary(schema.items)) {
      return `<div class="schema-items"><span class="schema-connector">items</span>${renderSchemaProperties(schema.items, renderInline, depth + 1) || `<span class="schema-type">${escapeHtml(schemaType(schema.items))}</span>`}</div>`
    }
    return ""
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [])
  const rows = properties.map(([name, value]) => {
    const property = isDictionary(value) ? value : {}
    const description = stringValue(property.description)
    const nested = renderSchemaComposition(property, renderInline, depth + 1) || renderSchemaProperties(property, renderInline, depth + 1)
    const badges = `<span class="schema-type">${escapeHtml(schemaType(property))}</span>${required.has(name) ? `<span class="schema-required">required</span>` : ""}`
    const content = `<div class="schema-property-main"><div class="schema-property-heading"><code>${escapeHtml(name)}</code>${badges}</div>${description ? `<p class="rich-prose">${renderInline(description)}</p>` : ""}${renderSchemaConstraints(property)}</div>`
    return nested === ""
      ? `<div class="schema-property">${content}</div>`
      : `<details class="schema-property schema-property-nested"${depth === 0 ? " open" : ""}><summary>${content}</summary>${nested}</details>`
  }).join("")
  return `<div class="schema-properties">${rows}</div>`
}

const renderSchemaPanel = (schema: Dictionary, renderInline: RenderInlineMarkdown, options?: { readonly compact?: boolean }): string => {
  const title = stringValue(schema.title)
  const description = stringValue(schema.description)
  const heading = title || description
    ? `<div class="schema-heading">${title ? `<strong>${escapeHtml(title)}</strong>` : ""}<span class="schema-type">${escapeHtml(schemaType(schema))}</span>${description ? `<p class="rich-prose">${renderInline(description)}</p>` : ""}</div>`
    : ""
  const content = renderSchemaComposition(schema, renderInline) || renderSchemaProperties(schema, renderInline) || `<span class="schema-type schema-type-empty">${escapeHtml(schemaType(schema))}</span>`
  return `<div class="schema-panel${options?.compact ? " schema-panel-compact" : ""}">${heading}${content}</div>`
}

const isSchema = (value: unknown): value is Dictionary =>
  isDictionary(value) && ("type" in value || "properties" in value || "$schema" in value || "$ref" in value || "oneOf" in value || "anyOf" in value || "allOf" in value)

const renderSchemaBlock = (source: string, renderInline: RenderInlineMarkdown): string | undefined => {
  const schema = parseStructured(source)
  if (!isSchema(schema)) return undefined
  const title = stringValue(schema.title) ?? schemaComposition(schema)?.title ?? "Schema"
  return `<div class="rich-block schema-block" role="region" aria-label="${escapeHtml(title)}"><div class="rich-block-heading"><span class="rich-block-kicker">JSON Schema</span><strong>${escapeHtml(title)}</strong></div>${renderSchemaPanel(schema, renderInline)}</div>`
}

const httpMethods = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"])

const renderApiParameters = (parameters: unknown, renderInline: RenderInlineMarkdown): string => {
  if (!Array.isArray(parameters)) return ""
  const rows = parameters.flatMap((value) => {
    if (!isDictionary(value)) return []
    const name = stringValue(value.name) ?? (typeof value.$ref === "string" ? value.$ref.split("/").at(-1) : undefined)
    if (!name) return []
    const location = stringValue(value.in)
    const description = stringValue(value.description)
    const type = isDictionary(value.schema) ? schemaType(value.schema) : "value"
    return [`<div class="api-field"><div class="api-field-heading"><code>${escapeHtml(name)}</code><span>${escapeHtml([location, type].filter(Boolean).join(" · "))}</span>${value.required === true ? `<span class="schema-required">required</span>` : ""}</div>${description ? `<p class="rich-prose">${renderInline(description)}</p>` : ""}</div>`]
  }).join("")
  return rows === "" ? "" : `<section class="api-section"><h4>Parameters</h4><div class="api-fields">${rows}</div></section>`
}

const renderApiContent = (content: unknown, renderInline: RenderInlineMarkdown): string => {
  if (!isDictionary(content)) return ""
  return Object.entries(content).flatMap(([mediaType, value]) => {
    if (!isDictionary(value)) return []
    const schema = isDictionary(value.schema) ? renderSchemaPanel(value.schema, renderInline, { compact: true }) : ""
    const example = value.example === undefined ? "" : `<pre class="api-example"><code>${escapeHtml(typeof value.example === "string" ? value.example : JSON.stringify(value.example, null, 2))}</code></pre>`
    return [`<div class="api-content"><span class="api-media-type">${escapeHtml(mediaType)}</span>${schema}${example}</div>`]
  }).join("")
}

const renderApiRequestBody = (requestBody: unknown, renderInline: RenderInlineMarkdown): string => {
  if (!isDictionary(requestBody)) return ""
  const description = stringValue(requestBody.description)
  const content = renderApiContent(requestBody.content, renderInline)
  if (!description && !content) return ""
  return `<section class="api-section"><h4>Request body${requestBody.required === true ? `<span class="schema-required">required</span>` : ""}</h4>${description ? `<p class="rich-prose">${renderInline(description)}</p>` : ""}${content}</section>`
}

const renderApiResponses = (responses: unknown, renderInline: RenderInlineMarkdown): string => {
  if (!isDictionary(responses)) return ""
  const rows = Object.entries(responses).flatMap(([status, value]) => {
    if (!isDictionary(value)) return []
    const description = stringValue(value.description) ?? "Response"
    const statusClass = /^2/.test(status) ? " api-status-ok" : /^4|^5/.test(status) ? " api-status-error" : ""
    return [`<div class="api-response"><div class="api-response-heading"><code class="api-status${statusClass}">${escapeHtml(status)}</code><span class="rich-prose">${renderInline(description)}</span></div>${renderApiContent(value.content, renderInline)}</div>`]
  }).join("")
  return rows === "" ? "" : `<section class="api-section"><h4>Responses</h4><div class="api-responses">${rows}</div></section>`
}

const renderOpenApiBlock = (source: string, renderInline: RenderInlineMarkdown): string | undefined => {
  const document = parseStructured(source)
  if (!isDictionary(document) || typeof document.openapi !== "string" || !isDictionary(document.paths)) return undefined
  const info = isDictionary(document.info) ? document.info : {}
  const title = stringValue(info.title) ?? "API"
  const version = stringValue(info.version)
  const description = stringValue(info.description)
  const servers = Array.isArray(document.servers)
    ? document.servers.flatMap((server) => isDictionary(server) && stringValue(server.url) ? [stringValue(server.url)!] : [])
    : []
  const operations = Object.entries(document.paths).flatMap(([path, pathValue]) => {
    if (!isDictionary(pathValue)) return []
    const sharedParameters = Array.isArray(pathValue.parameters) ? pathValue.parameters : []
    return Object.entries(pathValue).flatMap(([method, operationValue]) => {
      const normalizedMethod = method.toLowerCase()
      if (!httpMethods.has(normalizedMethod) || !isDictionary(operationValue)) return []
      const summary = stringValue(operationValue.summary) ?? stringValue(operationValue.operationId) ?? "Untitled operation"
      const operationDescription = stringValue(operationValue.description)
      const tags = Array.isArray(operationValue.tags) ? operationValue.tags.filter((tag): tag is string => typeof tag === "string") : []
      const parameters = [...sharedParameters, ...(Array.isArray(operationValue.parameters) ? operationValue.parameters : [])]
      const body = `${operationDescription ? `<p class="api-description rich-prose">${renderInline(operationDescription)}</p>` : ""}${renderApiParameters(parameters, renderInline)}${renderApiRequestBody(operationValue.requestBody, renderInline)}${renderApiResponses(operationValue.responses, renderInline)}`
      return [`<details class="api-operation"><summary><span class="api-method api-method-${normalizedMethod}">${normalizedMethod.toUpperCase()}</span><code class="api-path">${escapeHtml(path)}</code><span class="api-summary">${escapeHtml(summary)}</span>${tags.length > 0 ? `<span class="api-tag">${escapeHtml(tags[0])}</span>` : ""}</summary><div class="api-operation-body">${body || `<p class="api-description">No additional details.</p>`}</div></details>`]
    })
  }).join("")
  if (operations === "") return undefined
  const metadata = `<div class="openapi-meta"><span>OpenAPI ${escapeHtml(document.openapi)}</span>${version ? `<span>v${escapeHtml(version)}</span>` : ""}${servers[0] ? `<code>${escapeHtml(servers[0])}</code>` : ""}</div>`
  return `<div class="rich-block openapi-block" role="region" aria-label="${escapeHtml(title)}"><div class="rich-block-heading"><span class="rich-block-kicker">API reference</span><strong>${escapeHtml(title)}</strong>${description ? `<p class="rich-prose">${renderInline(description)}</p>` : ""}${metadata}</div><div class="api-operations">${operations}</div></div>`
}

interface HttpMessage {
  readonly kind: "request" | "response"
  readonly method?: string
  readonly target?: string
  readonly status?: string
  readonly reason?: string
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: string
}

const requestLinePattern = /^([A-Z]+)\s+(\S+?)(?:\s+HTTP\/\d(?:\.\d)?)?$/
const responseLinePattern = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/

const parseHttpBlock = (source: string): ReadonlyArray<HttpMessage> | undefined => {
  const lines = source.replaceAll("\r\n", "\n").split("\n")
  const starts = lines.flatMap((line, index) => requestLinePattern.test(line) || responseLinePattern.test(line) ? [index] : [])
  if (starts[0] !== 0) return undefined
  const messages = starts.map((start, index): HttpMessage | undefined => {
    const end = starts[index + 1] ?? lines.length
    const first = lines[start]
    const request = requestLinePattern.exec(first)
    const response = responseLinePattern.exec(first)
    if (!request && !response) return undefined
    const headers: Array<readonly [string, string]> = []
    let cursor = start + 1
    for (; cursor < end && lines[cursor].trim() !== ""; cursor += 1) {
      const separator = lines[cursor].indexOf(":")
      if (separator <= 0) break
      headers.push([lines[cursor].slice(0, separator).trim(), lines[cursor].slice(separator + 1).trim()])
    }
    if (lines[cursor]?.trim() === "") cursor += 1
    const body = lines.slice(cursor, end).join("\n").trim()
    return request
      ? { kind: "request", method: request[1], target: request[2], headers, body }
      : { kind: "response", status: response![1], reason: response![2], headers, body }
  })
  return messages.every((message): message is HttpMessage => message !== undefined) ? messages : undefined
}

const prettyHttpBody = (body: string): { readonly text: string; readonly json: boolean } => {
  if (body === "") return { text: "", json: false }
  try {
    return { text: JSON.stringify(JSON.parse(body), null, 2), json: true }
  } catch {
    return { text: body, json: false }
  }
}

const renderHttpBody = (message: HttpMessage): string => {
  if (message.body === "") return ""
  const formatted = prettyHttpBody(message.body)
  const contentTypeIsJson = message.headers.some(([name, value]) => name.toLowerCase() === "content-type" && /(?:application|text)\/(?:[\w.+-]*\+)?json/i.test(value))
  const json = formatted.json || contentTypeIsJson
  const highlighted = json ? highlightLines(formatted.text, "json") : null
  const content = highlighted?.join("\n") ?? escapeHtml(formatted.text)
  return `<pre class="http-body${json ? " http-body-json" : ""}"><code>${content}</code></pre>`
}

const renderHttpBlock = (source: string): string | undefined => {
  const messages = parseHttpBlock(source)
  if (!messages || messages.length === 0) return undefined
  const rendered = messages.map((message) => {
    const label = message.kind === "request" ? "Request" : "Response"
    const start = message.kind === "request"
      ? `<span class="api-method api-method-${message.method!.toLowerCase()}">${escapeHtml(message.method!)}</span><code>${escapeHtml(message.target!)}</code>`
      : `<code class="http-status${message.status?.startsWith("2") ? " api-status-ok" : message.status?.match(/^[45]/) ? " api-status-error" : ""}">${escapeHtml(message.status!)}</code><span>${escapeHtml(message.reason ?? "Response")}</span>`
    const headers = message.headers.length === 0 ? "" : `<dl class="http-headers">${message.headers.map(([name, value]) => `<div><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`
    return `<section class="http-message http-${message.kind}"><div class="http-start"><span class="http-label">${label}</span>${start}</div>${headers}${renderHttpBody(message)}</section>`
  }).join("")
  return `<div class="rich-block http-block" role="region" aria-label="HTTP exchange">${rendered}</div>`
}

interface AnsiState {
  bold: boolean
  dim: boolean
  foreground?: string
}

const ansiColors = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const

const ansi256Color = (value: number): string | undefined => {
  if (!Number.isInteger(value) || value < 0 || value > 255) return undefined
  if (value < 16) {
    const palette = ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0", "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"]
    return palette[value]
  }
  if (value >= 232) {
    const channel = 8 + (value - 232) * 10
    return `rgb(${channel},${channel},${channel})`
  }
  const offset = value - 16
  const levels = [0, 95, 135, 175, 215, 255]
  return `rgb(${levels[Math.floor(offset / 36)]},${levels[Math.floor(offset % 36 / 6)]},${levels[offset % 6]})`
}

const renderAnsiSegment = (value: string, state: AnsiState): string => {
  if (value === "") return ""
  const classes = [state.bold ? "ansi-bold" : "", state.dim ? "ansi-dim" : "", state.foreground?.startsWith("ansi-") ? state.foreground : ""].filter(Boolean)
  const style = state.foreground && !state.foreground.startsWith("ansi-") ? ` style="color:${state.foreground}"` : ""
  const content = escapeHtml(value)
  return classes.length === 0 && style === "" ? content : `<span${classes.length > 0 ? ` class="${classes.join(" ")}"` : ""}${style}>${content}</span>`
}

const renderAnsi = (source: string): string => {
  const cleaned = source.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
  const pattern = /\x1b\[([0-9;]*)m/g
  const state: AnsiState = { bold: false, dim: false }
  let rendered = ""
  let cursor = 0
  let match = pattern.exec(cleaned)
  while (match) {
    rendered += renderAnsiSegment(cleaned.slice(cursor, match.index), state)
    const codes = (match[1] === "" ? [0] : match[1].split(";").map(Number))
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index]
      if (code === 0) Object.assign(state, { bold: false, dim: false, foreground: undefined })
      else if (code === 1) state.bold = true
      else if (code === 2) state.dim = true
      else if (code === 22) Object.assign(state, { bold: false, dim: false })
      else if (code >= 30 && code <= 37) state.foreground = `ansi-${ansiColors[code - 30]}`
      else if (code >= 90 && code <= 97) state.foreground = `ansi-bright-${ansiColors[code - 90]}`
      else if (code === 39) state.foreground = undefined
      else if (code === 38 && codes[index + 1] === 5) {
        state.foreground = ansi256Color(codes[index + 2])
        index += 2
      } else if (code === 38 && codes[index + 1] === 2 && codes.slice(index + 2, index + 5).every((channel) => channel >= 0 && channel <= 255)) {
        state.foreground = `rgb(${codes[index + 2]},${codes[index + 3]},${codes[index + 4]})`
        index += 4
      }
    }
    cursor = pattern.lastIndex
    match = pattern.exec(cleaned)
  }
  return rendered + renderAnsiSegment(cleaned.slice(cursor), state)
}

const renderTerminalBlock = (source: string): string =>
  `<div class="rich-block terminal-block" role="region" aria-label="Terminal output"><div class="terminal-heading"><strong>Terminal</strong></div><pre class="terminal-body"><code>${renderAnsi(source.replace(/\n$/, ""))}</code></pre></div>`

const renderShellBlock = (source: string): string => {
  const lines = source.replace(/\n$/, "").split("\n").map((line) => {
    if (line.startsWith("$ ")) {
      return `<span class="shell-line shell-command"><span class="shell-prompt" aria-hidden="true">$</span><span>${escapeHtml(line.slice(2))}</span></span>`
    }
    return `<span class="shell-line shell-output">${escapeHtml(line) || "&#8203;"}</span>`
  }).join("")
  return `<div class="rich-block terminal-block shell-block" role="region" aria-label="Shell command"><div class="terminal-heading"><strong>Shell</strong></div><pre class="terminal-body"><code>${lines}</code></pre></div>`
}

interface TimelineEntry {
  readonly title: string
  readonly time?: string
  readonly detail?: string
  readonly status: "complete" | "current" | "pending" | "error"
}

const timelineStatus = (value: unknown): TimelineEntry["status"] => {
  const status = typeof value === "string" ? value.toLowerCase() : "pending"
  if (["complete", "completed", "done", "success"].includes(status)) return "complete"
  if (["current", "active", "running", "progress"].includes(status)) return "current"
  if (["error", "failed", "blocked"].includes(status)) return "error"
  return "pending"
}

const parseTimeline = (source: string): { readonly title?: string; readonly entries: ReadonlyArray<TimelineEntry> } | undefined => {
  const parsed = parseStructured(source)
  const root = isDictionary(parsed) ? parsed : undefined
  const values = Array.isArray(parsed) ? parsed : Array.isArray(root?.items) ? root.items : Array.isArray(root?.events) ? root.events : undefined
  if (!values) return undefined
  const entries = values.flatMap((value): ReadonlyArray<TimelineEntry> => {
    if (!isDictionary(value)) return []
    const title = stringValue(value.title) ?? stringValue(value.label)
    if (!title) return []
    return [{
      title,
      time: stringValue(value.time) ?? stringValue(value.date) ?? stringValue(value.at),
      detail: stringValue(value.detail) ?? stringValue(value.description),
      status: timelineStatus(value.status),
    }]
  })
  return entries.length === values.length && entries.length > 0 ? { title: stringValue(root?.title), entries } : undefined
}

const renderTimelineBlock = (source: string, renderInline: RenderInlineMarkdown): string | undefined => {
  const timeline = parseTimeline(source)
  if (!timeline) return undefined
  const entries = timeline.entries.map((entry) => `<li class="timeline-entry timeline-${entry.status}"><div class="timeline-marker" aria-hidden="true"></div><div class="timeline-content"><div class="timeline-heading"><strong>${escapeHtml(entry.title)}</strong>${entry.time ? `<time>${escapeHtml(entry.time)}</time>` : ""}</div>${entry.detail ? `<p class="rich-prose">${renderInline(entry.detail)}</p>` : ""}</div></li>`).join("")
  return `<div class="rich-block timeline-block" role="region" aria-label="${escapeHtml(timeline.title ?? "Timeline")}"><div class="rich-block-heading"><span class="rich-block-kicker">Timeline</span>${timeline.title ? `<strong>${escapeHtml(timeline.title)}</strong>` : ""}</div><ol class="timeline-list">${entries}</ol></div>`
}

interface DefinitionEntry {
  readonly term: string
  readonly definition: string
  readonly aliases: ReadonlyArray<string>
}

const parseDefinitions = (source: string): ReadonlyArray<DefinitionEntry> | undefined => {
  const parsed = parseStructured(source)
  const entries = Array.isArray(parsed)
    ? parsed.flatMap((value): ReadonlyArray<DefinitionEntry> => {
        if (!isDictionary(value)) return []
        const term = stringValue(value.term)
        const definition = stringValue(value.definition) ?? stringValue(value.description)
        if (!term || !definition) return []
        const aliases = Array.isArray(value.aliases) ? value.aliases.filter((alias): alias is string => typeof alias === "string") : []
        return [{ term, definition, aliases }]
      })
    : isDictionary(parsed)
      ? Object.entries(parsed).flatMap(([term, value]): ReadonlyArray<DefinitionEntry> => {
          if (typeof value === "string") return [{ term, definition: value, aliases: [] }]
          if (!isDictionary(value)) return []
          const definition = stringValue(value.definition) ?? stringValue(value.description)
          if (!definition) return []
          const aliases = Array.isArray(value.aliases) ? value.aliases.filter((alias): alias is string => typeof alias === "string") : []
          return [{ term, definition, aliases }]
        })
      : []
  return entries.length > 0 ? entries : undefined
}

const renderDefinitionsBlock = (source: string, renderInline: RenderInlineMarkdown): string | undefined => {
  const entries = parseDefinitions(source)
  if (!entries) return undefined
  const definitions = entries.map((entry) => `<div class="definition-entry"><dt>${escapeHtml(entry.term)}${entry.aliases.length > 0 ? `<span>${escapeHtml(entry.aliases.join(" · "))}</span>` : ""}</dt><dd class="rich-prose">${renderInline(entry.definition)}</dd></div>`).join("")
  return `<div class="rich-block definitions-block" role="region" aria-label="Definitions"><div class="rich-block-heading"><span class="rich-block-kicker">Definitions</span></div><dl>${definitions}</dl></div>`
}

interface QuizOption {
  readonly label: string
  readonly correct: boolean
}

interface QuizQuestion {
  readonly question: string
  readonly options: ReadonlyArray<QuizOption>
  readonly why?: string
}

const parseQuizOption = (value: unknown): QuizOption | undefined => {
  if (typeof value === "string") return stringValue(value) ? { label: value.trim(), correct: false } : undefined
  if (!isDictionary(value)) return undefined
  const label = stringValue(value.label) ?? stringValue(value.text)
  if (!label) return undefined
  return { label, correct: value.correct === true }
}

const parseQuizQuestion = (value: unknown): QuizQuestion | undefined => {
  if (!isDictionary(value)) return undefined
  const question = stringValue(value.question) ?? stringValue(value.prompt)
  if (!question) return undefined
  const rawOptions = Array.isArray(value.options) ? value.options : Array.isArray(value.answers) ? value.answers : undefined
  if (!rawOptions) return undefined
  const options = rawOptions.map(parseQuizOption)
  if (options.length < 2 || !options.every((option): option is QuizOption => option !== undefined)) return undefined
  if (!options.some((option) => option.correct)) return undefined
  return { question, options, why: stringValue(value.why) ?? stringValue(value.explanation) }
}

const parseQuiz = (source: string): { readonly title?: string; readonly questions: ReadonlyArray<QuizQuestion> } | undefined => {
  const parsed = parseStructured(source)
  const root = isDictionary(parsed) ? parsed : undefined
  const values = Array.isArray(parsed) ? parsed : Array.isArray(root?.questions) ? root.questions : undefined
  if (!values || values.length === 0) return undefined
  const questions = values.map(parseQuizQuestion)
  if (!questions.every((question): question is QuizQuestion => question !== undefined)) return undefined
  return { title: stringValue(root?.title), questions }
}

const quizOptionKey = (index: number): string => String.fromCharCode(65 + (index % 26))

const renderQuizBlock = (source: string, renderInline: RenderInlineMarkdown): string | undefined => {
  const quiz = parseQuiz(source)
  if (!quiz) return undefined
  const questions = quiz.questions.map((question, questionIndex) => {
    const options = question.options.map((option, optionIndex) =>
      `<button type="button" class="quiz-option" data-quiz-option data-quiz-correct="${option.correct ? "1" : "0"}"><span class="quiz-option-key" aria-hidden="true">${quizOptionKey(optionIndex)}</span><span class="quiz-option-label rich-prose">${renderInline(option.label)}</span></button>`,
    ).join("")
    const why = question.why ? `<p class="quiz-why rich-prose" hidden>${renderInline(question.why)}</p>` : ""
    return `<li class="quiz-question" data-quiz-question><p class="quiz-prompt rich-prose"><span class="quiz-question-number" aria-hidden="true">${questionIndex + 1}</span>${renderInline(question.question)}</p><div class="quiz-options" role="group">${options}</div>${why}</li>`
  }).join("")
  const scoreLabel = `0 of ${quiz.questions.length} answered`
  return `<div class="rich-block quiz-block" role="region" aria-label="${escapeHtml(quiz.title ?? "Quiz")}" data-quiz><div class="rich-block-heading"><span class="rich-block-kicker">Quiz</span>${quiz.title ? `<strong>${escapeHtml(quiz.title)}</strong>` : ""}</div><ol class="quiz-questions">${questions}</ol><div class="quiz-score" data-quiz-score aria-live="polite">${scoreLabel}</div></div>`
}

interface GalleryItem {
  readonly src: string
  readonly alt: string
  readonly caption?: string
  readonly detail?: string
  readonly findings: ReadonlyArray<string>
}

const parseGallery = (source: string): { readonly title?: string; readonly columns: number; readonly items: ReadonlyArray<GalleryItem> } | undefined => {
  const parsed = parseStructured(source)
  const root = isDictionary(parsed) ? parsed : undefined
  const values = Array.isArray(parsed) ? parsed : Array.isArray(root?.items) ? root.items : undefined
  if (!values || values.length === 0) return undefined
  const items = values.flatMap((value): ReadonlyArray<GalleryItem> => {
    if (!isDictionary(value)) return []
    const src = stringValue(value.src) ?? stringValue(value.url)
    const safeSrc = src ? safeResourceUrl(src, { allowAnchor: false }) : undefined
    const alt = stringValue(value.alt)
    if (!safeSrc || !alt) return []
    return [{
      src: safeSrc,
      alt,
      caption: stringValue(value.caption) ?? stringValue(value.title),
      detail: stringValue(value.detail) ?? stringValue(value.description),
      findings: Array.isArray(value.findings) ? value.findings.flatMap((finding) => stringValue(finding) ?? []) : [],
    }]
  })
  if (items.length !== values.length) return undefined
  const requested = typeof root?.columns === "number" ? root.columns : 2
  const columns = Number.isInteger(requested) ? Math.min(4, Math.max(1, requested)) : 2
  return { title: stringValue(root?.title), columns, items }
}

const renderGalleryBlock = (source: string, renderInline: RenderInlineMarkdown): string | undefined => {
  const gallery = parseGallery(source)
  if (!gallery) return undefined
  const items = gallery.items.map((item) => {
    const caption = item.caption ? `<strong class="gallery-caption-title">${escapeHtml(item.caption)}</strong>` : ""
    const detail = item.detail ? `<span class="gallery-caption-detail rich-prose">${renderInline(item.detail)}</span>` : ""
    const findings = item.findings.length
      ? `<ul class="gallery-findings">${item.findings.map((finding) => `<li class="rich-prose">${renderInline(finding)}</li>`).join("")}</ul>`
      : ""
    const figcaption = caption || detail || findings ? `<figcaption class="gallery-caption">${caption}${detail}${findings}</figcaption>` : ""
    const label = item.caption ?? item.alt
    return `<figure class="gallery-item"><button type="button" class="gallery-image-button" data-gallery-item data-gallery-src="${escapeHtml(item.src)}" data-gallery-alt="${escapeHtml(item.alt)}" data-gallery-caption="${escapeHtml(item.caption ?? "")}" aria-label="Open ${escapeHtml(label)}"><img src="${escapeHtml(item.src)}" alt="" loading="lazy"></button>${figcaption}</figure>`
  }).join("")
  const heading = gallery.title
    ? `<div class="rich-block-heading"><span class="rich-block-kicker">Gallery</span><strong>${escapeHtml(gallery.title)}</strong></div>`
    : ""
  return `<div class="rich-block gallery-block" role="region" aria-label="${escapeHtml(gallery.title ?? "Gallery")}" data-gallery>${heading}<div class="gallery-grid gallery-columns-${gallery.columns}">${items}</div></div>`
}

export const renderRichBlock = (language: string, source: string, renderInline: RenderInlineMarkdown): string | undefined => {
  switch (language) {
    case "openapi": return renderOpenApiBlock(source, renderInline)
    case "http": return renderHttpBlock(source)
    case "terminal": return renderTerminalBlock(source)
    case "shell": return renderShellBlock(source)
    case "schema": return renderSchemaBlock(source, renderInline)
    case "timeline": return renderTimelineBlock(source, renderInline)
    case "definitions": return renderDefinitionsBlock(source, renderInline)
    case "quiz": return renderQuizBlock(source, renderInline)
    case "gallery": return renderGalleryBlock(source, renderInline)
    default: return undefined
  }
}

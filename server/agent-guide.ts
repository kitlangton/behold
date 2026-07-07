export const agentGuide = (origin: string) => `# Behold agent guide

Behold is a local-first Markdown review surface at ${origin}. Use its MCP tools to host a document, then ask the user to review it in the browser.

- Use \`host_document\` with inline Markdown for an ephemeral review artifact.
- Use \`host_document\` with an absolute \`filePath\` when the Markdown file is a durable project artifact. Reposting that path updates the same document.
- Write for visual scanning: use descriptive headings, short paragraphs, lists or tables where they clarify structure, **bold** for key terms, and *italics* sparingly for nuance.
- Prefer the richest semantic representation that makes the material easier to scan. Use diagrams for relationships, API blocks for contracts, trees for structure, diffs for changes, schemas for data shapes, timelines for chronology, and ordinary Markdown when a bespoke renderer adds no information.
- Always label ordinary code fences with the exact language, such as \`typescript\`, \`tsx\`, \`bash\`, or \`python\`, so Shiki can apply syntax highlighting. Add optional fence metadata for a framed excerpt: \`typescript title="src/app.ts" start=42 highlight=44-46 caption="Validation path"\`.
- Use \`mermaid\` for diagrams, \`tree\` for directory layouts, \`diff\` for patches, \`json\` for collapsible values, \`shell\` for prompt-styled commands, \`terminal\` for ANSI output, and \`http\` for request/response messages.
- Use YAML or JSON inside \`openapi\` for a compact OpenAPI 3 reference, \`schema\` for a JSON Schema property view, \`timeline\` for an array of \`{ title, time?, detail?, status? }\` entries, and \`definitions\` for a term-to-definition map or an array of \`{ term, definition, aliases? }\` entries.
- Use \`quiz\` for interactive comprehension checks when teaching or verifying understanding: \`{ title?, questions: [{ question, options: [{ label, correct? }], why? }] }\` in YAML or JSON. Each question needs at least two options and one \`correct: true\`; \`why\` is revealed after answering.
- Rich fences stay portable: when structured input is invalid, Behold displays it as ordinary code instead of discarding it.
- After presenting work that needs a decision, call \`wait_for_feedback\`. It blocks until the user comments or the timeout expires.
- Use \`update_document\` only for inline documents. For file-backed documents, edit the file and repost its path.
- Use \`list_document_versions\` and \`diff_document_versions\` when review feedback refers to an earlier revision.
- Local hosting is private. Public publishing remains a separate explicit action in the browser.
`

export const agentSkill = (origin: string) => `---
name: behold
description: Host Markdown documents for visual review and wait for browser comments. Use when the user asks to show, present, diagram, review, or annotate a document.
---

${agentGuide(origin)}
`

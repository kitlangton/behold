# Behold

Behold is a local-first Markdown viewer for presenting agent work, collecting browser comments, and optionally publishing frozen public snapshots.

## Architecture

- `src/App.tsx`: Solid viewer and annotation UI
- `src/lib/document-viewer.ts`: browser Effect v4 HTTP client
- `shared/document-contracts.ts`: shared local API response schemas
- `server/document-reviews.ts`: revisions, comments, feedback cursors, and JSON persistence
- `server/document-api.ts`: local HTTP and SSE adapter
- `server/local-viewer.ts`: packaged asset and API server
- `server/mcp-main.ts`: Effect v4 stdio MCP client for the local HTTP API
- `cloudflare/worker.ts`: public Cloudflare Worker serving the built viewer, publish/list/get snapshot API, and published page shells from R2

Vite mounts the local API during development. The packaged daemon serves built assets directly. Both use the same `DocumentReviews` service, and the MCP process never accesses persistence directly.

## Invariants

- Local authoring and public publishing are separate systems.
- The local viewer process is the sole owner of in-memory state, persistence, SSE clients, and long-poll waiters.
- Package root locates executable assets; invocation cwd supplies project `.env` and `.env.local` configuration.
- Runtime reuse requires matching package, assets, and configuration roots.
- Public snapshots and manifests must never expose local filesystem paths.
- Reposting a `filePath` updates the same hosted document id.
- Deleting a local document never deletes an independently published snapshot.
- Hosted documents retain a local publication receipt; startup reconciliation updates its remote status without treating network failure as deletion.
- Document updates retain the current revision plus 20 previous revisions.
- `wait_for_feedback` currently reads and acknowledges feedback in one MCP call.

## Agent Surface

MCP tools:

- `host_document`
- `update_document`
- `get_document`
- `list_documents`
- `list_document_versions`
- `diff_document_versions`
- `wait_for_feedback`
- `set_comment_status`
- `delete_document`
- `get_agent_guide`

Agent guidance is also served from `GET /agent-howto` and `GET /skill`.

## Markdown

Documents remain portable Markdown. Use exact language labels on ordinary code fences. Framed excerpts may add `title`, `start`, `highlight`, and `caption` metadata after the language. Rich fences are:

- `mermaid`: client-rendered diagram
- `tree`: file tree
- `diff`: unified patch
- `json`: collapsible JSON tree
- `openapi`: OpenAPI 3 YAML or JSON reference
- `http`: HTTP wire-format request and response
- `shell`: prompt-styled commands; `$ ` is visual and omitted when copied
- `terminal`: ANSI-aware terminal output
- `schema`: JSON Schema YAML or JSON property view
- `timeline`: YAML or JSON event list
- `definitions`: YAML or JSON glossary

Prefer semantic rich blocks when they improve scanning, but use ordinary Markdown instead of adding visual decoration without information. Prefer ASCII diagrams in project-authored architecture notes unless Mermaid is explicitly requested.

## Environment

Local publishing uses:

- `BEHOLD_PUBLISH_ORIGIN`
- `BEHOLD_PUBLISH_TOKEN`

Optional local overrides:

- `BEHOLD_DATA_DIR`
- `BEHOLD_ORIGIN`
- `BEHOLD_ALLOWED_FILE_ROOTS`

The public deployment uses a `BEHOLD_PUBLISH_TOKEN` Worker secret and an R2 bucket binding. Never commit real secrets.

## Deployment

- `wrangler.jsonc` defines the Worker, static assets, R2 binding, and required secret.
- Keep account-specific domains, resource identifiers, and credentials out of tracked files.
- `bun run deploy` deploys with the current Wrangler credentials.
- `.github/workflows/ci.yml` validates pushes and pull requests. Cloudflare's Git integration owns automatic deployment for repositories created by the deploy flow.
- npm releases are separate from Cloudflare deploys and use Changesets.

## Security

- Never commit `.env.local`, `.dev.vars`, credentials, local document data, or generated runtime state.
- Behold strips snapshot metadata that identifies local documents. Authored Markdown is published verbatim and must be reviewed before publishing.
- The publish token authorizes both publishing and unpublishing; it is never exposed to the browser or public Worker responses.
- Keep local file access loopback-only unless paths are explicitly allowed through `BEHOLD_ALLOWED_FILE_ROOTS`.

## Commands

- `bun dev`
- `bun run mcp`
- `bun run behold start`
- `bun run behold status`
- `bun run behold stop`
- `bun run behold setup`
- `bun run behold doctor`
- `bun run test`
- `bun run typecheck`
- `bun run build`
- `bun run deploy`
- `bun run release:check`

## Change Guidance

- Keep HTTP handlers thin and boundary payloads schema-decoded.
- Keep shared wire contracts in `shared/document-contracts.ts` or `src/lib/published.ts`.
- Keep public Cloudflare Worker code independent of local filesystem access.
- Preserve the established viewer visual language.

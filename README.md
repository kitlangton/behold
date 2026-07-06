# Behold

Behold is a local-first Markdown workspace for presenting agent work and collecting browser feedback. Its MCP server hosts documents in a persistent local viewer at `http://behold.localhost:5173`.

Local review works without a Behold account or cloud deployment. Optional public snapshots are deployed to a Cloudflare account you own.

## Install

[Bun](https://bun.sh/) 1.3 or newer is required.

```sh
bunx @kitlangton/behold setup
```

Setup detects supported coding agents, installs Behold globally through [`add-mcp`](https://github.com/neon-solutions/add-mcp), starts the local viewer, and opens it in your browser. Restart a running agent after setup so it loads the new MCP server.

Select a specific agent when automatic detection is not desired:

```sh
bunx @kitlangton/behold setup --agent opencode --no-open
```

## Use

Ask your agent naturally:

> Put this architecture proposal in Behold.

The agent can host inline Markdown or an absolute Markdown file, update revisions, and wait for browser comments.

Behold upgrades semantic fences into native review components: `mermaid`, `tree`, `diff`, `json`, `openapi`, `http`, `terminal`, `schema`, `timeline`, and `definitions`. Ordinary language fences can include metadata such as `typescript title="src/app.ts" start=42 highlight=44-46`.

## Self-host publishing

The Deploy button creates the public viewer and storage in your Cloudflare account. Connecting your local Behold runtime requires the resulting Worker URL and one private token.

1. Generate a private publish token and keep it available for the next steps:

   ```sh
   openssl rand -hex 32
   ```

2. Click **Deploy to Cloudflare**. Cloudflare copies Behold into your Git account, builds the public viewer, provisions an R2 bucket, and asks for `BEHOLD_PUBLISH_TOKEN`. Enter the token from step 1.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kitlangton/behold)

3. Copy the resulting Worker URL. In each project where your coding agent runs Behold, add the URL and the same token to `.env.local`:

   ```sh
   BEHOLD_PUBLISH_ORIGIN=https://behold-publish.<account>.workers.dev
   BEHOLD_PUBLISH_TOKEN=<the token entered during deployment>
   ```

   Do not commit this file or share the token.

4. Restart Behold so it loads the new configuration:

   ```sh
   bunx @kitlangton/behold stop
   bunx @kitlangton/behold start
   ```

5. Open `http://behold.localhost:5173`, host a document, and select **Publish**. The published URL should use your Cloudflare Worker origin.

Behold removes local source-path metadata from published snapshots. Authored Markdown is published as written, so review it for private paths or other sensitive text before publishing. Cloudflare serves snapshots from your Worker and user-owned R2 bucket.

See [`docs/behold-architecture.md`](docs/behold-architecture.md) for the local and public system boundaries.

## Commands

```sh
bunx @kitlangton/behold doctor
bunx @kitlangton/behold start
bunx @kitlangton/behold status
bunx @kitlangton/behold stop
```

`doctor` reports the local runtime state and detected agent registrations without starting Behold. Setup installs the MCP command; it does not install a global shell command.

## Data

Behold stores local documents and runtime metadata in the operating system's user data directory:

- macOS: `~/Library/Application Support/Behold`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/behold`
- Windows: `%LOCALAPPDATA%\Behold`

Set `BEHOLD_DATA_DIR` to override the location. Local documents remain private unless you explicitly publish a frozen snapshot from the browser.

## Development

```sh
bun install
bun dev
bun run test
bun run typecheck
bun run build
```

## License

MIT

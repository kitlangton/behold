import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { extname, resolve, sep } from "node:path"
import { createDocumentApi } from "./document-api"
import { parseAllowedFileRoots } from "./local-file-access"
import { createPublishProxy } from "./publish-proxy"

const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
}

const serveFile = async (request: IncomingMessage, response: ServerResponse, filePath: string, cacheControl: string) => {
  const file = await stat(filePath)
  if (!file.isFile()) return false
  response.statusCode = 200
  response.setHeader("Content-Type", contentTypes[extname(filePath)] ?? "application/octet-stream")
  response.setHeader("Content-Length", file.size)
  response.setHeader("Cache-Control", cacheControl)
  if (request.method === "HEAD") {
    response.end()
    return true
  }
  createReadStream(filePath).pipe(response)
  return true
}

export const startLocalViewer = async (options: {
  readonly root: string
  readonly host: string
  readonly port: number
  readonly dataDirectory: string
  readonly assetDirectory?: string
  readonly runtimeId: string
  readonly environment: Readonly<Record<string, string | undefined>>
}) => {
  const assets = options.assetDirectory ?? resolve(options.root, "dist")
  const indexFile = resolve(assets, "index.html")
  await stat(indexFile)

  const documentApi = createDocumentApi({
    dataDirectory: options.dataDirectory,
    storeFilePath: resolve(options.dataDirectory, "store.json"),
    runtimeId: options.runtimeId,
    allowedFileRoots: () => parseAllowedFileRoots(options.environment.BEHOLD_ALLOWED_FILE_ROOTS ?? options.environment.SHOW_ALLOWED_FILE_ROOTS ?? ""),
  })
  const publishProxy = createPublishProxy(options.environment)

  const server = createServer((request, response) => {
    publishProxy(request, response, () => {
      documentApi.middleware(request, response, () => {
        void (async () => {
          if (request.method !== "GET" && request.method !== "HEAD") {
            response.statusCode = 405
            response.end("Method not allowed")
            return
          }

          let pathname: string
          try {
            pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname)
          } catch {
            response.statusCode = 400
            response.end("Invalid URL")
            return
          }

          const requestedFile = resolve(assets, `.${pathname}`)
          const insideAssets = requestedFile === assets || requestedFile.startsWith(`${assets}${sep}`)
          if (insideAssets && pathname !== "/") {
            const served = await serveFile(request, response, requestedFile, pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache").catch(() => false)
            if (served) return
            if (extname(pathname) !== "") {
              response.statusCode = 404
              response.end("Not found")
              return
            }
          }
          await serveFile(request, response, indexFile, "no-cache")
        })().catch((error) => {
          response.statusCode = 500
          response.end(error instanceof Error ? error.message : "Internal server error")
        })
      })
    })
  })

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject)
    server.listen(options.port, options.host, () => resolvePromise())
  })

  return {
    close: async () => {
      await documentApi.dispose()
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()))
    },
  }
}

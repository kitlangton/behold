import type { IncomingMessage, ServerResponse } from "node:http"

export type NextHandleFunction = (request: IncomingMessage, response: ServerResponse, next: () => void) => void

const maxRequestBodyBytes = 10 * 1024 * 1024

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the 10 MiB limit.")
    this.name = "RequestBodyTooLargeError"
  }
}

export const readRequestBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const contentLength = request.headers["content-length"]
    if (typeof contentLength === "string") {
      const parsedLength = Number(contentLength)
      if (Number.isFinite(parsedLength) && parsedLength > maxRequestBodyBytes) {
        request.on("error", () => undefined)
        request.resume()
        reject(new RequestBodyTooLargeError())
        return
      }
    }

    const chunks: Array<Buffer> = []
    let receivedBytes = 0
    let overflowed = false

    request.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      receivedBytes += buffer.byteLength
      if (overflowed) return
      if (receivedBytes > maxRequestBodyBytes) {
        overflowed = true
        chunks.length = 0
        return
      }
      chunks.push(buffer)
    })
    request.on("end", () => {
      if (overflowed) reject(new RequestBodyTooLargeError())
      else resolve(Buffer.concat(chunks).toString("utf8"))
    })
    request.on("error", reject)
  })

export const sendJson = (response: ServerResponse, statusCode: number, payload: unknown) => {
  response.statusCode = statusCode
  response.setHeader("Content-Type", "application/json; charset=utf-8")
  response.end(JSON.stringify(payload))
}

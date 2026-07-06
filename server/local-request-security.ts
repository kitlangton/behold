import type { NextHandleFunction } from "./http-helpers"

const allowedHostnames = new Set(["behold.localhost", "localhost", "127.0.0.1", "::1", "[::1]"])

const hostname = (host: string | undefined): string | undefined => {
  if (!host) return undefined
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return undefined
  }
}

export const isTrustedLocalRequest = (input: {
  readonly method?: string
  readonly host?: string
  readonly origin?: string
  readonly secFetchSite?: string
  readonly beholdRequest?: string
}): boolean => {
  const requestHostname = hostname(input.host)
  if (!requestHostname || !allowedHostnames.has(requestHostname)) return false
  const method = input.method ?? "GET"
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true
  if (input.beholdRequest !== "1") return false
  if (input.secFetchSite === "cross-site") return false
  if (!input.origin) return true
  try {
    return new URL(input.origin).host === input.host
  } catch {
    return false
  }
}

export const localRequestSecurity: NextHandleFunction = (request, response, next) => {
  const trusted = isTrustedLocalRequest({
    method: request.method,
    host: request.headers.host,
    origin: request.headers.origin,
    secFetchSite: typeof request.headers["sec-fetch-site"] === "string" ? request.headers["sec-fetch-site"] : undefined,
    beholdRequest: typeof request.headers["x-behold-request"] === "string" ? request.headers["x-behold-request"] : undefined,
  })
  if (trusted) {
    next()
    return
  }
  response.statusCode = 403
  response.setHeader("Content-Type", "application/json; charset=utf-8")
  response.setHeader("X-Content-Type-Options", "nosniff")
  response.end(JSON.stringify({ error: "Request rejected by the local Behold boundary." }))
}

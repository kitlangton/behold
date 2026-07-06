import { readRequestBody, RequestBodyTooLargeError, sendJson, type NextHandleFunction } from "./http-helpers"

export const createPublishProxy = (environment: Readonly<Record<string, string | undefined>>): NextHandleFunction => {
  const publishOrigin = environment.BEHOLD_PUBLISH_ORIGIN ?? environment.SHOW_PUBLISH_ORIGIN
  const publishToken = environment.BEHOLD_PUBLISH_TOKEN ?? environment.SHOW_PUBLISH_TOKEN

  return async (request, response, next) => {
    const url = request.url ? new URL(request.url, "http://localhost") : undefined
    if (request.method !== "POST" || url?.pathname !== "/api/publish-remote") {
      next()
      return
    }

    if (!publishOrigin || !publishToken) {
      sendJson(response, 400, {
        error: "Missing publish configuration.",
        message: "Set BEHOLD_PUBLISH_ORIGIN and BEHOLD_PUBLISH_TOKEN in your local environment to enable remote publish.",
      })
      return
    }

    try {
      const remote = await fetch(`${publishOrigin.replace(/\/$/, "")}/api/published-documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${publishToken}` },
        body: await readRequestBody(request),
      })
      sendJson(response, remote.status, await remote.json().catch(() => ({ error: `Remote publish failed with ${remote.status}.` })))
    } catch (error) {
      const status = error instanceof RequestBodyTooLargeError ? 413 : error instanceof TypeError ? 502 : 400
      sendJson(response, status, { error: error instanceof Error ? error.message : "Unable to publish document." })
    }
  }
}

import { describe, expect, it } from "vitest"
import { Cache, Deferred, Effect, Fiber, Ref } from "effect"
import { makeDocumentViewerTextCache, shouldCacheTextForDocumentViewer } from "../src/lib/document-viewer"

describe("remote text cache semantics", () => {
  it("allows remote text fetches to use the bounded Effect cache", () => {
    expect(shouldCacheTextForDocumentViewer("https://raw.githubusercontent.com/owner/repo/main/file.ts")).toBe(true)
  })

  it("deduplicates concurrent same-key lookups through Effect Cache", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const lookupCount = yield* Ref.make(0)
        const lookupStarted = yield* Deferred.make<void>()
        const releaseLookup = yield* Deferred.make<string>()
        const cache = yield* makeDocumentViewerTextCache(
          () =>
            Effect.gen(function* () {
              yield* Ref.update(lookupCount, (count) => count + 1)
              yield* Deferred.succeed(lookupStarted, undefined)
              return yield* Deferred.await(releaseLookup)
            }),
          { capacity: 4, timeToLive: "5 minutes" },
        )

        const fiber = yield* Effect.all([Cache.get(cache, "same-key"), Cache.get(cache, "same-key")], {
          concurrency: "unbounded",
        }).pipe(Effect.forkChild)

        yield* Deferred.await(lookupStarted)
        expect(yield* Ref.get(lookupCount)).toBe(1)

        yield* Deferred.succeed(releaseLookup, "shared result")
        expect(yield* Fiber.join(fiber)).toEqual(["shared result", "shared result"])
        expect(yield* Ref.get(lookupCount)).toBe(1)
      }),
    )
  })
})

import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"

export interface SerializedAtomicJsonWriterOptions {
  readonly directory: string
  readonly filePath: string
  readonly makeTempFilePath?: () => string
  readonly mkdir?: typeof mkdir
  readonly writeFile?: typeof writeFile
  readonly rename?: typeof rename
  readonly rm?: typeof rm
}

export interface SerializedAtomicJsonWriter<T> {
  readonly write: (snapshot: T) => Promise<void>
}

export const createSerializedAtomicJsonWriter = <T>(
  options: SerializedAtomicJsonWriterOptions,
): SerializedAtomicJsonWriter<T> => {
  const mkdirImpl = options.mkdir ?? mkdir
  const writeFileImpl = options.writeFile ?? writeFile
  const renameImpl = options.rename ?? rename
  const rmImpl = options.rm ?? rm
  const makeTempFilePath =
    options.makeTempFilePath ??
    (() => resolve(options.directory, `store.${process.pid}.${Date.now()}.${randomUUID()}.tmp`))
  let queue: Promise<void> = Promise.resolve()

  return {
    write(snapshot) {
      queue = queue.catch(() => undefined).then(async () => {
        await mkdirImpl(options.directory, { recursive: true })
        const tempFilePath = makeTempFilePath()

        try {
          await writeFileImpl(tempFilePath, JSON.stringify(snapshot, null, 2), "utf8")
          await renameImpl(tempFilePath, options.filePath)
        } catch (error) {
          await rmImpl(tempFilePath, { force: true }).catch(() => undefined)
          throw error
        }
      })

      return queue
    },
  }
}

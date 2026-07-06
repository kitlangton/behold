import { realpath } from "node:fs/promises"
import { delimiter, isAbsolute, relative, resolve } from "node:path"

export const isLoopbackAddress = (remoteAddress: string | undefined): boolean => {
  if (!remoteAddress) return false
  if (remoteAddress === "::1") return true

  const ipv4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(remoteAddress)
  const ipv4 = ipv4Mapped?.[1] ?? remoteAddress
  return /^127(?:\.\d{1,3}){3}$/.test(ipv4)
}

export const parseAllowedFileRoots = (configured: string): ReadonlyArray<string> =>
  configured
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => resolve(entry))

export const isWithinRoot = (filePath: string, root: string): boolean => {
  const pathFromRoot = relative(root, filePath)
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
}

const realpathIfExists = async (
  filePath: string,
  realpathImpl: (path: string) => Promise<string> = realpath,
): Promise<string | undefined> => {
  try {
    return await realpathImpl(filePath)
  } catch {
    return undefined
  }
}

export interface CanReadLocalFileOptions {
  readonly remoteAddress: string | undefined
  readonly filePath: string
  readonly allowedRoots: ReadonlyArray<string>
  readonly realpath?: (path: string) => Promise<string>
}

// Non-loopback authorization is based on canonical real paths so symlinks inside
// allowed roots cannot escape them. Non-loopback clients fail closed when the
// target realpath cannot be resolved; loopback clients retain local authoring
// behavior and let the subsequent read report file-not-found.
export const resolveReadableLocalFilePath = async (options: CanReadLocalFileOptions): Promise<string | undefined> => {
  if (isLoopbackAddress(options.remoteAddress)) return options.filePath

  const targetPath = await realpathIfExists(options.filePath, options.realpath)
  if (!targetPath) return undefined

  const roots = await Promise.all(options.allowedRoots.map((root) => realpathIfExists(root, options.realpath)))
  return roots.some((root): root is string => root !== undefined && isWithinRoot(targetPath, root)) ? targetPath : undefined
}

export const canReadLocalFilePath = async (options: CanReadLocalFileOptions): Promise<boolean> =>
  (await resolveReadableLocalFilePath(options)) !== undefined

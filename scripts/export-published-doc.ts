import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveBeholdDataDirectory } from "../server/behold-home"
import { preparePublishedSnapshot, type PublishedDocumentManifest, type PublishedDocumentManifestEntry, type PublishedDocumentSnapshot } from "../src/lib/published"

interface StoredDocument {
  readonly id: string
  readonly title: string
  readonly markdown: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly sourcePath?: string
}

interface StoreFile {
  readonly documents?: ReadonlyArray<StoredDocument>
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const storePath = resolve(
  resolveBeholdDataDirectory({
    cwd: root,
    configuredDirectory: process.env.BEHOLD_DATA_DIR,
  }),
  "store.json",
)
const publishedDir = resolve(root, "public/published")
const publishedIndexPath = resolve(publishedDir, "index.json")

const parseArgs = () => {
  const args = process.argv.slice(2)
  const get = (name: string) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }

  return {
    id: get("--id"),
    filePath: get("--filePath"),
    slug: get("--slug"),
  }
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "published-doc"

const loadStore = async () => {
  try {
    return JSON.parse(await readFile(storePath, "utf8")) as StoreFile
  } catch {
    return { documents: [] } satisfies StoreFile
  }
}

const loadInput = async (id: string | undefined, filePath: string | undefined) => {
  if (id) {
    const store = await loadStore()
    const document = store.documents?.find((candidate) => candidate.id === id)
    if (!document) throw new Error(`No hosted document found for id ${id}.`)
    return {
      title: document.title,
      markdown: document.markdown,
      sourceDocumentId: document.id,
      sourcePath: document.sourcePath,
    }
  }

  if (filePath) {
    const resolved = resolve(filePath)
    const markdown = await readFile(resolved, "utf8")
    return {
      title: basename(resolved),
      markdown,
      sourcePath: resolved,
    }
  }

  throw new Error("Pass --id <document-id> or --filePath <absolute-markdown-path>.")
}

const updateManifest = async (entry: PublishedDocumentManifestEntry) => {
  let manifest: PublishedDocumentManifest = { documents: [] }
  try {
    manifest = JSON.parse(await readFile(publishedIndexPath, "utf8")) as PublishedDocumentManifest
  } catch {
    // noop
  }

  const documents = manifest.documents.filter((document) => document.slug !== entry.slug)
  documents.unshift(entry)
  await writeFile(publishedIndexPath, JSON.stringify({ documents }, null, 2), "utf8")
}

const main = async () => {
  const { id, filePath, slug } = parseArgs()
  const input = await loadInput(id, filePath)
  const resolvedSlug = slugify(slug ?? input.title)
  const snapshot = preparePublishedSnapshot({
    slug: resolvedSlug,
    title: input.title,
    markdown: input.markdown,
    exportedAt: new Date().toISOString(),
    sourceDocumentId: input.sourceDocumentId,
    sourcePath: input.sourcePath,
    document: {
      sections: input.markdown.trim() === "" ? [] : [{ _tag: "markdown", markdown: input.markdown }],
    },
  } satisfies PublishedDocumentSnapshot)

  await mkdir(publishedDir, { recursive: true })
  await Promise.all([
    writeFile(resolve(publishedDir, `${resolvedSlug}.json`), JSON.stringify(snapshot, null, 2), "utf8"),
    updateManifest({
      slug: resolvedSlug,
      title: input.title,
      exportedAt: snapshot.exportedAt,
      sourceDocumentId: input.sourceDocumentId,
      url: `/published/${encodeURIComponent(resolvedSlug)}`,
    }),
  ])

  console.log(JSON.stringify({ slug: resolvedSlug, url: `/published/${encodeURIComponent(resolvedSlug)}` }, null, 2))
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

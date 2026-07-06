import type { PublishedDocumentSnapshot } from "./published"

export const PUBLISHED_ANNOTATIONS_STORAGE_VERSION = 1 as const

const storagePrefix = `behold:published-annotations:v${PUBLISHED_ANNOTATIONS_STORAGE_VERSION}:`

export type PublishedSnapshotIdentity = Pick<PublishedDocumentSnapshot, "slug" | "exportedAt">

export interface PublishedAnnotationAnchor {
  readonly sectionIndex: number
  readonly sectionTitle?: string
  readonly selectedText: string
  readonly contextBefore?: string
  readonly contextAfter?: string
  readonly renderedRange?: { readonly start: number; readonly end: number }
}

export interface PublishedAnnotation {
  readonly id: string
  readonly anchor: PublishedAnnotationAnchor
  readonly content: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface PublishedAnnotationInput {
  readonly id: string
  readonly anchor: PublishedAnnotationAnchor
  readonly content: string
  readonly createdAt: string
}

export interface PublishedAnnotationUpdate {
  readonly anchor?: PublishedAnnotationAnchor
  readonly content?: string
  readonly updatedAt: string
}

export interface PublishedAnnotationStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface StoredPublishedAnnotations {
  readonly version: typeof PUBLISHED_ANNOTATIONS_STORAGE_VERSION
  readonly snapshot: PublishedSnapshotIdentity
  readonly annotations: ReadonlyArray<PublishedAnnotation>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== ""

const isTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value))

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string"

const isOptionalRenderedRange = (value: unknown): value is PublishedAnnotationAnchor["renderedRange"] =>
  value === undefined || (
    isRecord(value) &&
    Number.isInteger(value.start) &&
    Number.isInteger(value.end) &&
    (value.start as number) >= 0 &&
    (value.end as number) > (value.start as number)
  )

const isAnchor = (value: unknown): value is PublishedAnnotationAnchor =>
  isRecord(value) &&
  typeof value.sectionIndex === "number" &&
  Number.isInteger(value.sectionIndex) &&
  value.sectionIndex >= 0 &&
  isNonEmptyString(value.selectedText) &&
  isOptionalString(value.sectionTitle) &&
  isOptionalString(value.contextBefore) &&
  isOptionalString(value.contextAfter) &&
  isOptionalRenderedRange(value.renderedRange)

const isAnnotation = (value: unknown): value is PublishedAnnotation =>
  isRecord(value) &&
  isNonEmptyString(value.id) &&
  isAnchor(value.anchor) &&
  isNonEmptyString(value.content) &&
  isTimestamp(value.createdAt) &&
  isTimestamp(value.updatedAt) &&
  Date.parse(value.updatedAt) >= Date.parse(value.createdAt)

const compareAnnotations = (left: PublishedAnnotation, right: PublishedAnnotation): number => {
  const byCreation = Date.parse(left.createdAt) - Date.parse(right.createdAt)
  if (byCreation !== 0) return byCreation
  if (left.id < right.id) return -1
  if (left.id > right.id) return 1
  return 0
}

const normalizeAnnotations = (annotations: ReadonlyArray<PublishedAnnotation>): ReadonlyArray<PublishedAnnotation> => {
  const seen = new Set<string>()
  return annotations
    .filter(isAnnotation)
    .slice()
    .sort(compareAnnotations)
    .filter((annotation) => {
      if (seen.has(annotation.id)) return false
      seen.add(annotation.id)
      return true
    })
}

const browserStorage = (): PublishedAnnotationStorage | null => {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage
  } catch {
    return null
  }
}

export const publishedAnnotationsStorageKey = (snapshot: PublishedSnapshotIdentity): string =>
  `${storagePrefix}${encodeURIComponent(snapshot.slug)}:${encodeURIComponent(snapshot.exportedAt)}`

export const publishedSnapshotRevisionId = (snapshot: PublishedSnapshotIdentity): string =>
  `published:${encodeURIComponent(snapshot.slug)}:${encodeURIComponent(snapshot.exportedAt)}`

export const listPublishedAnnotations = (
  snapshot: PublishedSnapshotIdentity,
  serialized: string | null,
): ReadonlyArray<PublishedAnnotation> => {
  if (serialized === null) return []

  try {
    const value: unknown = JSON.parse(serialized)
    if (
      !isRecord(value) ||
      value.version !== PUBLISHED_ANNOTATIONS_STORAGE_VERSION ||
      !isRecord(value.snapshot) ||
      typeof value.snapshot.slug !== "string" ||
      typeof value.snapshot.exportedAt !== "string" ||
      value.snapshot.slug !== snapshot.slug ||
      value.snapshot.exportedAt !== snapshot.exportedAt ||
      !Array.isArray(value.annotations)
    ) {
      return []
    }
    return normalizeAnnotations(value.annotations)
  } catch {
    return []
  }
}

export const serializePublishedAnnotations = (
  snapshot: PublishedSnapshotIdentity,
  annotations: ReadonlyArray<PublishedAnnotation>,
): string => JSON.stringify({
  version: PUBLISHED_ANNOTATIONS_STORAGE_VERSION,
  snapshot: { slug: snapshot.slug, exportedAt: snapshot.exportedAt },
  annotations: normalizeAnnotations(annotations),
} satisfies StoredPublishedAnnotations)

export const createPublishedAnnotation = (
  annotations: ReadonlyArray<PublishedAnnotation>,
  input: PublishedAnnotationInput,
): ReadonlyArray<PublishedAnnotation> => {
  const current = normalizeAnnotations(annotations)
  if (current.some((annotation) => annotation.id === input.id)) return current

  const annotation: PublishedAnnotation = { ...input, updatedAt: input.createdAt }
  return isAnnotation(annotation) ? normalizeAnnotations([...current, annotation]) : current
}

export const updatePublishedAnnotation = (
  annotations: ReadonlyArray<PublishedAnnotation>,
  id: string,
  update: PublishedAnnotationUpdate,
): ReadonlyArray<PublishedAnnotation> => normalizeAnnotations(annotations.map((annotation) => {
  if (annotation.id !== id) return annotation
  const updated = {
    ...annotation,
    ...(update.anchor === undefined ? {} : { anchor: update.anchor }),
    ...(update.content === undefined ? {} : { content: update.content }),
    updatedAt: update.updatedAt,
  }
  return isAnnotation(updated) ? updated : annotation
}))

export const deletePublishedAnnotation = (
  annotations: ReadonlyArray<PublishedAnnotation>,
  id: string,
): ReadonlyArray<PublishedAnnotation> => normalizeAnnotations(
  annotations.filter((annotation) => annotation.id !== id),
)

export const loadPublishedAnnotations = (
  snapshot: PublishedSnapshotIdentity,
  storage: PublishedAnnotationStorage | null = browserStorage(),
): ReadonlyArray<PublishedAnnotation> => {
  if (storage === null) return []
  try {
    return listPublishedAnnotations(snapshot, storage.getItem(publishedAnnotationsStorageKey(snapshot)))
  } catch {
    return []
  }
}

export const savePublishedAnnotations = (
  snapshot: PublishedSnapshotIdentity,
  annotations: ReadonlyArray<PublishedAnnotation>,
  storage: PublishedAnnotationStorage | null = browserStorage(),
): boolean => {
  if (storage === null) return false
  try {
    const normalized = normalizeAnnotations(annotations)
    const key = publishedAnnotationsStorageKey(snapshot)
    if (normalized.length === 0) storage.removeItem(key)
    else storage.setItem(key, serializePublishedAnnotations(snapshot, normalized))
    return true
  } catch {
    return false
  }
}

const escapeHeading = (value: string): string => value
  .replace(/[\r\n]+/g, " ")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/([\\`*_[\]#])/g, "\\$1")
  .trim()

const blockquote = (value: string): string => value
  .replace(/\r\n?/g, "\n")
  .split("\n")
  .map((line) => line === "" ? ">" : `> ${line}`)
  .join("\n")

const safePublicUrl = (value: string): string => value
  .replace(/[\r\n]/g, "")
  .trim()
  .replace(/</g, "%3C")
  .replace(/>/g, "%3E")
  .replace(/\s/g, (character) => encodeURIComponent(character))

export const formatPublishedFeedbackMarkdown = (input: {
  readonly title: string
  readonly publicUrl: string
  readonly annotations: ReadonlyArray<PublishedAnnotation>
}): string => {
  const annotations = normalizeAnnotations(input.annotations)
  const lines = [
    `# Feedback on ${escapeHeading(input.title)}`,
    "",
    `Source: <${safePublicUrl(input.publicUrl)}>`,
    "",
  ]

  if (annotations.length === 0) return [...lines, "_No annotations._", ""].join("\n")

  annotations.forEach((annotation, index) => {
    const section = annotation.anchor.sectionTitle?.trim()
    lines.push(
      `## ${index + 1}. ${section ? escapeHeading(section) : `Section ${annotation.anchor.sectionIndex + 1}`}`,
      "",
      "**Selected quote**",
      "",
      blockquote(annotation.anchor.selectedText),
      "",
      "**Comment**",
      "",
      blockquote(annotation.content),
      "",
    )
  })

  return lines.join("\n")
}

export const exportPublishedDocumentMarkdown = (
  snapshot: Pick<PublishedDocumentSnapshot, "markdown">,
): string => snapshot.markdown

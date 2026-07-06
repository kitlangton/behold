import type { RenderedDocument, RenderedDocumentSection } from "./document-viewer"

export interface PublishedDocumentSnapshot {
  readonly slug: string
  readonly title: string
  readonly markdown: string
  readonly exportedAt: string
  readonly sourceDocumentId?: string
  readonly sourcePath?: string
  readonly document: RenderedDocument
}

export interface PublishedDocumentManifestEntry {
  readonly slug: string
  readonly title: string
  readonly exportedAt: string
  readonly sourceDocumentId?: string
  readonly url: string
}

export interface PublishedDocumentManifest {
  readonly documents: ReadonlyArray<PublishedDocumentManifestEntry>
}

export const isPublishedSlug = (value: string): boolean => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)

export const preparePublishedSnapshot = (snapshot: PublishedDocumentSnapshot): PublishedDocumentSnapshot => ({
  slug: snapshot.slug,
  title: snapshot.title,
  markdown: snapshot.markdown,
  exportedAt: snapshot.exportedAt,
  document: {
    sections: snapshot.document.sections.map((section) => ({
      _tag: section._tag,
      markdown: section.markdown,
    })),
  },
})

export type { RenderedDocumentSection as PublishedDocumentSection }

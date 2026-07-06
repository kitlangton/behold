import { Schema } from "effect"

const OptionalString = Schema.optionalKey(Schema.String)

export const PublicationReceiptSchema = Schema.Struct({
  slug: Schema.String,
  url: Schema.String,
  exportedAt: Schema.String,
  publishedRevisionId: Schema.String,
  remoteStatus: Schema.Literals(["published", "missing", "unavailable"]),
  checkedAt: Schema.String,
})
export interface PublicationReceipt extends Schema.Schema.Type<typeof PublicationReceiptSchema> {}

export const HostedDocumentSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  markdown: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  sourcePath: OptionalString,
  version: Schema.Number,
  currentRevisionId: Schema.String,
  revisionId: Schema.String,
  publication: Schema.optionalKey(PublicationReceiptSchema),
})

export const DocumentMutationSchema = Schema.Struct({
  id: Schema.String,
  postUrl: Schema.String,
  documentUrl: Schema.String,
  url: Schema.String,
  sourcePath: OptionalString,
  updated: Schema.Boolean,
  unchanged: Schema.Boolean,
  message: Schema.String,
  version: Schema.Number,
  currentRevisionId: Schema.String,
  revisionId: Schema.String,
  publication: Schema.optionalKey(PublicationReceiptSchema),
})

export const DocumentSummarySchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  url: Schema.String,
  version: Schema.Number,
  currentRevisionId: Schema.String,
  revisionId: Schema.String,
  publication: Schema.optionalKey(PublicationReceiptSchema),
})

export const DocumentListSchema = Schema.Struct({ documents: Schema.Array(DocumentSummarySchema) })

export const DocumentVersionSchema = Schema.Struct({
  id: Schema.String,
  revisionId: Schema.String,
  version: Schema.Number,
  parentRevisionId: OptionalString,
  title: Schema.String,
  createdAt: Schema.String,
})

export const DocumentVersionsSchema = Schema.Struct({
  documentId: Schema.String,
  currentVersion: Schema.Number,
  currentRevisionId: Schema.String,
  versions: Schema.Array(DocumentVersionSchema),
})

export const RevisionDiffSchema = Schema.Struct({
  documentId: Schema.String,
  fromRevisionId: Schema.String,
  toRevisionId: Schema.String,
  patch: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
})

export const DocumentDeleteResultSchema = Schema.Struct({
  documentId: Schema.String,
  deleted: Schema.Literal(true),
})

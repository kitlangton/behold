export const safeResourceUrl = (
  value: string,
  options?: { readonly allowAnchor?: boolean; readonly allowMailto?: boolean },
): string | undefined => {
  if (options?.allowAnchor !== false && (value.startsWith("#") || value.startsWith("?"))) return value
  if (value.startsWith("/")) return value.startsWith("//") ? undefined : value
  if (value.startsWith("./") || value.startsWith("../")) return value

  try {
    const url = new URL(value)
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString()
    if (options?.allowMailto === true && url.protocol === "mailto:") return url.toString()
    return undefined
  } catch {
    return undefined
  }
}

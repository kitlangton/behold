import type { HighlighterCore } from "shiki/core"

let highlighter: HighlighterCore | null = null
let highlighterPromise: Promise<HighlighterCore> | null = null

export const initHighlighter = async () => {
  if (highlighter) return
  highlighterPromise ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("@shikijs/themes/github-dark-default"),
    import("@shikijs/langs/typescript"),
    import("@shikijs/langs/tsx"),
    import("@shikijs/langs/javascript"),
    import("@shikijs/langs/jsx"),
    import("@shikijs/langs/json"),
    import("@shikijs/langs/jsonc"),
    import("@shikijs/langs/html"),
    import("@shikijs/langs/css"),
    import("@shikijs/langs/markdown"),
    import("@shikijs/langs/bash"),
    import("@shikijs/langs/yaml"),
    import("@shikijs/langs/sql"),
    import("@shikijs/langs/python"),
    import("@shikijs/langs/go"),
    import("@shikijs/langs/rust"),
    import("@shikijs/langs/java"),
    import("@shikijs/langs/c"),
    import("@shikijs/langs/cpp"),
    import("@shikijs/langs/toml"),
    import("@shikijs/langs/xml"),
    import("@shikijs/langs/diff"),
  ])
    .then(([core, engine, theme, ...languages]) =>
      core.createHighlighterCore({
        themes: [theme.default],
        langs: languages.flatMap((language) => language.default),
        engine: engine.createJavaScriptRegexEngine(),
      }),
    )
    .catch((error) => {
      highlighterPromise = null
      throw error
    })
  highlighter = await highlighterPromise
}

export const highlight = (code: string, lang?: string): string | null => {
  if (!highlighter) return null
  const resolved = resolveLang(lang)
  if (!resolved) return null

  try {
    return highlighter.codeToHtml(code, { lang: resolved, theme: "github-dark-default" })
  } catch {
    return null
  }
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

export const highlightLines = (code: string, lang?: string): ReadonlyArray<string> | null => {
  if (!highlighter) return null
  const resolved = resolveLang(lang)
  if (!resolved) return null

  try {
    const result = highlighter.codeToTokens(code, { lang: resolved, theme: "github-dark-default" })
    return result.tokens.map((line) => line.map((token) => {
      const styles = [token.color ? `color:${token.color}` : ""]
      if ((token.fontStyle ?? 0) & 1) styles.push("font-style:italic")
      if ((token.fontStyle ?? 0) & 2) styles.push("font-weight:700")
      if ((token.fontStyle ?? 0) & 4) styles.push("text-decoration:underline")
      const style = styles.filter(Boolean).join(";")
      return style === "" ? escapeHtml(token.content) : `<span style="${style}">${escapeHtml(token.content)}</span>`
    }).join(""))
  } catch {
    return null
  }
}

const aliases: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  yml: "yaml",
  md: "markdown",
}

const resolveLang = (lang: string | undefined): string | null => {
  if (!lang) return null
  const l = lang.trim().toLowerCase()
  return l === "" ? null : (aliases[l] ?? l)
}

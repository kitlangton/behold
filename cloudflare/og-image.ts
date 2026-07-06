import { ImageResponse } from "workers-og"
import monoRegular from "./fonts/jetbrains-mono-latin-400-normal.woff"
import monoBold from "./fonts/jetbrains-mono-latin-700-normal.woff"

export interface OgCard {
  readonly title: string
  readonly description: string
  readonly kicker: string
  readonly host: string
  readonly footnote?: string
}

const palette = {
  background: "#050505",
  inset: "#0d0d0d",
  strong: "#f1efe8",
  muted: "#8b8983",
  faint: "#7a7872",
  line: "#222222",
  accent: "#7b96ff",
}

const escapeHtml = (input: string): string =>
  input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

const clip = (value: string, maxLength: number): string => {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) return normalized
  const cut = normalized.slice(0, maxLength - 1)
  const boundary = cut.lastIndexOf(" ")
  return `${(boundary > maxLength * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`
}

const titleSize = (title: string): number => (title.length > 64 ? 48 : title.length > 34 ? 58 : 72)

const eyeSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path fill="${palette.strong}" d="M247.31 124.76c-.35-.79-8.82-19.58-27.65-38.41C194.57 61.26 162.88 48 128 48S61.43 61.26 36.34 86.35C17.51 105.18 9 124 8.69 124.76a8 8 0 0 0 0 6.5c.35.79 8.82 19.57 27.65 38.4C61.43 194.74 93.12 208 128 208s66.57-13.26 91.66-38.34c18.83-18.83 27.3-37.61 27.65-38.4a8 8 0 0 0 0-6.5Z"/><circle fill="${palette.inset}" cx="128" cy="128" r="36"/></svg>`

const eyeMark = (size: number): string =>
  `<img width="${size}" height="${size}" src="data:image/svg+xml,${encodeURIComponent(eyeSvg)}" />`

const cardHtml = (card: OgCard): string => {
  const title = clip(card.title, 96)
  const description = clip(card.description, 150)
  const brand =
    `<div style="display: flex; align-items: center; gap: 18px;">${eyeMark(34)}` +
    `<div style="display: flex; color: ${palette.strong}; font-size: 26px; font-weight: 700; letter-spacing: 8px;">BEHOLD</div></div>`
  const kicker = `<div style="display: flex; color: ${palette.faint}; font-size: 20px; letter-spacing: 4px;">${escapeHtml(card.kicker.toUpperCase())}</div>`
  const heading =
    `<div style="display: flex; align-items: center; justify-content: space-between; padding: 28px 48px; border-bottom: 1px solid ${palette.line};">${brand}${kicker}</div>`
  const body =
    `<div style="display: flex; flex: 1; flex-direction: column; justify-content: center; gap: 28px; padding: 24px 48px;">` +
    `<div style="display: flex; color: ${palette.strong}; font-size: ${titleSize(title)}px; font-weight: 700; line-height: 1.2; letter-spacing: -1px;">${escapeHtml(title)}</div>` +
    `<div style="display: flex; color: ${palette.muted}; font-size: 28px; line-height: 1.5;">${escapeHtml(description)}</div></div>`
  const footer =
    `<div style="display: flex; align-items: center; justify-content: space-between; padding: 26px 48px; border-top: 1px solid ${palette.line};">` +
    `<div style="display: flex; color: ${palette.accent}; font-size: 22px;">${escapeHtml(card.host)}</div>` +
    `<div style="display: flex; color: ${palette.faint}; font-size: 20px; letter-spacing: 2px;">${escapeHtml(card.footnote ?? "")}</div></div>`
  return (
    `<div style="display: flex; width: 1200px; height: 630px; background: ${palette.background}; padding: 40px; font-family: 'JetBrains Mono';">` +
    `<div style="display: flex; flex-direction: column; width: 100%; height: 100%; border: 1px solid ${palette.line}; background: ${palette.inset};">${heading}${body}${footer}</div></div>`
  )
}

export const ogImageResponse = (card: OgCard): Response =>
  new ImageResponse(cardHtml(card), {
    width: 1200,
    height: 630,
    fonts: [
      { name: "JetBrains Mono", data: monoRegular, weight: 400, style: "normal" },
      { name: "JetBrains Mono", data: monoBold, weight: 700, style: "normal" },
    ],
    headers: {
      "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
    },
  })

import { For, createSignal } from "solid-js"

type ToastVariant = "success" | "error" | "info"

interface ToastItem {
  readonly id: number
  readonly variant: ToastVariant
  readonly description: string
}

const [toasts, setToasts] = createSignal<ReadonlyArray<ToastItem>>([])
let nextToastId = 0

export const showToast = (options: { readonly variant?: ToastVariant; readonly description: string }) => {
  const id = ++nextToastId
  setToasts((current) => [...current, { id, variant: options.variant ?? "info", description: options.description }])
  window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4000)
}

export function ToastRegion() {
  return (
    <div class="toast-region" role="status" aria-live="polite">
      <For each={toasts()}>{(toast) => <div class={`toast toast-${toast.variant}`}>{toast.description}</div>}</For>
    </div>
  )
}

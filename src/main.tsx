import { render } from "solid-js/web"
import "@fontsource-variable/inter/wght.css"
import "@fontsource-variable/inter/wght-italic.css"
import "@fontsource-variable/jetbrains-mono/wght.css"
import "@fontsource-variable/jetbrains-mono/wght-italic.css"
import App from "./App"
import "./index.css"

const rootElement = document.getElementById("root")

if (rootElement === null) {
  throw new Error("Missing #root element")
}

render(() => <App />, rootElement)

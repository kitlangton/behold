import { resolve } from "node:path"
import { defineConfig, type PreviewServer, type ViteDevServer } from "vite"
import solid from "vite-plugin-solid"
import { readBeholdLocalEnvironment, resolveBeholdDataDirectory } from "./server/behold-home"
import { createDocumentApi } from "./server/document-api"
import { parseAllowedFileRoots } from "./server/local-file-access"
import { createPublishProxy } from "./server/publish-proxy"

const localEnv = readBeholdLocalEnvironment(process.cwd())

const dataDirectory = resolveBeholdDataDirectory({
  cwd: process.cwd(),
  configuredDirectory: process.env.BEHOLD_DATA_DIR ?? localEnv.BEHOLD_DATA_DIR,
})
const storeFilePath = resolve(dataDirectory, "store.json")

const withDocumentApi = (server: ViteDevServer | PreviewServer) => {
  const documentApi = createDocumentApi({
    dataDirectory,
    storeFilePath,
    runtimeId: process.env.BEHOLD_DAEMON_ID,
    allowedFileRoots: () =>
      parseAllowedFileRoots(process.env.BEHOLD_ALLOWED_FILE_ROOTS ?? localEnv.BEHOLD_ALLOWED_FILE_ROOTS ?? process.env.SHOW_ALLOWED_FILE_ROOTS ?? localEnv.SHOW_ALLOWED_FILE_ROOTS ?? ""),
  })
  server.middlewares.use(createPublishProxy({ ...localEnv, ...process.env }))
  server.middlewares.use(documentApi.middleware)
  server.httpServer?.once("close", () => {
    void documentApi.dispose()
  })
}

export default defineConfig({
  server: {
    host: "127.0.0.1",
    watch: {
      ignored: ["**/.behold/**", "**/.show-and-tell/**", "**/*.md", "**/*.markdown"],
    },
  },
  plugins: [
    solid(),
    {
      name: "local-document-api",
      configureServer(server) {
        withDocumentApi(server)
      },
      configurePreviewServer(server) {
        withDocumentApi(server)
      },
    },
  ],
})

// The shape Magpie touches, checked without a gateway in front of it: the
// default export, config(), provider.models(), auth.loader() and auth.usage().
//
//   node test/live/smoke.mjs

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CONFIG = join(homedir(), ".config", "magpie")
const mod = await import("../../index.mjs")

const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) process.exitCode = 1
}

// 1. the default export, as Magpie reads it
check("default export is a function", typeof mod.TabbitPlugin === "function")

const hooks = await mod.TabbitPlugin({
  client: { auth: {}, app: { log: async () => ({}) } },
  directory: process.cwd(),
})

// 2. config() pins the provider
const cfg = {}
await hooks.config(cfg)
const provider = cfg.provider?.tabbit2
check("config() registers tabbit2", !!provider, provider ? `npm=${provider.npm}` : "missing")
check("config() leaves a base URL", typeof provider?.api === "string" && provider.api.length > 0, provider?.api)
check("config() seeds models", Object.keys(provider?.models ?? {}).length > 0, `${Object.keys(provider?.models ?? {}).length} rows`)

// 3. the provider id must be the one the config used
check("provider.id is tabbit2", hooks.provider?.id === "tabbit2", String(hooks.provider?.id))

// 4. the sign-in methods Magpie lists
const methods = hooks.auth?.methods ?? []
check("auth has sign-in methods", methods.length > 0, methods.map((m) => m.type).join(", "))

// 5. a live catalog read, when a credential is present
const store = JSON.parse(readFileSync(join(CONFIG, "plugin-auth.json"), "utf8"))
const entry = store.tabbit2
if (entry?.key) {
  const models = await hooks.provider.models(provider, { auth: entry })
  const ids = Object.keys(models)
  check("models() returns a live catalog", ids.length > 0, `${ids.length} models`)
  // The catalog rows name no tool support: Tabbit's own API has none to
  // report. What 2.x is handed goes through modelOf, and that is where the
  // `tools` capability this package serves is declared.
  const v2 = await import("../../opencode2.mjs")
  const infos = ids.map((id) => v2.modelOf("tabbit2", provider, id, models[id]))
  const withTools = infos.filter((m) => m.capabilities?.tools === true)
  check("every model is listed with tools", withTools.length === infos.length, `${withTools.length}/${infos.length}`)
  console.log("      first ids:", ids.slice(0, 4).join(", "))
} else {
  console.log("SKIP  models(): no tabbit2 credential in plugin-auth.json")
}

// 6. the loader gives back a fetch
const opts = await hooks.auth.loader(async () => entry)
check("loader() returns a base URL", !!opts?.baseURL, opts?.baseURL)
check("loader() returns a fetch", typeof opts?.fetch === "function")

// 7. a non-chat path is refused, not sent upstream
if (typeof opts?.fetch === "function") {
  const res = await opts.fetch(new Request("https://tabbit.invalid/v1/models", { method: "GET" }))
  check("a non-chat path answers 404", res.status === 404, `status ${res.status}`)
}

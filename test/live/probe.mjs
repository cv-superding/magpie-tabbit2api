// Live probe: one tools request against the real Tabbit, through the plugin
// as magpie loads it. Prints the prompt it sent and what came back.
//
//   node test/live/probe.mjs [--no-tools]

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CONFIG = join(homedir(), ".config", "magpie")
const withTools = !process.argv.includes("--no-tools")

const authStore = JSON.parse(readFileSync(join(CONFIG, "plugin-auth.json"), "utf8"))
const entry = authStore.tabbit2 ?? authStore.tabbit
if (!entry?.key) {
  console.error("no Tabbit credential in plugin-auth.json (expected `tabbit2` or `tabbit`)")
  process.exit(1)
}

const mod = await import("../../index.mjs")
const hooks = await mod.TabbitPlugin({
  client: { auth: {}, app: { log: async () => ({}) } },
  directory: process.cwd(),
})
const opts = await hooks.auth.loader(async () => entry)

const tools = [
  {
    type: "function",
    function: {
      name: "working_directory",
      description: "Print the working directory of the caller's machine.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_env",
      description: "Read one environment variable.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Variable name." } },
        required: ["name"],
      },
    },
  },
]

const question = process.argv.includes("--no-tools")
  ? "你知道你当前所处的目录吗？一句话回答。"
  : "你知道你当前所处的目录吗？如果不确定，用工具查一下。"

const body = {
  model: "tabbit/GPT-5.2-Chat",
  stream: true,
  messages: [{ role: "user", content: question }],
  ...(withTools ? { tools } : {}),
}

console.log("model:", body.model, "| tools:", withTools ? tools.length : 0)
console.log("question:", question)
console.log("---")

const request = new Request("https://tabbit.invalid/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", "x-magpie-tabbit-session": `live-${Date.now()}` },
  body: JSON.stringify(body),
})
const started = Date.now()
const res = await opts.fetch(request)
const text = await res.text()
console.log("status:", res.status, `(${((Date.now() - started) / 1000).toFixed(1)}s)`)

const chunks = []
for (const line of text.split("\n")) {
  if (!line.startsWith("data: ")) continue
  const payload = line.slice(6)
  if (payload === "[DONE]") continue
  try {
    chunks.push(JSON.parse(payload))
  } catch {
    /* skip */
  }
}

const error = chunks.find((c) => c.error)
if (error) {
  console.log("ERROR:", JSON.stringify(error.error))
  process.exit(1)
}

const content = chunks.flatMap((c) => c.choices?.[0]?.delta?.content ?? []).join("")
const calls = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
const finish = chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean)

console.log("--- text ---")
console.log(content || "(none)")
console.log("--- tool_calls ---")
console.log(calls.length ? JSON.stringify(calls, null, 2) : "(none)")
console.log("--- finish_reason ---")
console.log(finish.join(", ") || "(none)")

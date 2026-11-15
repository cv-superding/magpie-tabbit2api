// The question a user actually types, with no hint that a tool exists.
// This is the case that failed: the model answered "I'm a browser assistant,
// I have no working directory" instead of calling the tool that knows.

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const store = JSON.parse(readFileSync(join(homedir(), ".config", "magpie", "plugin-auth.json"), "utf8"))
const entry = store.tabbit2
const mod = await import("../../index.mjs")
const hooks = await mod.TabbitPlugin({ client: { auth: {}, app: { log: async () => ({}) } }, directory: process.cwd() })
const opts = await hooks.auth.loader(async () => entry)

const QUESTION = process.argv[2] ?? "你在哪个工作目录"

const body = {
  model: "tabbit/DeepSeek-V4.1-Flash",
  stream: true,
  messages: [{ role: "user", content: QUESTION }],
  tools: [
    {
      type: "function",
      function: {
        name: "working_directory",
        description: "Print the working directory of the caller's machine.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
  ],
}

const res = await opts.fetch(
  new Request("https://tabbit.invalid/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-magpie-tabbit-session": `plain-${Date.now()}` },
    body: JSON.stringify(body),
  }),
)
const text = await res.text()
const chunks = []
for (const line of text.split("\n")) {
  if (!line.startsWith("data: ")) continue
  const p = line.slice(6)
  if (p === "[DONE]") continue
  try {
    chunks.push(JSON.parse(p))
  } catch {
    /* skip */
  }
}
const content = chunks.flatMap((c) => c.choices?.[0]?.delta?.content ?? []).join("")
const calls = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
const finish = chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean)

console.log("问:", QUESTION)
console.log("finish:", finish.join(","))
console.log("calls:", calls.length ? calls.map((c) => `${c.function.name} ${c.function.arguments}`).join(", ") : "(none)")
console.log("content:", content.trim() ? JSON.stringify(content.trim().slice(0, 220)) : "(empty)")
console.log(finish.includes("tool_calls") ? "\nPASS — 无提示主动调用" : "\nFAIL — 没调工具")

// Live multi-turn: the full agent loop against the real Tabbit.
//
//   turn 1  user asks something that needs a tool  → expect tool_calls
//   turn 2  the result goes back                  → expect the answer
//
//   node test/live/loop.mjs

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CONFIG = join(homedir(), ".config", "magpie")
const store = JSON.parse(readFileSync(join(CONFIG, "plugin-auth.json"), "utf8"))
const entry = store.tabbit2 ?? store.tabbit
if (!entry?.key) {
  console.error("no Tabbit credential found")
  process.exit(1)
}

const mod = await import("../../index.mjs")
const hooks = await mod.TabbitPlugin({
  client: { auth: {}, app: { log: async () => ({}) } },
  directory: process.cwd(),
})
const opts = await hooks.auth.loader(async () => entry)

const SECRET = "OMEGA-9931"
const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file from the caller's machine and return its contents.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path to the file." } },
        required: ["path"],
      },
    },
  },
]

// The caller's side of the tool: what the plugin never sees.
const runTool = (name, args) => {
  if (name === "read_file") return `notes.txt says: the access code is ${SECRET}. Keep it.`
  return "no such tool"
}

const session = `live-loop-${Date.now()}`

async function turn(messages) {
  const request = new Request("https://tabbit.invalid/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-magpie-tabbit-session": session },
    body: JSON.stringify({ model: "tabbit/GPT-5.2-Chat", stream: true, messages, tools }),
  })
  const res = await opts.fetch(request)
  const text = await res.text()
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
  return {
    content: chunks.flatMap((c) => c.choices?.[0]?.delta?.content ?? []).join(""),
    calls: chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []),
    finish: chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean),
    error: chunks.find((c) => c.error)?.error,
  }
}

const messages = [
  { role: "user", content: "请用 read_file 读一下 C:/notes.txt，然后告诉我里面的访问码是什么。" },
]

console.log("== turn 1 ==")
const first = await turn(messages)
if (first.error) {
  console.log("ERROR:", JSON.stringify(first.error))
  process.exit(1)
}
console.log("finish:", first.finish.join(","))
console.log("text:", (first.content || "(none)").slice(0, 300))
console.log("calls:", JSON.stringify(first.calls, null, 1))

if (!first.calls.length) {
  console.log("FAIL: no tool_calls on turn 1")
  process.exit(1)
}

// Replay the assistant turn and answer the call, the way an agent client does.
messages.push({
  role: "assistant",
  content: first.content || null,
  tool_calls: first.calls.map((c) => ({
    id: c.id,
    type: "function",
    function: { name: c.function.name, arguments: c.function.arguments },
  })),
})
for (const c of first.calls) {
  const result = runTool(c.function.name, JSON.parse(c.function.arguments || "{}"))
  messages.push({ role: "tool", tool_call_id: c.id, content: result })
  console.log(`ran ${c.function.name} -> ${result}`)
}

console.log("\n== turn 2 ==")
const second = await turn(messages)
if (second.error) {
  console.log("ERROR:", JSON.stringify(second.error))
  process.exit(1)
}
console.log("finish:", second.finish.join(","))
console.log("text:", (second.content || "(none)").slice(0, 400))
console.log("calls:", second.calls.length ? JSON.stringify(second.calls, null, 1) : "(none)")

if (second.content.includes(SECRET)) console.log(`\nPASS: the answer carries ${SECRET} from the tool result`)
else console.log(`\nCHECK: ${SECRET} not in the answer — read it and judge`)

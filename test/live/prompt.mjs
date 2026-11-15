// Print the prompt a second turn actually sends, given a transcript that
// already carries a tool result. No network: planTurn/flatten are pure.

import { _internal } from "../../index.mjs"

const messages = [
  { role: "user", content: "请用 read_file 读一下 C:/notes.txt，然后告诉我里面的访问码是什么。" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"C:/notes.txt"}' } },
    ],
  },
  { role: "tool", tool_call_id: "call_1", content: "notes.txt says: the access code is OMEGA-9931. Keep it." },
]

const history = _internal.historyOf(messages)
console.log("== historyOf ==")
for (const m of history) console.log(JSON.stringify(m))

const protocol = "[PROTOCOL BLOCK]"
const plan = _internal.planTurn(undefined, messages, { protocol, forceFlatten: true })
console.log("\n== planTurn ==")
console.log("room:", plan.room)
console.log("content:\n" + plan.content)

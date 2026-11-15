// End-to-end: a chat/completions request with tools goes in, tool_calls come
// out. Tabbit is stubbed at the HTTP boundary, so everything between — prompt
// assembly, room+runs+join, SSE reading, the text-protocol parser — is the
// shipping code.

import assert from "node:assert/strict"
import test from "node:test"

const MODULE = new URL("../index.mjs", import.meta.url)

// ---- a fake Tabbit -------------------------------------------------------

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

function tabbitStub(replyOr, { onRun } = {}) {
  const calls = []
  // The reply can be a function of the prompt the plugin actually sent: the
  // marker is random per request, so a fixed reply could never match it.
  let reply = typeof replyOr === "function" ? "" : replyOr
  const stub = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input)
    let body
    try {
      body = init.body ? JSON.parse(init.body) : undefined
    } catch {
      body = init.body
    }
    calls.push({ url, body })
    if (url.includes("/runs")) {
      onRun?.(body)
      if (typeof replyOr === "function") reply = replyOr(body?.input_payload?.content ?? "")
      return new Response(JSON.stringify({ run_id: "run-1" }), { status: 200 })
    }
    if (url.includes("/join")) {
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder()
          const push = (s) => controller.enqueue(enc.encode(s))
          push(frame("assistant_message_started", { payload: { run_id: "run-1", message_id: "m-2" } }))
          // Split mid-token on purpose: a marker and an <invoke> straddling
          // frames is how a real stream delivers them.
          const size = 9
          for (let i = 0; i < reply.length; i += size) {
            const value = reply.slice(i, i + size)
            push(frame("assistant_message_delta", { payload: { chunk_payload: { content: value } } }))
          }
          push(frame("assistant_message_finished", { payload: { message_id: "m-2", model_name: "test" } }))
          push(frame("run_completed", { payload: {} }))
          controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    if (url.includes("/rooms")) return new Response(JSON.stringify({ room_id: "room-1" }), { status: 200 })
    return new Response(JSON.stringify({ code: "0" }), { status: 200 })
  }
  return { stub, calls }
}

let generation = 0

let sessionSeq = 0

// send drives one request through the plugin and returns parsed SSE chunks.
// Each call gets its own session: the plugin keys a Tabbit room by session,
// and a shared key would let one test continue another's room.
async function send({ reply, body, onRun, auth = { access: "jwt", account: { id: "acct-1" } } }) {
  const session = `sess-${++sessionSeq}`
  const { stub, calls } = tabbitStub(reply, { onRun })
  let fetchImpl
  const real = globalThis.fetch
  globalThis.fetch = stub
  try {
    const mod = await import(MODULE.href + `?n=${++generation}`)
    // The package's own entry (opencode.mjs) is what magpie loads; this is
    // that same TabbitPlugin, called the way opencode2.mjs calls it.
    const hooks = await mod.TabbitPlugin({
      client: { auth: {}, app: { log: async () => ({}) } },
      directory: process.cwd(),
    })
    const opts = await hooks.auth.loader(async () => auth)
    fetchImpl = opts.fetch
    const request = new Request("https://tabbit.invalid/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-magpie-tabbit-session": session },
      body: JSON.stringify(body),
    })
    // The stub has to still be in place: src/api.mjs reads global fetch when
    // the call is made, not when the plugin was constructed.
    const res = await fetchImpl(request)
    const text = await res.text()
    // A 502 is chat() having thrown; the body names what it was.
    if (res.status >= 500) throw new Error(`plugin answered ${res.status}: ${text.slice(0, 600)}`)
    return { res, text, calls, chunks: parseChunks(text) }
  } finally {
    globalThis.fetch = real
  }
}

function parseChunks(text) {
  const out = []
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const payload = line.slice(6)
    if (payload === "[DONE]") continue
    try {
      out.push(JSON.parse(payload))
    } catch {
      /* an error event is JSON too, but skip anything unreadable */
    }
  }
  return out
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
]

const baseBody = (extra = {}) => ({
  model: "tabbit/test-model",
  stream: true,
  messages: [{ role: "user", content: "read C:/a.txt" }],
  tools: TOOLS,
  ...extra,
})

// ---- tests ---------------------------------------------------------------

// markerIn pulls the marker the plugin made out of the prompt it sent.
const markerIn = (prompt) => (String(prompt).match(/__CALL_[0-9a-f]{8}__/)?.[0] ?? "")

test("the prompt carries the tool definitions and a marker", async () => {
  let sent
  const { res } = await send({ reply: "ok", body: baseBody(), onRun: (b) => (sent = b) })
  assert.equal(res.status, 200, `status body: ${JSON.stringify(sent)} ${JSON.stringify(res.headers.get("content-type"))}`)
  const content = sent?.input_payload?.content ?? ""
  assert.match(content, /<name>read_file<\/name>/, "the definition is in the prompt")
  assert.match(content, /__CALL_[0-9a-f]{8}__/, "a marker is in the prompt")
  assert.match(content, /<invoke name="read_file">/, "the format example is in the prompt")
  assert.equal(sent?.input_payload?.agent_mode, false, "Tabbit's own tools stay off")
})

test("a reply with a marker and an <invoke> becomes tool_calls", async () => {
  const replyFor = (prompt) =>
    `Reading it.\n${markerIn(prompt)}\n<invoke name="read_file"><parameter name="path">C:/a.txt</parameter></invoke>`
  const { chunks, calls: http } = await send({ reply: replyFor, body: baseBody() })
  const calls = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
  assert.equal(calls.length, 1, `one call, got ${JSON.stringify(calls)}`)
  assert.equal(calls[0].function.name, "read_file")
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: "C:/a.txt" })
  const finish = chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean)
  assert.deepEqual(finish, ["tool_calls"])
  // one run queued: a second id per call is what makes a client pair none
  assert.equal(http.filter((c) => c.url.includes("/runs")).length, 1)
})

test("the marker and the markup never reach the answer text", async () => {
  const replyFor = (prompt) =>
    `hello ${markerIn(prompt)} <invoke name="read_file"><parameter name="path">p</parameter></invoke>`
  const { text } = await send({ reply: replyFor, body: baseBody() })
  const contentDeltas = parseChunks(text)
    .flatMap((c) => c.choices?.[0]?.delta?.content ?? [])
    .join("")
  assert.ok(!contentDeltas.includes("<invoke"), `markup leaked: ${JSON.stringify(contentDeltas)}`)
  assert.ok(!contentDeltas.includes("__CALL_"), `marker leaked: ${JSON.stringify(contentDeltas)}`)
})

test("a plain answer still finishes with stop and no tool_calls", async () => {
  const { chunks } = await send({ reply: "Just prose, nothing to call.", body: baseBody() })
  const calls = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
  assert.equal(calls.length, 0)
  const finish = chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean)
  assert.deepEqual(finish, ["stop"])
})

test("tool results are replayed into the next prompt", async () => {
  let sent
  const body = baseBody({
    messages: [
      { role: "user", content: "read C:/a.txt" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"C:/a.txt"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "the file says OMEGA-9931" },
    ],
  })
  await send({ reply: "done", body, onRun: (b) => (sent = b) })
  const content = sent?.input_payload?.content ?? ""
  assert.match(content, /OMEGA-9931/, "the tool result is in the prompt")
  assert.match(content, /read_file/, "the earlier call is named")
})

test("a request without tools leaves the protocol out", async () => {
  let sent
  const body = {
    model: "tabbit/test-model",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  }
  await send({ reply: "hello", body, onRun: (b) => (sent = b) })
  const content = sent?.input_payload?.content ?? ""
  assert.ok(!content.includes("<function_list>"), "no tool block without tools")
  assert.ok(!/__CALL_/.test(content), "no marker without tools")
})

test("tool_choice none leaves the protocol out", async () => {
  let sent
  await send({ reply: "hi", body: baseBody({ tool_choice: "none" }), onRun: (b) => (sent = b) })
  assert.ok(!(sent?.input_payload?.content ?? "").includes("<function_list>"))
})

test("tool_choice required asks for a call", async () => {
  let sent
  await send({ reply: "hi", body: baseBody({ tool_choice: "required" }), onRun: (b) => (sent = b) })
  assert.match(sent?.input_payload?.content ?? "", /MUST call at least one/)
})

test("non-streaming returns a message with tool_calls", async () => {
  const replyFor = (prompt) =>
    `x ${markerIn(prompt)} <invoke name="read_file"><parameter name="path">p</parameter></invoke>`
  const { text } = await send({ reply: replyFor, body: baseBody({ stream: false }) })
  const body = JSON.parse(text)
  const message = body.choices[0].message
  assert.equal(body.choices[0].finish_reason, "tool_calls")
  assert.equal(message.tool_calls.length, 1)
  assert.equal(message.tool_calls[0].function.name, "read_file")
})

import assert from "node:assert/strict"
import test from "node:test"

import {
  StreamParser,
  callID,
  parseInvokes,
  renderResults,
  signalFor,
  stripTags,
  toolPrompt,
  toolsXML,
  isNarration,
} from "../src/toolify.mjs"

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from disk.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path." },
          encoding: { type: "string", enum: ["utf8", "base64"] },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: { name: "working_directory", description: "Print the cwd.", parameters: { type: "object", properties: {} } },
  },
]

const drain = (parser, chunks) => {
  const out = []
  for (const chunk of chunks) out.push(...parser.push(chunk))
  out.push(...parser.finish())
  return out
}

test("signalFor gives a __CALL_hex__ marker, different each time", () => {
  const a = signalFor()
  assert.match(a, /^__CALL_[0-9a-f]{8}__$/)
  const seen = new Set()
  for (let i = 0; i < 50; i++) seen.add(signalFor())
  assert.ok(seen.size > 45, `expected distinct markers, got ${seen.size}`)
})

test("toolsXML names every tool, its parameters and their required flags", () => {
  const xml = toolsXML(TOOLS)
  assert.match(xml, /<name>read_file<\/name>/)
  assert.match(xml, /<name>working_directory<\/name>/)
  assert.match(xml, /<parameter name="path">/)
  assert.match(xml, /<required>true<\/required>/)
  assert.match(xml, /<required>false<\/required>/)
  assert.match(xml, /<enum>\["utf8","base64"\]<\/enum>/)
})

test("toolPrompt carries the signal and states the once-only rule", () => {
  const prompt = toolPrompt(TOOLS, "__CALL_abc123__")
  assert.ok(prompt.includes("__CALL_abc123__"))
  assert.match(prompt, /alone on its own line/)
  assert.match(prompt, /<name>read_file<\/name>/)
  // The instruction that stops a model from narrating the call instead of
  // making it; a real run failed without it.
  assert.match(prompt, /make the call, or answer without one/)
})

test("toolPrompt is forced when choice is required", () => {
  assert.match(toolPrompt(TOOLS, "S", { choice: "required" }), /MUST call at least one tool/)
  assert.match(toolPrompt(TOOLS, "S", { choice: "working_directory" }), /only the tool named "working_directory"/)
})

test("parseInvokes reads a single call with JSON values", () => {
  const calls = parseInvokes(`<invoke name="read_file">
<parameter name="path">C:/a.txt</parameter>
<parameter name="encoding">"utf8"</parameter>
</invoke>`)
  assert.deepEqual(calls, [{ name: "read_file", arguments: { path: "C:/a.txt", encoding: "utf8" } }])
})

test("parseInvokes reads an object argument as JSON", () => {
  const calls = parseInvokes(`<invoke name="x"><parameter name="o">{"a":[1,2]}</parameter></invoke>`)
  assert.deepEqual(calls[0].arguments.o, { a: [1, 2] })
})

test("parseInvokes reads two calls in one reply", () => {
  const calls = parseInvokes(`<invoke name="a"><parameter name="p">1</parameter></invoke>
<invoke name="b"><parameter name="q">2</parameter></invoke>`)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((c) => c.name), ["a", "b"])
})

test("parseInvokes returns nothing for a plain answer", () => {
  assert.deepEqual(parseInvokes("Just text, no calls."), [])
})

test("stripTags removes markup and markers from a replayed transcript", () => {
  const dirty = `before __CALL_abc12345__ <invoke name="a"><parameter name="p">1</parameter></invoke> after`
  const clean = stripTags(dirty)
  assert.ok(!clean.includes("<invoke"))
  assert.ok(!clean.includes("__CALL_"))
  assert.match(clean, /before/)
})

test("stripTags removes tool_result blocks", () => {
  assert.equal(stripTags(`x <tool_result id="t1">noise</tool_result> y`), "x  y")
})

test("renderResults writes tool_result blocks the model can read", () => {
  const out = renderResults([{ id: "t1", content: "hello" }])
  assert.match(out, /<tool_result id="t1">hello<\/tool_result>/)
})

test("StreamParser emits the text before the marker, then the call", () => {
  const signal = "__CALL_abc123__"
  const reply = `Checking that file now.\n${signal}\n<invoke name="read_file"><parameter name="path">C:/a.txt</parameter></invoke>`
  const events = drain(new StreamParser({ signal }), [reply])
  const text = events.filter((e) => e.type === "text").map((e) => e.value).join("")
  assert.equal(text.trim(), "Checking that file now.")
  const calls = events.filter((e) => e.type === "tool_call")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, "read_file")
  assert.equal(calls[0].arguments.path, "C:/a.txt")
  assert.match(calls[0].id, /^call_tabbit_/)
})

test("StreamParser drops reasoning that only narrates the call", () => {
  // The shape a real Tabbit run produced: the model's deliberation about
  // calling the tool arrives as `content`, and sending it beside the call
  // shows the caller the plumbing instead of an answer.
  const signal = "__CALL_abc123__"
  const reply = `The user asks if I know the working directory. I should call the tool.\n${signal}\n<invoke name="working_directory"></invoke>`
  const events = drain(new StreamParser({ signal }), [reply])
  const text = events.filter((e) => e.type === "text").map((e) => e.value).join("")
  assert.equal(text, "", `narration leaked as the answer: ${JSON.stringify(text)}`)
  assert.equal(events.filter((e) => e.type === "tool_call").length, 1)
})

test("StreamParser keeps a real answer that happens to precede a call", () => {
  const signal = "__CALL_abc123__"
  const reply = `你的访问码在文件里，我读一下。\n${signal}\n<invoke name="read_file"><parameter name="path">C:/a.txt</parameter></invoke>`
  const events = drain(new StreamParser({ signal }), [reply])
  const text = events.filter((e) => e.type === "text").map((e) => e.value).join("")
  assert.equal(text.trim(), "你的访问码在文件里，我读一下。")
})

test("isNarration tells deliberation from an answer", () => {
  assert.equal(isNarration("The user wants me to read a file. I should call read_file."), true)
  assert.equal(isNarration("Let me check that."), true)
  assert.equal(isNarration("你的访问码在文件里，我读一下。"), false)
  assert.equal(isNarration("The file contains three sections."), false)
  assert.equal(isNarration(""), false)
  // A long block is an answer, however it opens.
  assert.equal(isNarration("I should note that " + "x".repeat(800)), false)
})

test("StreamParser holds a marker split across chunks", () => {
  const signal = "__CALL_abc123__"
  const reply = `hi${signal}<invoke name="a"><parameter name="p">1</parameter></invoke>`
  const chunks = []
  for (const ch of reply) chunks.push(ch) // one character at a time
  const events = drain(new StreamParser({ signal }), chunks)
  const text = events.filter((e) => e.type === "text").map((e) => e.value).join("")
  assert.equal(text, "hi")
  assert.equal(events.filter((e) => e.type === "tool_call").length, 1)
})

test("StreamParser never leaks the marker or invoke markup as text", () => {
  const signal = "__CALL_abc123__"
  const reply = `a${signal}<invoke name="a"><parameter name="p">1</parameter></invoke>b`
  const events = drain(new StreamParser({ signal }), [reply])
  const text = events.filter((e) => e.type === "text").map((e) => e.value).join("")
  assert.ok(!text.includes("__CALL_"), `text leaked the marker: ${JSON.stringify(text)}`)
  assert.ok(!text.includes("<invoke"), `text leaked the call: ${JSON.stringify(text)}`)
})

test("StreamParser keeps a marker-free answer whole", () => {
  const events = drain(new StreamParser({ signal: "__CALL_abc123__" }), ["Hello, ", "world."])
  assert.equal(events.filter((e) => e.type === "text").map((e) => e.value).join(""), "Hello, world.")
  assert.equal(events.filter((e) => e.type === "tool_call").length, 0)
})

test("StreamParser does not treat text without a marker as a call", () => {
  const events = drain(new StreamParser({ signal: "__CALL_abc123__" }), ['I would call <invoke name="x"> but no marker.'])
  assert.equal(events.filter((e) => e.type === "tool_call").length, 0)
})

test("StreamParser reports reasoning when thinking is on", () => {
  const events = drain(new StreamParser({ signal: null, thinking: true }), ["<thinking>pondering</thinking>answer"])
  assert.equal(events.filter((e) => e.type === "thinking").map((e) => e.value).join(""), "pondering")
  assert.equal(events.filter((e) => e.type === "text").map((e) => e.value).join(""), "answer")
})

test("StreamParser flags a reply cut mid-invoke", () => {
  const signal = "__CALL_abc123__"
  const parser = new StreamParser({ signal })
  drain(parser, [`${signal}<invoke name="a"><parameter name="p">1`])
  assert.equal(parser.hasOpenInvoke(), true)
})

test("callID gives a unique id each time", () => {
  const seen = new Set()
  for (let i = 0; i < 100; i++) seen.add(callID())
  assert.equal(seen.size, 100)
})

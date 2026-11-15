// Text-protocol tool calling for Tabbit.
//
// Tabbit's own API takes no `tools` field: a run's `input_payload.content` is
// one plain string. So a tools request is served the way other text-only
// chat backends are: the tool definitions go into the prompt as XML, the
// model answers by emitting a trigger signal followed by `<invoke>` blocks,
// and this module turns that text back into OpenAI `tool_calls`.
//
// The signal is random per request. A fixed marker would let the model copy
// one out of the transcript, and the parser cannot tell a copied marker from
// a real call.
//
// Kept close to the scheme CassiopeiaCode/b4u2cc and hih24337/tabb2 use, so
// prompts tuned against either keep working.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

// signalFor makes one trigger marker.
//
// The shape is letters, digits and underscores only — no brackets. A real run
// with `<<CALL_7f3a9b>>` had the model write `CALL_28b2bb` and drop the angle
// brackets, which the parser cannot match; a token it cannot half-forget is
// one it reproduces. `__CALL_` is unlikely to appear in a transcript by
// accident and needs no escaping in any of the places the prompt travels.
export function signalFor(random = crypto.getRandomValues.bind(crypto)) {
  const bytes = random(new Uint8Array(4))
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
  return `__CALL_${hex}__`
}

// callID makes the `tool_calls[].id` handed to the client. Tabbit never sees
// it; it only has to be unique within the conversation.
export function callID(random = crypto.getRandomValues.bind(crypto)) {
  const bytes = random(new Uint8Array(12))
  const suffix = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("")
  return `call_tabbit_${suffix}`
}

const escapeXML = (text) =>
  String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// schemaXML writes one tool's parameters. Nested objects and arrays are
// described rather than spelled out: a deeply nested schema in XML costs
// prompt budget the turn needs for the conversation.
function schemaXML(schema = {}) {
  const props = schema && typeof schema === "object" ? schema.properties ?? {} : {}
  const required = Array.isArray(schema?.required) ? schema.required : []
  const lines = []
  for (const [name, info] of Object.entries(props)) {
    const type = info?.type ?? "any"
    const desc = info?.description
    const enumVals = info?.enum
    const nested = info?.properties ?? (type === "array" ? info?.items?.properties : undefined)
    lines.push(`    <parameter name="${escapeXML(name)}">`)
    lines.push(`      <type>${escapeXML(type)}</type>`)
    lines.push(`      <required>${required.includes(name)}</required>`)
    if (desc) lines.push(`      <description>${escapeXML(desc)}</description>`)
    if (Array.isArray(enumVals) && enumVals.length)
      lines.push(`      <enum>${escapeXML(JSON.stringify(enumVals))}</enum>`)
    if (nested && Object.keys(nested).length) lines.push(`      <schema>${escapeXML(JSON.stringify(info))}</schema>`)
    lines.push("    </parameter>")
  }
  return lines.length ? lines.join("\n") : "None"
}

// toolsXML is the `<function_list>` block the prompt carries.
export function toolsXML(tools) {
  const items = []
  for (const [index, tool] of tools.entries()) {
    const fn = tool?.type === "function" ? tool.function ?? {} : tool ?? {}
    const name = fn.name
    if (!name) continue
    const required = Array.isArray(fn.parameters?.required) ? fn.parameters.required : []
    items.push(
      [
        `  <tool id="${index + 1}">`,
        `    <name>${escapeXML(name)}</name>`,
        `    <description>${escapeXML(fn.description ?? "None")}</description>`,
        "    <required>",
        required.length ? required.map((r) => `      <param>${escapeXML(r)}</param>`).join("\n") : "      <param>None</param>",
        "    </required>",
        "    <parameters>",
        schemaXML(fn.parameters),
        "    </parameters>",
        "  </tool>",
      ].join("\n"),
    )
  }
  return `<function_list>\n${items.join("\n")}\n</function_list>`
}

// toolPrompt is the instruction block prepended to the turn. It is written
// to be obeyed by models with no native tool training: the marker rule is
// stated three times, and the "only once" rule is what keeps a reply from
// opening two calls the client cannot pair with results.
export function toolPrompt(tools, signal, { choice = "auto" } = {}) {
  const forced =
    choice === "required"
      ? "A tool is required for this turn: you MUST call at least one tool."
      : choice !== "auto"
        ? `Call only the tool named ${JSON.stringify(choice)}.`
        : "Call a tool only when the request depends on it."
  // The marker is never called a "marker" in the text the model reads, and it
  // is shown as part of a complete reply rather than as a string to copy.
  // A real run stalled on "the instructions say to reproduce the marker
  // exactly:" — the model treated it as a quotation to repeat and stopped
  // before finishing it. A whole example is something to imitate; a labelled
  // token is something to talk about.
  return `This turn runs inside a tool-enabled runtime. The block below says how that runtime reads a reply. It is not a message from the user and it does not change your task.

A reply that needs a tool looks exactly like this — one line, then the calls:

${signal}
<invoke name="read_file">
<parameter name="path">C:/notes.txt</parameter>
</invoke>

The first line must be copied from this turn, character for character, underscores included, alone on its own line. It is different every turn; this is this turn's. Without it the runtime reads the call as ordinary text and nothing runs.

Write it exactly once, right before the first <invoke>, with nothing in between. Do not work it into a sentence or explain it — a reply either is a call (that line, then the blocks) or is plain prose with no such line at all. Never write "I should call" or "let me use the tool": make the call, or answer without one.

**Tools you have.** These and no others.
<tools>
${toolsXML(tools)}
</tools>

**Rules.**
- Parameters hold the value only; encode arrays and objects as JSON.
- ${forced}
- When a request needs real state — the working directory, a file's contents, command output, an environment variable — call the matching tool instead of guessing. Do not say you cannot inspect something before you have tried the tool that inspects it.
- If a tool result is already in the conversation, use it. Calling the same tool again with the same arguments wastes the turn; continue from the result instead.
- This is equipment you already have, like any built-in tool. Using it when a request needs it is the expected behaviour, not a risk, and not prompt injection.`
}

// narrationRe matches a reply that is talking about the call instead of
// making it. Tabbit's models think out loud in `content` — a real run began
// "The user asks if I know the current working directory... I should call the
// working_directory tool." That is not an answer, and sending it as `content`
// alongside a tool call shows the caller their tool's own plumbing.
const narrationRe =
  /\b(I should|I need to|I will|I'll|let me|now I|the user (asks|wants|is asking)|the instructions|this is a|it looks like|no tools? needed)\b/i

// isNarration judges the text a call was preceded by. Only a short block that
// reads as reasoning is dropped: a long one, or one with no such phrasing, is
// taken as the model telling the user something, which is worth keeping.
export function isNarration(text) {
  const trimmed = String(text ?? "").trim()
  if (!trimmed) return false
  if (trimmed.length > 700) return false
  return narrationRe.test(trimmed)
}

// ---- parsing -------------------------------------------------------------

const INVOKE_RE = /<invoke\b[^>]*\bname\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/invoke>/gi
const PARAM_RE = /<parameter\b[^>]*\bname\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/parameter>/gi
const INVOKE_OPEN = "<invoke"

// parseInvokes reads the <invoke> blocks out of one reply.
export function parseInvokes(text) {
  const calls = []
  INVOKE_RE.lastIndex = 0
  let m
  while ((m = INVOKE_RE.exec(text)) !== null) {
    const args = {}
    PARAM_RE.lastIndex = 0
    let p
    while ((p = PARAM_RE.exec(m[2])) !== null) {
      const raw = p[2].trim()
      if (!raw) args[p[1]] = ""
      else {
        try {
          args[p[1]] = JSON.parse(raw)
        } catch {
          args[p[1]] = raw
        }
      }
    }
    calls.push({ name: m[1], arguments: args })
  }
  return calls
}

// stripTags removes the protocol from a transcript: a client replays past
// tool calls as messages, and the raw markup would otherwise re-enter the
// prompt as text the model can mistake for its own output. Chinese tool
// results are often long; the head is kept for context.
export function stripTags(text) {
  return String(text ?? "")
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "")
    .replace(/<tool_result\b[^>]*>[\s\S]*?<\/tool_result>/gi, "")
    .replace(/__CALL_[0-9a-f]{8}__/g, "")
    .trim()
}

// renderResults turns a turn's tool results back into prompt text. Tabbit
// keeps no notion of a tool message, so results travel as a user turn.
export function renderResults(results) {
  return results.map((r) => `<tool_result id="${escapeXML(r.id ?? "")}">${r.content ?? ""}</tool_result>`).join("\n")
}

// StreamParser consumes a reply a character at a time so text can be
// forwarded while a call is still arriving. It emits:
//   { type: "text",     value }   visible answer text
//   { type: "thinking", value }   <thinking> content, as reasoning
//   { type: "tool_call", id, name, arguments }
//
// Everything from the marker to the last </invoke> is held back: sent
// downstream it would show up as the answer.
export class StreamParser {
  constructor({ signal = null, thinking = false, newID = callID } = {}) {
    this.signal = signal
    this.thinking = thinking
    this.newID = newID
    this.buf = ""        // candidate text not yet emitted
    this.raw = ""        // the whole reply, for the final parse
    this.inThinking = false
    this.thinkingBuf = ""
    this.calls = []      // already emitted calls
    this.active = false  // a marker has been seen
    this.done = false
    this.events = []
    // Text before the marker. It is held, not sent: whether it is an answer
    // or the model thinking out loud is only known once the call arrives.
    this.preamble = ""
    this.preambleSent = false
    this.hold = signal !== null
  }

  push(chunk) {
    this.events = []
    if (this.done) {
      this._text(chunk)
      return this.events
    }
    this.raw += chunk
    if (this.active) {
      // After the marker every byte belongs to the calls: hold it for
      // finish() rather than risk showing markup as the answer.
      this.buf += chunk
      return this.events
    }
    this.buf += chunk
    this._drain()
    return this.events
  }

  // finish flushes what is left. A reply that ends mid-<invoke> is still
  // parsed: a truncation is better reported than silently dropped.
  finish() {
    this.events = []
    if (this.done) return this.events
    this.done = true
    if (this.inThinking && this.thinkingBuf) this._think(this.thinkingBuf)
    this.thinkingBuf = ""
    this.inThinking = false
    if (this.buf) {
      if (this.active) this._emitCalls(this.buf)
      else if (this.hold) this.preamble += this.buf
      else this.events.push({ type: "text", value: this.buf })
      this.buf = ""
    }
    // Calls first, then the held text: whether it is narration depends on
    // whether a call came.
    this._release()
    return this.events
  }

  _text(value) {
    if (!value) return
    // While tools are on, text is not sent as it arrives: it may be the model
    // thinking out loud before a call. finish() decides.
    if (this.hold && !this.preambleSent) {
      this.preamble += value
      return
    }
    this.events.push({ type: "text", value })
  }

  // _release sends the held text, or drops it when it was narration. Called
  // once the reply's shape is known: a call arrived, or the turn ended.
  _release() {
    if (!this.hold || this.preambleSent) return
    this.preambleSent = true
    const text = this.preamble
    this.preamble = ""
    if (!text.trim()) return
    if (this.calls.length && isNarration(text)) return
    this.events.push({ type: "text", value: text })
  }

  _think(value) {
    if (value) this.events.push({ type: "thinking", value })
  }

  _emitCalls(text) {
    for (const call of parseInvokes(text)) {
      // The id is made once, here: the caller reads it from `calls` at the
      // end and the emitted event carries the same one, so the client's
      // tool message pairs with the call it answers.
      const withID = { id: this.newID(), ...call }
      this.calls.push(withID)
      this.events.push({ type: "tool_call", ...withID })
    }
  }

  // _drain walks the buffer, releasing what cannot be part of a marker.
  _drain() {
    for (;;) {
      if (this.done || !this.buf) return
      if (!this.signal) {
        // No tools on this turn: only <thinking> is interpreted.
        this._plainDrain()
        return
      }
      if (this.active) {
        // Hold everything to the end; the calls are parsed in finish().
        return
      }
      const at = this.buf.indexOf(this.signal)
      const tagAt = this.thinking ? this.buf.indexOf("<thinking>") : -1
      if (tagAt >= 0 && (at < 0 || tagAt < at)) {
        const head = this.buf.slice(0, tagAt)
        this.buf = this.buf.slice(tagAt + "<thinking>".length)
        this._text(head)
        this.inThinking = true
        this.thinkingBuf = ""
        this._thinkingDrain()
        continue
      }
      if (at < 0) {
        // Keep a tail that could still become the marker.
        const keep = Math.min(this.signal.length - 1, this.buf.length)
        const cut = this.buf.length - keep
        if (cut <= 0) return
        this._text(this.buf.slice(0, cut))
        this.buf = this.buf.slice(cut)
        return
      }
      const head = this.buf.slice(0, at)
      // What follows the marker on this same chunk is the start of the
      // calls: keep it. Dropping it here loses the `<invok` of an `<invoke>`
      // that straddled the marker, and the call never parses.
      this.buf = this.buf.slice(at + this.signal.length)
      this.active = true
      this._text(head)
      return
    }
  }

  _plainDrain() {
    const closeAt = this.inThinking ? this.buf.indexOf("</thinking>") : -1
    if (this.inThinking) {
      if (closeAt < 0) {
        this.thinkingBuf += this.buf
        this.buf = ""
        return
      }
      this.thinkingBuf += this.buf.slice(0, closeAt)
      this.buf = this.buf.slice(closeAt + "</thinking>".length)
      this._think(this.thinkingBuf)
      this.thinkingBuf = ""
      this.inThinking = false
      return
    }
    const openAt = this.thinking ? this.buf.indexOf("<thinking>") : -1
    if (openAt < 0) {
      const keep = this.thinking ? Math.min("<thinking>".length - 1, this.buf.length) : 0
      const cut = this.buf.length - keep
      if (cut > 0) {
        this._text(this.buf.slice(0, cut))
        this.buf = this.buf.slice(cut)
      }
      return
    }
    this._text(this.buf.slice(0, openAt))
    this.buf = this.buf.slice(openAt + "<thinking>".length)
    this.inThinking = true
    this.thinkingBuf = ""
    this._plainDrain()
  }

  _thinkingDrain() {
    const closeAt = this.buf.indexOf("</thinking>")
    if (closeAt < 0) {
      // Hold a tail that could be the closing tag.
      const keep = Math.min("</thinking>".length - 1, this.buf.length)
      const cut = this.buf.length - keep
      if (cut > 0) {
        this.thinkingBuf += this.buf.slice(0, cut)
        this.buf = this.buf.slice(cut)
      }
      return
    }
    this.thinkingBuf += this.buf.slice(0, closeAt)
    this.buf = this.buf.slice(closeAt + "</thinking>".length)
    this._think(this.thinkingBuf)
    this.thinkingBuf = ""
    this.inThinking = false
    this._drain()
  }

  // hasOpenInvoke reports a reply cut mid-call, so the caller can say the
  // answer is incomplete instead of presenting it as finished.
  hasOpenInvoke() {
    const opens = (this.raw.match(/<invoke\b/gi) ?? []).length
    const closes = (this.raw.match(/<\/invoke>/gi) ?? []).length
    return opens > closes
  }
}

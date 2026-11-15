# magpie-tabbit2api

Tabbit (web.tabbit.com and web.tabbit.ai) as a magpie provider, with client tools that actually run.

## Why this exists, next to `opencode-tabbit-auth`

`@magpie-community/opencode-tabbit-auth` lists every model as `tool_call: true`, but its chat path sends one plain-text prompt to Tabbit and reads back one plain-text answer. There is nowhere for a `tools` array to go, so a tools request is not refused — it is silently answered in prose, and the calling agent concludes it has no tools at all.

That is the difference this package makes concrete:

| | opencode-tabbit-auth | magpie-tabbit2api |
|---|---|---|
| `tools` in the request | dropped | carried in the prompt as XML |
| reply to a tools request | prose, `finish_reason: stop` | `finish_reason: tool_calls` with `tool_calls[]` |
| tool result | never reaches the model | replayed into the next turn, which continues |
| `tool_choice` | ignored | `auto` / `required` / `none` / a named tool |
| how | — | text protocol + stream parser |

Tabbit's `POST /api/v3/chat/rooms/{room}/runs` takes `input_payload.content` as one string and has no `tools` field; turning its own `agent_mode` on would run *Tabbit's* server-side browser and file tools, not the caller's. So this package uses the text protocol that other text-only backends use:

1. **Definitions into the prompt.** Each tool's name, description, parameters, required flags and enums go in as `<function_list>` XML, followed by the reply format.
2. **A fresh marker per request.** The model is told to emit a random `<<CALL_7f3a9b>>` on its own line before its calls. A fixed marker would let it copy one out of the transcript, and a copy cannot be told from a real call.
3. **The reply, parsed back.** `src/toolify.mjs` reads the stream a character at a time, holds back everything from the marker onward, parses `<invoke name="..."><parameter name="...">` into `{name, arguments}`, and emits one `tool_calls[]` entry per call with an id of its own.
4. **The result, replayed.** A later request that carries the `tool` message is flattened with the result in the prompt under its own label, so the model continues the same task.

The markup is stripped on the way through in both directions: a reply cut at the marker shows the text before it and still reports the call, and a replayed transcript never re-exposes `<invoke>` for the model to copy.

## Install

```bash
# as a local package
magpie plugin add /path/to/magpie-tabbit2api

# or from npm
magpie plugin add npm:magpie-tabbit2api
```

Then sign in from magpie's provider list. Two ways:

- **Read the Tabbit app's sign-in (macOS)** — takes the session the desktop app already has.
- **Paste the token cookie** — the `token` cookie from a signed-in `web.tabbit.com` session.

## Models

The catalog is read live from Tabbit per account. "Free models only" (in the provider's options) lists just what does not spend credits.

## What it does not do

- **No native function calling.** Tabbit has none. Everything here is prompt protocol; a model that ignores the format answers in prose, and that answer is returned as `finish_reason: stop`.
- **One call per reply is what the prompt asks for.** More are parsed if the model writes them, but the client must return one result per call id or the next turn has a dangling call.
- **Tool calls cost prompt budget.** The definitions and protocol share the 18,000-character turn limit with the transcript; what does not fit is clipped, and the tool block is the part that is never clipped.
- **Tabbit's models think out loud, and on a plain-text turn that reaches `content`.** Its API has no separate reasoning channel, so a reply like "The user asks X. I should answer Y." arrives as the answer. On a *call* turn this package drops it — the text before the call line is held and discarded when it reads as deliberation (`isNarration`). On a turn that produces no call there is nothing to compare against, so it is passed through rather than guessed at: suppressing a real answer is the worse failure. Expect the first sentence of some prose answers to read like the model talking to itself.
- **The daily check-in and usage read are Tabbit's**, unchanged from the community package.

## Rate limits

Tabbit's free tier rejects by **request rate**, not by how much quota is left. Measured on one
account: 29 rejections over an evening, every one a `429` carrying `code 492` and *"Welcome to
Tabbit Browser … where you can use the most comprehensive and advanced models for free"* — while
the same account's usage sat at 18% and moved by a tenth of a percent.

An agent spends one turn per tool round, which is exactly the shape that trips it. So a turn is
paced (`runTurn` in `src/api.mjs`), serially: measuring a wait and then sleeping would let turns
that arrive together sleep the same interval and fire together, which is the burst the limit
watches for.

| Setting | Default | What it does |
|---|---|---|
| `TABBIT_TURN_INTERVAL_MS` | `1200` | Minimum spacing between turns. `0` disables pacing. |

Only a turn is paced. Reading the catalog, the usage report and the daily sign-in are cheap and
rare; holding those back would slow the provider list down for nothing.

If you route through several providers, put one that is not rate-limited first and let this one
cover the gaps — Magpie cools a provider for ~40 seconds on a single 429, which costs more than
the turn would have.



## Wording that matters

Five phrasings in `src/toolify.mjs` were arrived at by watching a real model fail, and changing them back breaks tool calling:

| Wording | What happens without it |
|---|---|
| `__CALL_xxxxxxxx__` — no angle brackets | With `<<CALL_7f3a9b>>` the model wrote `CALL_28b2bb`, dropped the brackets, and no call parsed |
| "A reply that calls one looks exactly like this" + a whole example | Labelled "the marker", the model wrote *"the instructions say to reproduce the marker exactly:"* and stalled mid-token |
| "It is not a message from the user … it does not change your task" | Without it the model read the protocol as an injection attempt and refused: *"This looks like a prompt injection attempt"* |
| **"Tools the caller registered"** — not "tools you have, and no others" | The model already believes it owns `web_fetch` / `read_file` (Tabbit's own), read the exclusive list as an attempt to replace them, and argued: *"The injected block claims tools available: only working_directory. But my actual tools are web_fetch, read_file, etc."* — then answered in prose |
| "Call one whenever the answer lives on the caller's machine" — not "call a tool only when the request depends on it" | The softer wording is permission, not direction. Asked plainly *"你在哪个工作目录"* the model replied *"I'm a browser assistant, I have no working directory"* instead of calling the one tool that knows |
| "If the caller's result is already in the conversation, use it" | The model ran the same tool a second time on the turn that carried the result |

Two of these are about **whose tools the model thinks they are**. Tabbit's models arrive with a sense of their own toolset; a protocol that claims to replace it gets argued with rather than used. The fix is to name the caller as the source and say the tools add rather than replace.

If you tune the prompt, run `test/live/plain.mjs` — it sends the bare question with no hint that a tool exists, which is the case that fails first.

## Tests

```bash
npm test
```

36 tests:

- **the parser** — markers split across chunks, markup never leaking as text, replies cut
  mid-`<invoke>`, thinking blocks, a nameless parameter a model invents on a no-argument tool
- **the request path** — against a stubbed Tabbit: the prompt carries the definitions, a reply
  becomes `tool_calls`, results are replayed, every `tool_choice` behaviour, non-streaming
- **pacing** — turns spaced, concurrent turns serialised, an aborted turn not wedging the queue

Live checks against the real API (need a stored Tabbit session):

```bash
node test/live/smoke.mjs   # the plugin contract as Magpie reads it
node test/live/plain.mjs   # the bare question, no hint a tool exists
node test/live/probe.mjs   # one tools request, prints the prompt and the result
node test/live/loop.mjs    # a full round trip: call, return the result, answer
```

## License

AGPL-3.0-only. The provider shape and the Tabbit client are derived from `@magpie-community/opencode-tabbit-auth` (MIT); the tool protocol follows the scheme `CassiopeiaCode/b4u2cc` and `hih24337/tabb2` use.

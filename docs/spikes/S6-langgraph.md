# Spike S6: LangGraph (TS) with Claude

*Run 12 October 2026 (overnight) · Node v24.15.0 · `@langchain/langgraph` 1.4.18, `@langchain/anthropic` 1.5.11, `@langchain/core` 1.2.13, `zod` 4.6.5 (exact pins, each at least two weeks old) · Code: `spikes/S6-langgraph/` (git-ignored) · **Status: mechanics pass; the live Claude run is waiting for an API key***

## Question

Do `@langchain/langgraph` and `@langchain/anthropic` on `claude-sonnet-5-5` handle tool calls, a human-confirmation interrupt before writes, and keeping tokens out of model input?

## Answer

**Yes for the graph mechanics, untested against live Claude.** No `ANTHROPIC_API_KEY` is set on this machine (HUMAN-TODO), so the spike drives the graph with a scripted chat model that emits real `tool_calls`. `ChatAnthropic` with `model: "claude-sonnet-5-5"` constructs and binds both tools, but it wasn't called.

## Evidence

A two-tool graph (`get_fixtures` reads, `submit_tip` writes), using `StateGraph(MessagesAnnotation)`, a `MemorySaver` checkpointer and `interrupt()` before the write:

```
$ node spike.ts
interrupt before write: {"question":"Allow submit_tip {\"fixture_id\":\"r27-1\",\"team\":\"Storm\"}?"}
calls so far: [ 'GET /api/fixtures with secret…' ]
final: Done: tipped the Storm.
calls: [ 'GET /api/fixtures with secret…', 'POST /api/me/tips r27-1 Storm' ]
secret in any model input: false
ChatAnthropic + bindTools constructed: true
```

- The graph stops at the write and returns the question in `__interrupt__`. Nothing is POSTed until `new Command({ resume: "yes" })`.
- The tools close over the Session Token, so only API results reach the model. The scripted model records every input, and none contains the secret.

## Findings for the build

| # | Finding | Applied to |
|---|---|---|
| F1 | **On resume, LangGraph re-runs the whole node that called `interrupt()`.** If one node runs a read tool and then interrupts for a write, the read runs twice. So the confirmation goes in its own `confirm` node, *before* the node that executes tools. | Task 12 graph design |
| F2 | Writes are identified by the HTTP method (`POST`, `PUT`, `PATCH`, `DELETE`) of the `poppy_call` tool, not by tool name, because v1 has one generic tool. | Task 12 |
| F3 | The tool should return `{status, body}` or `{status, error}` as JSON text, and the graph should label API content as untrusted data in the system prompt (T-15). | Task 12 |

## Still to do (Tim)

- Create the Anthropic API key with a spend limit (HUMAN-TODO), then run `npm run chat` (Task 12) for the live check in HowToVerify M6.
- Approve LangGraph, or switch to the Claude Agent SDK fallback (HUMAN-TODO "Spike S6 review").

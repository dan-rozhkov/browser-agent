# Examples

`run-task.ts` runs one browse task end to end: local Chromium (or an existing
browser via CDP), System One decisions, and two OpenRouter text models built with
`aiSdkTextModel(createOpenAICompatible(...)(id))` (structured outputs on, non-strict
`json_schema` via `providerOptions.openrouter.strictJsonSchema = false`; `@ai-sdk/openai-compatible` is a dev dependency).

```bash
TYPESAFE_API_KEY=... OPENROUTER_API_KEY=... \
  npm run example -- "open example.com and read the main heading"
```

| Variable | Meaning |
|---|---|
| `TYPESAFE_API_KEY` | required, System One, unless `TYPESAFE_MODEL` is an `openai/...` id (then `OPENROUTER_API_KEY` is enough) |
| `OPENROUTER_API_KEY` | required, text models (and Luna decisions) |
| `TYPESAFE_MODEL` | decision model, default `jev-latest` |
| `STRUCTURED_MODEL`, `CASCADE_MODEL` | OpenRouter ids, default `google/gemini-2.5-flash` |
| `CDP_URL` | attach to a running browser instead of launching one (counts as a remote browser: `cloud: true`, longer deadlines) |
| `HEADLESS=0` | show the launched browser |

The example prints the `Transcript` as JSON and closes the browser. It needs
network access and real API keys. `npm run lint` type-checks it.

## run-agent.ts

`run-agent.ts` runs the fast browse agent (`runBrowseAgent` from
`@sideform/browser-agent/agent/ai-sdk`): one non-reasoning chat model drives the
seven `browse_*` tools through the AI SDK. It uses local Chromium (or `CDP_URL`)
and `deepseek/deepseek-v4.1-flash` on OpenRouter with reasoning switched off in
`providerOptions`.

```bash
OPENROUTER_API_KEY=... START_URL=https://example.com \
  npx tsx examples/run-agent.ts "read the main heading"
```

`@ai-sdk/openai-compatible` prints tool-result images as JSON text, so the
screenshot result stays text only here (the default). Pass
`toolResultImages: true` only with a provider that carries them natively.

| Variable | Meaning |
|---|---|
| `OPENROUTER_API_KEY` | required |
| `AGENT_MODEL` | OpenRouter model id, default `deepseek/deepseek-v4.1-flash` |
| `START_URL` | the browser opens it before the first request |
| `CDP_URL` | attach to a running browser instead of launching one |
| `HEADLESS=0` | show the launched browser |

It prints the run result (`status`, `answer`, `steps`) as JSON. It needs network
access and a real key. `npm run lint` type-checks it.

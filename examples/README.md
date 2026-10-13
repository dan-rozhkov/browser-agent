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

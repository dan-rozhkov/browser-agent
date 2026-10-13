# Examples

`run-task.ts` runs one browse task end to end: local Chromium (or an existing
browser via CDP), System One decisions, and two OpenRouter text models written
as a small `TextModel` over `fetch` (no extra dependency).

```bash
TYPESAFE_API_KEY=... OPENROUTER_API_KEY=... \
  npm run example -- "open example.com and read the main heading"
```

| Variable | Meaning |
|---|---|
| `TYPESAFE_API_KEY` | required, System One |
| `OPENROUTER_API_KEY` | required, text models (and Luna decisions) |
| `TYPESAFE_MODEL` | decision model, default `jev-latest` |
| `STRUCTURED_MODEL`, `CASCADE_MODEL` | OpenRouter ids, default `google/gemini-2.5-flash` |
| `CDP_URL` | attach to a running browser instead of launching one |
| `HEADLESS=0` | show the launched browser |

The example prints the `Transcript` as JSON and closes the browser. It needs
network access and real API keys. `npm run lint` type-checks it.

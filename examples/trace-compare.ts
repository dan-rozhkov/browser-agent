// Compare our run trace (createBrowseTraceRecorder, via runBrowseAgent({ trace })) with
// Playwright's own trace (context.tracing) on REAL public websites. No LLM key: a scripted
// MockLanguageModelV3 plays a fixed list of tool calls through the real agent code.
//   npx tsx examples/trace-compare.ts [--out <dir>] [--only <name,...>] [--repeat N]
//
// Per scenario it runs four modes in fresh browser contexts, one after another:
//   none (no tracing), ours (our trace), pw (Playwright tracing), both.
// The comparison (completeness, recall, size, overhead) comes from the `both` run.
// Output: <out>/results.json, <out>/summary.md, <out>/<name>/ours/{trace.json,frames/*}, <out>/<name>/pw-trace.zip.
// Needs network access and a Playwright Chromium install.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { chromium } from "playwright-core";
import { runBrowseAgent } from "../src/agent/aiSdk.js";
import { PlaywrightTarget } from "../src/adapters/playwright.js";
import { controllerBridge } from "../src/adapters/controllerBridge.js";
import { BrowserController } from "../src/controller/index.js";
import { parseBrowseTrace, splitTraceAssets, type BrowseTrace } from "../src/shared/trace.js";

// ---------------------------------------------------------------- scripted model

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
};

interface Call {
  name: string;
  input: unknown;
}
type Step = { text?: string; calls?: Call[] };

/** A model that plays the given steps in order; the last step repeats. */
function scripted(steps: Step[]): MockLanguageModelV3 {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const step = steps[Math.min(i, steps.length - 1)]!;
      i += 1;
      const content: unknown[] = [];
      if (step.text) content.push({ type: "text", text: step.text });
      for (const [k, c] of (step.calls ?? []).entries()) {
        content.push({ type: "tool-call", toolCallId: `c${i}-${k}`, toolName: c.name, input: JSON.stringify(c.input) });
      }
      return {
        finishReason: step.calls?.length ? { unified: "tool-calls" as const, raw: "tool_calls" } : { unified: "stop" as const, raw: "stop" },
        usage,
        warnings: [] as never[],
        content,
      } as never;
    },
  });
}

const act = (input: Record<string, unknown>): Step => ({ calls: [{ name: "browse_act", input }] });
const tool = (name: string, input: Record<string, unknown> = {}): Step => ({ calls: [{ name, input }] });
const verdict = (reason: string): Step[] => [tool("qa_verdict", { verdict: "pass", reason }), { text: "done" }];

// ---------------------------------------------------------------- scenarios

interface Scenario {
  name: string;
  url: string;
  steps: Step[];
  /** A text that must not appear in any trace. */
  secret?: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: "example",
    url: "https://example.com",
    steps: [act({ action: "click", target: "Learn more" }), tool("browse_screenshot"), ...verdict("example.com link opened")],
  },
  {
    name: "wikipedia",
    url: "https://en.wikipedia.org/wiki/Main_Page",
    steps: [
      act({ action: "type", target: "input[name=search]", text: "Playwright" }),
      act({ action: "press", key: "Enter" }),
      tool("browse_read", { maxChars: 2000 }),
      ...verdict("search results read"),
    ],
  },
  {
    name: "hackernews",
    url: "https://news.ycombinator.com",
    steps: [
      act({ action: "click", target: "new" }),
      act({ action: "scroll", amount: 1 }),
      act({ action: "back" }),
      ...verdict("hacker news navigated"),
    ],
  },
  {
    name: "todomvc",
    url: "https://demo.playwright.dev/todomvc",
    steps: [
      act({
        actions: [
          { action: "type", target: ".new-todo", text: "buy milk" },
          { action: "press", key: "Enter" },
        ],
      }),
      act({ action: "type", target: ".new-todo", text: "walk dog" }),
      act({ action: "press", key: "Enter" }),
      act({ action: "click", target: ".toggle" }),
      act({ action: "click", target: "Completed" }),
      ...verdict("todos added and filtered"),
    ],
  },
  {
    name: "the-internet-errors",
    url: "https://the-internet.herokuapp.com/javascript_error",
    steps: [
      tool("browse_open", { url: "https://the-internet.herokuapp.com/status_codes" }),
      act({ action: "click", target: "404" }),
      tool("browse_open", { url: "https://the-internet.herokuapp.com/javascript_alerts" }),
      act({ action: "click", target: "Click for JS Alert" }),
      ...verdict("errors and dialog exercised"),
    ],
  },
  {
    name: "quotes-login",
    url: "https://quotes.toscrape.com/login",
    secret: "hunter2-secret",
    steps: [
      act({ action: "type", target: "#username", text: "alice" }),
      act({ action: "type", target: "#password", text: "hunter2-secret" }),
      act({ action: "click", target: "Login" }),
      ...verdict("login submitted"),
    ],
  },
  {
    name: "books",
    url: "https://books.toscrape.com",
    steps: [
      act({ action: "click", target: "Travel" }),
      act({ action: "click", target: ".product_pod h3 a" }),
      act({ action: "back" }),
      ...verdict("category and book opened"),
    ],
  },
  {
    name: "github",
    url: "https://github.com/microsoft/playwright",
    steps: [act({ action: "click", target: "Issues" }), tool("browse_read", { maxChars: 2000 }), ...verdict("issues tab read")],
  },
];

// ---------------------------------------------------------------- one run

type Mode = "none" | "ours" | "pw" | "both";
const MODES: Mode[] = ["none", "ours", "pw", "both"];
const SCENARIO_TIMEOUT_MS = 120_000;

interface RunOutcome {
  ms: number;
  status: string;
  trace?: BrowseTrace;
  zipPath?: string;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${what}: timeout after ${ms} ms`));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function runOnce(scenario: Scenario, mode: Mode, zipPath: string): Promise<RunOutcome> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const withPw = mode === "pw" || mode === "both";
    const withOurs = mode === "ours" || mode === "both";
    if (withPw) await context.tracing.start({ screenshots: true, snapshots: true });
    const controller = new BrowserController(new PlaywrightTarget(context));
    let trace: BrowseTrace | undefined;
    const started = Date.now();
    let status = "error";
    let ms = 0;
    // On the scenario timeout the run is aborted, so it cannot go on in the background and touch the next scenario's numbers.
    const abort = new AbortController();
    try {
      const result = await withTimeout(
        runBrowseAgent(`trace-compare ${scenario.name}`, {
          model: scripted(scenario.steps),
          browser: controllerBridge(controller),
          url: scenario.url,
          qa: true,
          signal: abort.signal,
          ...(withOurs
            ? {
                trace: {
                  labels: { harness: "trace-compare", scenario: scenario.name, mode },
                  onTrace: (t: BrowseTrace) => {
                    trace = t;
                  },
                },
              }
            : {}),
        }),
        SCENARIO_TIMEOUT_MS,
        `${scenario.name}/${mode}`,
        () => abort.abort(),
      );
      status = result.status;
    } finally {
      ms = Date.now() - started;
      if (withPw) {
        mkdirSync(dirname(zipPath), { recursive: true });
        await context.tracing.stop({ path: zipPath }).catch((e: unknown) => console.error("tracing.stop failed", e));
      }
    }
    return { ms, status, trace, zipPath: withPw ? zipPath : undefined };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- Playwright trace analysis

type Json = Record<string, unknown>;

function listFiles(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, base))) {
    const rel = base ? `${base}/${name}` : name;
    if (statSync(join(dir, rel)).isDirectory()) out.push(...listFiles(dir, rel));
    else out.push(rel);
  }
  return out;
}

function ndjson(file: string): Json[] {
  const rows: Json[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Json);
    } catch {
      /* a partial line */
    }
  }
  return rows;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});

interface PwStats {
  zipBytes: number;
  actions: number;
  apiCalls: number;
  screencastFrames: number;
  domSnapshots: number;
  consoleTotal: number;
  consoleErrors: number;
  pageErrors: number;
  networkRequests: number;
  failedRequests: number;
  errorTexts: string[];
  failedList: { method: string; url: string; status: number; failure: string }[];
  fileCount: number;
  unzipDir: string;
}

function analysePw(zipPath: string, scratch: string): PwStats {
  const dir = mkdtempSync(join(scratch, "pw-unzip-"));
  execFileSync("unzip", ["-q", "-o", zipPath, "-d", dir]);
  const files = listFiles(dir);
  const traceRows = files.filter((f) => f.endsWith(".trace")).flatMap((f) => ndjson(join(dir, f)));
  const netRows = files.filter((f) => f.endsWith(".network")).flatMap((f) => ndjson(join(dir, f)));
  const stats: PwStats = {
    zipBytes: statSync(zipPath).size,
    actions: 0,
    apiCalls: 0,
    screencastFrames: 0,
    domSnapshots: 0,
    consoleTotal: 0,
    consoleErrors: 0,
    pageErrors: 0,
    networkRequests: 0,
    failedRequests: 0,
    errorTexts: [],
    failedList: [],
    fileCount: files.length,
    unzipDir: dir,
  };
  for (const row of traceRows) {
    const type = str(row.type);
    if (type === "before") {
      stats.actions += 1;
      // Context bookkeeping (newPage, tracing) is not a user-visible API call.
      if (!["BrowserContext", "Tracing"].includes(str(row.class))) stats.apiCalls += 1;
    } else if (type === "screencast-frame") stats.screencastFrames += 1;
    else if (type === "frame-snapshot") stats.domSnapshots += 1;
    else if (type === "console") {
      stats.consoleTotal += 1;
      if (str(row.messageType) === "error") {
        stats.consoleErrors += 1;
        stats.errorTexts.push(str(row.text));
      }
    } else if (type === "event" && str(row.method) === "pageError") {
      stats.pageErrors += 1;
      const e = rec(rec(rec(row.params).error).error);
      stats.errorTexts.push(str(e.message) || JSON.stringify(rec(row.params).error));
    }
  }
  for (const row of netRows) {
    if (str(row.type) !== "resource-snapshot") continue;
    const snap = rec(row.snapshot);
    const req = rec(snap.request);
    const res = rec(snap.response);
    stats.networkRequests += 1;
    const status = typeof res.status === "number" ? res.status : 0;
    const failure = str(res._failureText) || str(snap._failureText);
    // status 0 / -1 with no failure text is a request still pending when tracing stopped, not a failure.
    if (status >= 400 || failure) {
      stats.failedRequests += 1;
      stats.failedList.push({ method: str(req.method), url: str(req.url), status, failure });
    }
  }
  return stats;
}

/** True when any file in the unzipped trace contains `needle` (text or binary). */
function dirContains(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const buf = Buffer.from(needle);
  for (const f of listFiles(dir)) {
    if (readFileSync(join(dir, f)).includes(buf)) hits.push(f);
  }
  return hits;
}

// ---------------------------------------------------------------- our trace analysis

const trim200 = (s: string): string => s.trim().slice(0, 200);
const matchEither = (a: string, b: string): boolean => {
  const x = trim200(a);
  const y = trim200(b);
  return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x));
};

function urlParts(url: string): { path: string } {
  try {
    const u = new URL(url);
    return { path: u.pathname };
  } catch {
    return { path: url };
  }
}

function analyseOurs(trace: BrowseTrace, outDir: string) {
  const { manifest, assets } = splitTraceAssets(trace);
  mkdirSync(join(outDir, "frames"), { recursive: true });
  let assetBytes = 0;
  for (const a of assets) {
    const bytes = Buffer.from(a.dataUrl.slice(a.dataUrl.indexOf(",") + 1), "base64");
    assetBytes += bytes.length;
    writeFileSync(join(outDir, a.path), bytes);
  }
  const manifestJson = JSON.stringify(manifest, null, 2);
  writeFileSync(join(outDir, "trace.json"), manifestJson);
  const parsed = parseBrowseTrace(JSON.parse(manifestJson));
  const frameKinds: Record<string, number> = {};
  for (const f of trace.frames) frameKinds[f.kind] = (frameKinds[f.kind] ?? 0) + 1;
  return {
    steps: trace.steps.length,
    frames: trace.frames.length,
    frameKinds,
    consoleEntries: trace.console.length,
    networkEntries: trace.network.length,
    dropped: trace.dropped ?? {},
    qaPresent: trace.qa !== undefined,
    qaOutcome: trace.qa?.outcome,
    status: trace.status,
    manifestBytes: Buffer.byteLength(manifestJson),
    assetBytes,
    parseOk: "trace" in parsed,
    parseError: "error" in parsed ? parsed.error : undefined,
    stepList: trace.steps.map((s) => ({ index: s.index, tool: s.tool, ms: s.endedAt - s.startedAt, ok: s.ok, error: s.error })),
    json: manifestJson,
  };
}

// ---------------------------------------------------------------- scenario driver

const median = (xs: number[]): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

interface ScenarioResult {
  name: string;
  error?: string;
  timingsMs?: Record<Mode, number[]>;
  medianMs?: Record<Mode, number>;
  statuses?: Record<Mode, string[]>;
  ours?: Omit<ReturnType<typeof analyseOurs>, "json">;
  pw?: Omit<PwStats, "unzipDir">;
  recall?: {
    errorsRaw: number;
    errorsTotal: number;
    errorsFound: number;
    errorMisses: string[];
    failedRaw: number;
    failedTotal: number;
    failedFound: number;
    failedMisses: string[];
  };
  secret?: { text: string; inOursTrace: boolean; inPwTrace: boolean; pwFiles: string[] };
  stepMsMedian?: { ours?: number; both?: number };
}

async function runScenario(scenario: Scenario, outRoot: string, repeat: number, scratch: string): Promise<ScenarioResult> {
  const result: ScenarioResult = { name: scenario.name };
  const dir = join(outRoot, scenario.name);
  mkdirSync(dir, { recursive: true });
  const timings: Record<Mode, number[]> = { none: [], ours: [], pw: [], both: [] };
  const statuses: Record<Mode, string[]> = { none: [], ours: [], pw: [], both: [] };
  const bothStepMs: number[] = [];
  const oursStepMs: number[] = [];
  let bothTrace: BrowseTrace | undefined;
  let zip: string | undefined;
  const errors: string[] = [];
  for (let r = 0; r < repeat; r += 1) {
    // The order rotates per repeat, so no mode always pays the cold-cache cost of running first.
    for (const mode of [...MODES.slice(r % MODES.length), ...MODES.slice(0, r % MODES.length)]) {
      const zipPath = r === 0 && mode === "both" ? join(dir, "pw-trace.zip") : join(scratch, `${scenario.name}-${mode}-${r}.zip`);
      try {
        const out = await runOnce(scenario, mode, zipPath);
        timings[mode].push(out.ms);
        statuses[mode].push(out.status);
        console.log(`  ${scenario.name} ${mode}#${r}: ${out.ms} ms, status ${out.status}${out.trace ? `, ${out.trace.steps.length} steps` : ""}`);
        if (out.trace) {
          for (const s of out.trace.steps) if (!s.ok) console.log(`    step ${s.index} ${s.tool} FAILED: ${s.error}`);
          const ms = out.trace.steps.map((s) => s.endedAt - s.startedAt);
          (mode === "both" ? bothStepMs : oursStepMs).push(...ms);
        }
        if (mode === "both" && r === 0) {
          bothTrace = out.trace;
          zip = out.zipPath;
        }
      } catch (e) {
        const msg = `${mode}#${r}: ${e instanceof Error ? e.message : String(e)}`;
        console.error(`  ${scenario.name} ${msg}`);
        errors.push(msg);
      }
    }
  }
  result.timingsMs = timings;
  result.statuses = statuses;
  result.medianMs = { none: median(timings.none), ours: median(timings.ours), pw: median(timings.pw), both: median(timings.both) };
  result.stepMsMedian = { ours: median(oursStepMs), both: median(bothStepMs) };
  if (errors.length) result.error = errors.join("; ");

  if (bothTrace && zip) {
    const ours = analyseOurs(bothTrace, join(dir, "ours"));
    const pw = analysePw(zip, scratch);
    const { json, ...oursOut } = ours;
    result.ours = oursOut;
    const { unzipDir, ...pwOut } = pw;
    result.pw = pwOut;

    const oursConsole = bothTrace.console.map((c) => c.text);
    // Our lists are deduped (SeenList), so PW's are deduped too: by trimmed text, and by method + path.
    const uniqueErrors = [...new Set(pw.errorTexts.map(trim200))];
    const errorMisses = uniqueErrors.filter((t) => !oursConsole.some((o) => matchEither(t, o)));
    const failedMisses: string[] = [];
    const seenFailed = new Set<string>();
    const uniqueFailed = pw.failedList.filter((f) => {
      const key = `${f.method} ${urlParts(f.url).path}`;
      if (seenFailed.has(key)) return false;
      seenFailed.add(key);
      return true;
    });
    for (const f of uniqueFailed) {
      const { path } = urlParts(f.url);
      const hit = bothTrace.network.some((n) => n.text.trim().startsWith(f.method) && n.text.includes(path));
      if (!hit) failedMisses.push(`${f.method} ${f.status}${f.failure ? ` (${f.failure})` : ""} ${f.url}`);
    }
    result.recall = {
      errorsRaw: pw.errorTexts.length,
      errorsTotal: uniqueErrors.length,
      errorsFound: uniqueErrors.length - errorMisses.length,
      errorMisses,
      failedRaw: pw.failedList.length,
      failedTotal: uniqueFailed.length,
      failedFound: uniqueFailed.length - failedMisses.length,
      failedMisses,
    };
    if (scenario.secret) {
      const pwFiles = dirContains(unzipDir, scenario.secret);
      result.secret = { text: scenario.secret, inOursTrace: json.includes(scenario.secret) || JSON.stringify(bothTrace).includes(scenario.secret), inPwTrace: pwFiles.length > 0, pwFiles };
    }
    rmSync(unzipDir, { recursive: true, force: true });
  } else if (!result.error) {
    result.error = "no trace or zip from the first `both` run";
  }
  return result;
}

// ---------------------------------------------------------------- summary

const fmt = (n: number | undefined): string => (n === undefined || Number.isNaN(n) ? "-" : String(Math.round(n)));
const kb = (n: number | undefined): string => (n === undefined ? "-" : (n / 1024).toFixed(1));

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

function summary(results: ScenarioResult[], repeat: number): string {
  const ok = results.filter((r) => r.ours && r.pw);
  const parts: string[] = [`# trace-compare (repeat ${repeat}, median)`];
  parts.push("## Completeness", table(
    ["scenario", "PW actions", "PW api calls", "PW frames", "PW DOM snaps", "PW console (err)", "PW page errors", "PW requests (failed)", "our steps", "our frames (kinds)", "our console", "our network", "dropped", "QA"],
    ok.map((r) => [
      r.name, String(r.pw!.actions), String(r.pw!.apiCalls), String(r.pw!.screencastFrames), String(r.pw!.domSnapshots),
      `${r.pw!.consoleTotal} (${r.pw!.consoleErrors})`, String(r.pw!.pageErrors), `${r.pw!.networkRequests} (${r.pw!.failedRequests})`,
      String(r.ours!.steps), `${r.ours!.frames} (${Object.entries(r.ours!.frameKinds).map(([k, v]) => `${k}:${v}`).join(" ")})`,
      String(r.ours!.consoleEntries), String(r.ours!.networkEntries), JSON.stringify(r.ours!.dropped), r.ours!.qaPresent ? `yes (${r.ours!.qaOutcome})` : "no",
    ]),
  ));
  parts.push("## Recall", table(
    ["scenario", "PW unique errors found in ours (raw)", "PW unique failed requests found in ours (raw)"],
    ok.map((r) => [r.name, `${r.recall!.errorsFound}/${r.recall!.errorsTotal} (${r.recall!.errorsRaw})`, `${r.recall!.failedFound}/${r.recall!.failedTotal} (${r.recall!.failedRaw})`]),
  ));
  parts.push("## Size", table(
    ["scenario", "PW zip KB", "our manifest KB", "our assets KB", "our total KB", "parseBrowseTrace"],
    ok.map((r) => [r.name, kb(r.pw!.zipBytes), kb(r.ours!.manifestBytes), kb(r.ours!.assetBytes), kb(r.ours!.manifestBytes + r.ours!.assetBytes), r.ours!.parseOk ? "ok" : `FAIL ${r.ours!.parseError}`]),
  ));
  const pct = (m: number | undefined, base: number | undefined): string =>
    m === undefined || base === undefined || Number.isNaN(m) || !base ? "-" : `${(((m - base) / base) * 100).toFixed(0)}%`;
  parts.push("## Overhead (wall ms of runBrowseAgent)", table(
    ["scenario", "none", "ours", "ours vs none", "pw", "pw vs none", "both", "both vs none", "step ms (ours)", "step ms (both)"],
    results.filter((r) => r.medianMs).map((r) => [
      r.name, fmt(r.medianMs!.none), fmt(r.medianMs!.ours), pct(r.medianMs!.ours, r.medianMs!.none), fmt(r.medianMs!.pw), pct(r.medianMs!.pw, r.medianMs!.none),
      fmt(r.medianMs!.both), pct(r.medianMs!.both, r.medianMs!.none), fmt(r.stepMsMedian?.ours), fmt(r.stepMsMedian?.both),
    ]),
  ));
  const secrets = results.filter((r) => r.secret);
  if (secrets.length) {
    parts.push("## Secret leak", table(
      ["scenario", "secret", "in our trace", "in PW trace", "PW files"],
      secrets.map((r) => [r.name, r.secret!.text, r.secret!.inOursTrace ? "LEAK" : "no", r.secret!.inPwTrace ? "LEAK" : "no", r.secret!.pwFiles.join(", ") || "-"]),
    ));
  }
  const failed = results.filter((r) => r.error);
  if (failed.length) parts.push("## Errors", failed.map((r) => `- ${r.name}: ${r.error}`).join("\n"));
  const misses = ok.filter((r) => r.recall!.errorMisses.length || r.recall!.failedMisses.length);
  if (misses.length) {
    parts.push("## Misses", misses.map((r) => `### ${r.name}\n${[...r.recall!.errorMisses.map((m) => `- error: ${m}`), ...r.recall!.failedMisses.map((m) => `- request: ${m}`)].join("\n")}`).join("\n\n"));
  }
  return parts.join("\n\n") + "\n";
}

// ---------------------------------------------------------------- main

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const out = resolve(arg("out") ?? "./trace-compare-out");
  const only = arg("only")?.split(",").map((s) => s.trim()).filter(Boolean);
  const repeat = Math.max(1, Number(arg("repeat") ?? "1") || 1);
  const selected = SCENARIOS.filter((s) => !only || only.includes(s.name));
  if (selected.length === 0) {
    console.error(`no scenario matches; known: ${SCENARIOS.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }
  mkdirSync(out, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "trace-compare-"));
  const results: ScenarioResult[] = [];
  try {
    for (const scenario of selected) {
      console.log(`scenario ${scenario.name}`);
      try {
        results.push(await runScenario(scenario, out, repeat, scratch));
      } catch (e) {
        results.push({ name: scenario.name, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  writeFileSync(join(out, "results.json"), JSON.stringify({ repeat, results }, null, 2));
  const md = summary(results, repeat);
  writeFileSync(join(out, "summary.md"), md);
  console.log(md);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

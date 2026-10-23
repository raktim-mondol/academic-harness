window.__ModuleLoader__.load({ id: 'academic-harness', factory: (require) => { var module = { exports: {} }; var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client/index.js
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// client/ApiKeysSection.jsx
var import_react2 = require("react");

// client/ZvecIndexProgress.jsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var INDEX_STATE_FIELD = "ZVEC_GREP_INDEX_STATE";
var INDEX_CANCEL_FIELD = "ZVEC_GREP_INDEX_CANCEL";
var errorText = { color: "var(--color-danger, #c0392b)", margin: 0, fontSize: "0.85em" };
var hintText = { margin: 0, opacity: 0.6, fontSize: "0.8em" };
function parseIndexState(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) return { status: "idle" };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.status === "string") return parsed;
  } catch {
  }
  return { status: "idle" };
}
function useIndexJob(scope) {
  const [snapshot, setSnapshot] = (0, import_react.useState)(() => scope.getSnapshot());
  (0, import_react.useEffect)(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope]);
  const job = parseIndexState(snapshot.value?.[INDEX_STATE_FIELD]);
  return { snapshot, job, writable: snapshot.writable !== false };
}
function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1e3));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}
function formatEta(job, now = Date.now()) {
  if (!job?.startedAt) return null;
  const elapsed = Math.max(0, now - job.startedAt);
  const { current, total, percent } = job;
  let ratio;
  if (typeof current === "number" && typeof total === "number" && total > 0 && current > 0 && current < total) {
    ratio = current / total;
  } else if (typeof percent === "number" && percent > 0 && percent < 100) {
    ratio = percent / 100;
  }
  if (!ratio) return elapsed > 0 ? `elapsed ${formatDuration(elapsed)}` : null;
  const remaining = elapsed * (1 - ratio) / ratio;
  return `elapsed ${formatDuration(elapsed)} \xB7 about ${formatDuration(remaining)} remaining`;
}
function barPercent(job) {
  if (typeof job.percent === "number") return Math.min(100, Math.max(0, job.percent));
  if (typeof job.current === "number" && typeof job.total === "number" && job.total > 0) {
    return Math.min(100, Math.max(0, Math.round(job.current / job.total * 100)));
  }
  return null;
}
function ProgressBar({ job, compact }) {
  const [now, setNow] = (0, import_react.useState)(() => Date.now());
  const live = job.status === "running" || job.status === "cancelling";
  (0, import_react.useEffect)(() => {
    if (!live) return void 0;
    const timer = setInterval(() => setNow(Date.now()), 1e3);
    return () => clearInterval(timer);
  }, [live]);
  const pct = barPercent(job);
  const eta = formatEta(job, now);
  const height = compact ? 6 : 8;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: compact ? 4 : 6, minWidth: compact ? 180 : 0 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "div",
      {
        role: "progressbar",
        "aria-valuemin": 0,
        "aria-valuemax": 100,
        "aria-valuenow": pct ?? void 0,
        "aria-label": job.line || "Workspace index",
        style: {
          height,
          background: "rgba(127,127,127,0.28)",
          borderRadius: 999,
          overflow: "hidden"
        },
        children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "div",
          {
            style: {
              width: pct == null ? live ? "35%" : "0%" : `${pct}%`,
              height: "100%",
              background: "#22c55e",
              opacity: pct == null && live ? 0.55 : 1,
              transition: "width 0.35s ease"
            }
          }
        )
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { fontSize: compact ? 11 : "0.8em", opacity: 0.75, lineHeight: 1.35 }, children: [
      pct != null ? `${pct}%` : live ? "working\u2026" : job.status,
      job.line ? ` \xB7 ${job.line}` : "",
      eta ? ` \xB7 ${eta}` : ""
    ] })
  ] });
}
async function requestIndexCancel(scope, job) {
  const token = job?.root || "1";
  await scope.set(INDEX_CANCEL_FIELD, token);
}
function IndexProgressPanel({ scope }) {
  const { job, writable } = useIndexJob(scope);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)();
  const live = job.status === "running" || job.status === "cancelling";
  if (job.status === "idle" && !job.line) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: hintText, children: "Indexing is off at session start by default. Turn it on above, or ask in chat to index later. While an index runs, a progress bar with estimated time and Cancel appear here and in the session header." });
  }
  const onCancel = async () => {
    setBusy(true);
    setError(void 0);
    try {
      await requestIndexCancel(scope, job);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: "0.4rem" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { fontSize: "0.85em" }, children: [
      live ? "Indexing workspace" : job.status === "ready" ? "Index ready" : job.status === "cancelled" ? "Index cancelled" : job.status === "failed" ? "Index failed" : "Workspace index",
      job.root ? ` \u2014 ${job.root}` : ""
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ProgressBar, { job }),
    live && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: busy || !writable || job.status === "cancelling", onClick: onCancel, children: job.status === "cancelling" ? "Cancelling\u2026" : "Cancel indexing" }) }),
    error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: errorText, children: error })
  ] });
}
function ZvecIndexHeaderAction({ scope }) {
  const { job, writable } = useIndexJob(scope);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const live = job.status === "running" || job.status === "cancelling";
  if (!live) return null;
  const onCancel = async () => {
    setBusy(true);
    try {
      await requestIndexCancel(scope, job);
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "div",
    {
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        maxWidth: 520,
        padding: "2px 8px",
        borderRadius: 8,
        background: "var(--dsw-alias-fill-l2, rgba(127,127,127,0.12))"
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: 12, whiteSpace: "nowrap" }, children: "Indexing" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ProgressBar, { job, compact: true }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            disabled: busy || !writable || job.status === "cancelling",
            onClick: onCancel,
            style: { fontSize: 12, flex: "none" },
            children: job.status === "cancelling" ? "Cancelling\u2026" : "Cancel"
          }
        )
      ]
    }
  );
}
function resultText(block) {
  if (!block || !("kind" in block)) return null;
  const parts = Array.isArray(block.content) ? block.content.filter((c) => c && c.type === "text").map((c) => c.text) : [];
  if (parts.length) return parts.join("\n");
  if (block.isError) return "Indexing failed";
  return null;
}
function ZvecIndexToolView({ block, scope, inspect }) {
  const { job } = useIndexJob(scope);
  const running = !block || !("kind" in block);
  const live = running && (job.status === "running" || job.status === "cancelling");
  const settled = resultText(block);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const onCancel = async () => {
    setBusy(true);
    try {
      await requestIndexCancel(scope, job);
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "6px 8px",
        borderRadius: 8,
        background: "var(--dsw-alias-fill-l2, rgba(127,127,127,0.08))"
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 13 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "Workspace index" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { opacity: 0.7 }, children: live ? "running" : running ? "starting\u2026" : block?.isError ? "failed" : "done" }),
          inspect && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: inspect, style: { marginLeft: "auto", fontSize: 12 }, children: "Inspect" })
        ] }),
        (live || running) && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ProgressBar, { job: job.status === "idle" ? { status: "running", line: "Starting workspace index\u2026", startedAt: Date.now() } : job }),
        live && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: busy || job.status === "cancelling", onClick: onCancel, children: job.status === "cancelling" ? "Cancelling\u2026" : "Cancel indexing" }) }),
        settled && !live && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { style: { margin: 0, whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.85 }, children: settled })
      ]
    }
  );
}

// client/ApiKeysSection.jsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var IMAGE_MODEL_OPTIONS = [
  { value: "gemini-2.5-flash-image", label: "gemini-2.5-flash-image \u2014 nano banana" },
  { value: "gemini-3.1-flash-image", label: "gemini-3.1-flash-image \u2014 nano banana 2" },
  { value: "gemini-3-pro-image", label: "gemini-3-pro-image \u2014 nano banana pro" }
];
var SUBAGENT_MODEL_COMPLEX_OPTIONS = [
  { value: "deepseek-flash", label: "deepseek-flash (default)" }
];
var SUBAGENT_MODEL_VISION_OPTIONS = [
  { value: "deepseek-flash", label: "deepseek-flash (default)" }
];
var ZVEC_GREP_EMBEDDING_OPTIONS = [
  { value: "local/potion-retrieval-32m", label: "local/potion-retrieval-32m \u2014 papers / notes (default)" },
  { value: "local/potion-code-16m-v2", label: "local/potion-code-16m-v2 \u2014 code" },
  { value: "local/potion-multilingual-128m", label: "local/potion-multilingual-128m \u2014 multilingual docs" }
];
var ZVEC_GREP_AUTO_INDEX_OPTIONS = [
  { value: "no", label: "No \u2014 ask in chat when semantic search would help (default)" },
  { value: "yes", label: "Yes \u2014 index this workspace when an Academic Harness session opens" }
];
var CUSTOM_MODEL = "__custom__";
var KEYS = [
  { field: "PARALLEL_API_KEY", label: "Parallel", group: "Literature search", hint: "Required for mcp__parallel__* and parallel_search \u2014 sent as a Bearer token so search is not rate-limited. Restart dsh after saving." },
  { field: "FIRECRAWL_API_KEY", label: "Firecrawl", group: "Literature search", hint: "Optional \u2014 raises the keyless rate limit." },
  { field: "CONSENSUS_API_KEY", label: "Consensus", group: "Literature search", hint: "Required to enable this connector." },
  { field: "SCITE_API_KEY", label: "Scite", group: "Literature search", hint: "Required to enable this connector." },
  { field: "BRAVE_API_KEY", label: "Brave Search", group: "Web search", hint: "Optional \u2014 enables brave_search as an independent web-index fallback (not a literature index). Read per call, no restart." },
  { field: "TAVILY_API_KEY", label: "Tavily", group: "Web search", hint: "Required for tavily_search \u2014 AI-native web search with chunked content and topic modes." },
  { field: "EXA_API_KEY", label: "Exa", group: "Web search", hint: "Required for exa_search \u2014 neural/entity web search with optional content extraction." },
  { field: "PERPLEXITY_API_KEY", label: "Perplexity", group: "Web search", hint: "Required for perplexity_search \u2014 raw ranked web results (not the synthesized-answer API)." },
  { field: "JINA_API_KEY", label: "Jina", group: "Web search", hint: "Optional for jina_read (keyless Reader is 20 RPM); required for jina_read mode=search." },
  { field: "UNPAYWALL_EMAIL", label: "Unpaywall contact email", group: "Literature search", hint: "Required for paper_download to resolve a DOI to an open-access PDF \u2014 Unpaywall asks API callers to identify themselves with a real email." },
  { field: "OPENALEX_API_KEY", label: "OpenAlex", group: "Academic databases", hint: "Optional \u2014 a free key raises the daily budget and rate limit (10 \u2192 30 RPS) and enables cursor paging. Used by openalex_search, openalex_citations, and paper_resolve." },
  { field: "S2_API_KEY", label: "Semantic Scholar", group: "Academic databases", hint: "Optional \u2014 a free key gives s2_search and paper_resolve a dedicated 1 RPS bucket. Unkeyed traffic shares a heavily throttled pool." },
  { field: "CROSSREF_MAILTO", label: "Crossref contact email", group: "Academic databases", hint: "Optional \u2014 moves crossref_lookup into the polite pool (3 RPS list, 10 RPS single). Falls back to the Unpaywall email." },
  { field: "NCBI_API_KEY", label: "NCBI API key", group: "Academic databases", hint: 'Optional \u2014 raises pubmed_search source="ncbi" from 3 to 10 requests per second.' },
  { field: "NCBI_EMAIL", label: "NCBI contact email", group: "Academic databases", hint: "Optional \u2014 NCBI asks API callers for a contact email. Falls back to the Unpaywall email." },
  { field: "CORE_API_KEY", label: "CORE", group: "Academic databases", hint: "Optional \u2014 keyless CORE is limited to ~10 requests/minute; a registered key gives more stable access and is required for include_fulltext." },
  { field: "ELICIT_API_KEY", label: "Elicit", group: "Academic databases", hint: "Required for elicit_search \u2014 Elicit Pro plan or above. 100 requests/minute per IP, then a 5-minute block." },
  { field: "FUTUREHOUSE_API_KEY", label: "FutureHouse / Edison", group: "Research agents", hint: "Required for futurehouse_agent (Crow/Falcon/Owl on the Edison Scientific platform). Tasks are asynchronous: start, then poll status in a later turn." },
  { field: "GEMINI_API_KEY", label: "Gemini", group: "Image generation", hint: "Enables the image_generate tool." },
  { field: "IMAGE_MODEL", label: "Image model", group: "Image generation", type: "select", options: IMAGE_MODEL_OPTIONS, hint: "Which Gemini model image_generate uses by default. Defaults to nano banana if unset." },
  { field: "SUBAGENT_MODEL_COMPLEX", label: "Complex-task model", group: "Subagent model routing", type: "select", options: SUBAGENT_MODEL_COMPLEX_OPTIONS, hint: "Model for the subagent_pro delegation tool (unusually heavy reasoning). Requires restarting dsh to apply \u2014 same as the MCP connector keys above, not like Image model." },
  { field: "SUBAGENT_MODEL_VISION", label: "Image-reading model", group: "Subagent model routing", type: "select", options: SUBAGENT_MODEL_VISION_OPTIONS, hint: "Model for the subagent_vision delegation tool (reads images via read_image). Requires restarting dsh to apply \u2014 same as the MCP connector keys above, not like Image model." },
  { field: "MODAL_TOKEN_ID", label: "Modal \u2014 token ID", group: "Remote compute", hint: "From modal.com/settings." },
  { field: "MODAL_TOKEN_SECRET", label: "Modal \u2014 token secret", group: "Remote compute", hint: "From modal.com/settings." },
  { field: "RUNPOD_API_KEY", label: "Runpod", group: "Remote compute", hint: "From console.runpod.io/user/settings." },
  { field: "ZVEC_GREP_AUTO_INDEX", label: "Index at session start", group: "Workspace search (zvec-grep)", type: "select", options: ZVEC_GREP_AUTO_INDEX_OPTIONS, hideCustom: true, hint: "Default is No. When No, you can still ask in chat to index, and the agent will ask first when semantic search would help. When Yes, an Academic Harness session indexes that workspace in the background if no index exists yet. Applies to the next session \u2014 no restart. While indexing, a progress bar with estimated time and Cancel appear here and in the session header. There is no timeout." },
  { field: "ZVEC_GREP_EMBEDDING", label: "zvec-grep embedding", group: "Workspace search (zvec-grep)", type: "select", options: ZVEC_GREP_EMBEDDING_OPTIONS, hint: "Default local model for new zg indexes (potion-retrieval-32m, ~130 MB download, no API key). Existing indexes keep their stored model. Restart dsh after changing." },
  { field: "ZVEC_GREP_API_KEY", label: "zvec-grep remote embedding key", group: "Workspace search (zvec-grep)", hint: "Leave empty. Only needed for a remote (Qwen) embedding model, not for the default local Potion models." }
];
var GROUPS = [...new Set(KEYS.map((k) => k.group))];
var errorText2 = { color: "var(--color-danger, #c0392b)", margin: 0, fontSize: "0.85em" };
var hintText2 = { margin: 0, opacity: 0.6, fontSize: "0.8em" };
var fieldLabel = { fontSize: "0.85em" };
function SelectField({ k, scope, snapshot, writable }) {
  const stored = snapshot.value?.[k.field] || "";
  const known = k.options.some((o) => o.value === stored);
  const [customMode, setCustomMode] = (0, import_react2.useState)(Boolean(stored) && !known);
  const [customDraft, setCustomDraft] = (0, import_react2.useState)(known ? "" : stored);
  const [busy, setBusy] = (0, import_react2.useState)(false);
  const [error, setError] = (0, import_react2.useState)();
  const apply2 = async (value) => {
    setBusy(true);
    setError(void 0);
    try {
      if (value) await scope.set(k.field, value);
      else await scope.unset(k.field);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const onSelectChange = (e) => {
    const value = e.target.value;
    if (value === CUSTOM_MODEL) {
      setCustomMode(true);
      return;
    }
    setCustomMode(false);
    apply2(value);
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: "0.25rem" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { style: fieldLabel, children: [
      k.label,
      " \u2014 ",
      stored || `default (${k.options[0].value})`
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
      "select",
      {
        value: customMode ? CUSTOM_MODEL : stored || k.options[0].value,
        disabled: busy || !writable,
        onChange: onSelectChange,
        style: { flex: 1 },
        children: [
          k.options.map((o) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: o.value, children: o.label }, o.value)),
          !k.hideCustom && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: CUSTOM_MODEL, children: "Custom\u2026" })
        ]
      }
    ),
    customMode && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", gap: "0.5rem" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "input",
        {
          type: "text",
          autoComplete: "off",
          placeholder: "model id, e.g. gemini-2.0-flash-exp",
          value: customDraft,
          disabled: busy || !writable,
          onChange: (e) => setCustomDraft(e.target.value),
          style: { flex: 1 }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", disabled: busy || !writable || !customDraft.trim(), onClick: () => apply2(customDraft.trim()), children: "Apply" })
    ] }),
    error && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: errorText2, children: error }),
    k.hint && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: hintText2, children: k.hint })
  ] }, k.field);
}
function SecretField({ k, scope, snapshot, writable }) {
  const [draft, setDraft] = (0, import_react2.useState)("");
  const [busy, setBusy] = (0, import_react2.useState)(false);
  const [error, setError] = (0, import_react2.useState)();
  const configured = Boolean(snapshot.value?.[k.field]);
  const save = async () => {
    const value = draft.trim();
    if (!value) return;
    setBusy(true);
    setError(void 0);
    try {
      await scope.set(k.field, value);
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    setBusy(true);
    setError(void 0);
    try {
      await scope.unset(k.field);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: "0.25rem" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { style: fieldLabel, children: [
      k.label,
      " \u2014 ",
      configured ? "configured" : "not set"
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", gap: "0.5rem" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "input",
        {
          type: "password",
          autoComplete: "off",
          placeholder: configured ? "leave blank to keep" : "not set",
          value: draft,
          disabled: busy || !writable,
          onChange: (e) => setDraft(e.target.value),
          style: { flex: 1 }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", disabled: busy || !writable || !draft.trim(), onClick: save, children: "Save" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", disabled: busy || !writable || !configured, onClick: clear, children: "Clear" })
    ] }),
    error && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: errorText2, children: error }),
    k.hint && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: hintText2, children: k.hint })
  ] }, k.field);
}
function ApiKeysSection(props) {
  const { scope } = props;
  const [snapshot, setSnapshot] = (0, import_react2.useState)(() => scope.getSnapshot());
  (0, import_react2.useEffect)(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope]);
  if (snapshot.status === "loading") {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { padding: "4px 0" }, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: { margin: 0, opacity: 0.75, fontSize: "0.9em" }, children: "Connecting\u2026" }) });
  }
  if (snapshot.status === "unavailable") {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { padding: "4px 0" }, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: { margin: 0, opacity: 0.75, fontSize: "0.9em" }, children: "Settings storage is unavailable in this browser session (non-loopback connections don't get durable settings). Set the matching environment variables before starting DSH instead." }) });
  }
  const writable = snapshot.writable !== false;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: "1.5rem", padding: "4px 0" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: { margin: 0, opacity: 0.75, fontSize: "0.9em" }, children: "API keys for Academic Harness's academic- and web-search connectors, image generation, remote-compute tools, and optional zvec-grep remote embeddings. A key set here is used only when the matching environment variable isn't already set when DSH starts." }),
    !writable && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: errorText2, children: "Settings storage is read-only in this session." }),
    GROUPS.map((group) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: "0.75rem" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { style: { margin: 0, fontSize: "0.95em" }, children: group }),
      KEYS.filter((k) => k.group === group).map((k) => k.type === "select" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SelectField, { k, scope, snapshot, writable }, k.field) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SecretField, { k, scope, snapshot, writable }, k.field)),
      group === "Workspace search (zvec-grep)" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(IndexProgressPanel, { scope })
    ] }, group))
  ] });
}

// client/index.js
var ENTRY_ID = "academic-harness";
var inject = ["slots", "configForms"];
function apply(ctx) {
  const scope = ctx.configForms.get(ENTRY_ID);
  ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "academic-harness-api-keys",
    order: 60,
    label: () => "Academic Harness API keys",
    inject: () => ({ scope })
  }, ApiKeysSection))));
  ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
    name: "conversation.session.header.actions",
    id: "zvec-index-progress",
    order: 25,
    inject: () => ({ scope })
  }, ZvecIndexHeaderAction));
  ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
    name: "tool.call.toolview",
    key: "zvec_index",
    inject: () => ({ scope })
  }, ZvecIndexToolView));
}
return module.exports; } });
//# sourceMappingURL=client.js.map

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

// client/secret-presence.js
var KEYS_NAMESPACE = "academic-harness";
function secretPresence(view) {
  const row2 = view?.namespaces?.find((entry) => entry.ns === KEYS_NAMESPACE);
  if (!row2 || !Array.isArray(row2.secrets) || row2.secrets.length === 0) return void 0;
  const present = /* @__PURE__ */ new Map();
  for (const secret of row2.secrets) {
    if (Array.isArray(secret?.path) && secret.path.length === 1) present.set(String(secret.path[0]), secret.set === true);
  }
  return present;
}

// client/ApiKeysSection.jsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var IMAGE_MODEL_OPTIONS = [
  { value: "gemini-2.5-flash-image", label: "gemini-2.5-flash-image \u2014 nano banana" },
  { value: "gemini-3.1-flash-image", label: "gemini-3.1-flash-image \u2014 nano banana 2" },
  { value: "gemini-3-pro-image", label: "gemini-3-pro-image \u2014 nano banana pro" }
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
  { field: "PARALLEL_API_KEY", label: "Parallel", group: "Literature search", hint: "Required for parallel_search and parallel_extract \u2014 native REST tools, read per call, no restart." },
  { field: "FIRECRAWL_API_KEY", label: "Firecrawl", group: "Literature search", hint: "Required to mount Firecrawl (search/scrape/parse); the connector stays disabled without it. Restart dsh after saving." },
  { field: "CONSENSUS_API_KEY", label: "Consensus", group: "Literature search", hint: "Required for consensus_search, a native REST tool \u2014 read per call, no restart." },
  { field: "SCITE_API_KEY", label: "Scite", group: "Literature search", hint: "Required to enable the Scite MCP connector. Restart dsh after saving." },
  { field: "BRAVE_API_KEY", label: "Brave Search", group: "Web search", hint: "Optional \u2014 enables brave_search as an independent web-index fallback (not a literature index). Read per call, no restart." },
  { field: "TAVILY_API_KEY", label: "Tavily", group: "Web search", hint: "Required for tavily_search \u2014 AI-native web search with chunked content and topic modes." },
  { field: "EXA_API_KEY", label: "Exa", group: "Web search", hint: "Required for exa_search \u2014 neural/entity web search with optional content extraction." },
  { field: "PERPLEXITY_API_KEY", label: "Perplexity", group: "Web search", hint: "Required for perplexity_search \u2014 raw ranked web results (not the synthesized-answer API)." },
  { field: "JINA_API_KEY", label: "Jina", group: "Web search", hint: "Optional for jina_read (keyless Reader is 20 RPM); required for jina_read mode=search." },
  { field: "UNPAYWALL_EMAIL", label: "Unpaywall contact email", group: "Literature search", hint: "Recommended for paper_download: enables the Unpaywall lookup, and the other open-access fallbacks still run without it. Unpaywall asks API callers to identify themselves with a real email." },
  { field: "OPENALEX_API_KEY", label: "OpenAlex", group: "Academic databases", hint: "Optional \u2014 a free key raises the daily budget and rate limit (10 \u2192 30 RPS) and enables cursor paging. Used by openalex_search, openalex_citations, paper_resolve, integrity_check, and funder_policy." },
  { field: "S2_API_KEY", label: "Semantic Scholar", group: "Academic databases", hint: "Optional \u2014 a free key gives s2_search and paper_resolve a dedicated 1 RPS bucket. Unkeyed traffic shares a heavily throttled pool." },
  { field: "CROSSREF_MAILTO", label: "Crossref contact email", group: "Academic databases", hint: "Optional \u2014 moves crossref_lookup, citation DOI checks, paper_resolve, and coscientist_verify into the polite pool. Falls back to the Unpaywall email." },
  { field: "NCBI_API_KEY", label: "NCBI API key", group: "Academic databases", hint: 'Optional \u2014 raises pubmed_search source="ncbi" from 3 to 10 requests per second.' },
  { field: "NCBI_EMAIL", label: "NCBI contact email", group: "Academic databases", hint: "Optional \u2014 NCBI asks API callers for a contact email. Falls back to the Unpaywall email." },
  { field: "CORE_API_KEY", label: "CORE", group: "Academic databases", hint: "Optional \u2014 keyless CORE is limited to ~10 requests/minute; a registered key gives more stable access and is required for include_fulltext." },
  { field: "ADS_API_TOKEN", label: "NASA ADS", group: "Domain sources", hint: "Required for ADS results in literature_search (sources=ads) and domain_search ADS actions. Create a token in your ADS account; a daily quota applies. Read per call, no restart." },
  { field: "SCOPUS_API_KEY", label: "Scopus / Elsevier", group: "Domain sources", hint: "Required for Scopus results in literature_search (sources=scopus), domain_search Scopus actions, journal_search CiteScore/SJR/SNIP, and paper_context ScienceDirect FULL. Key from dev.elsevier.com; access follows institutional IP/VPN, so 401/403 means not entitled. Read per call, no restart." },
  { field: "ELSEVIER_INSTTOKEN", label: "Elsevier institutional token", group: "Domain sources", hint: "Optional \u2014 needed for subscriber-gated ScienceDirect FULL views in paper_context. Sent as X-ELS-Insttoken alongside SCOPUS_API_KEY. Read per call, no restart." },
  { field: "WOS_API_KEY", label: "Web of Science / JCR", group: "Domain sources", hint: "Required for Web of Science results in literature_search (sources=wos), domain_search WoS actions, and journal_search JIF/JCI/quartile metrics. Key from the Clarivate Developer Portal; Starter has a low daily quota and field limits. Read per call, no restart." },
  { field: "WILEY_TDM_TOKEN", label: "Wiley TDM", group: "Academic databases", hint: "Optional \u2014 enables the Wiley TDM full-text PDF tier in paper_context. Requires Wiley TDM entitlement. Read per call, no restart." },
  { field: "SPRINGER_API_KEY", label: "Springer Nature", group: "Academic databases", hint: "Optional \u2014 enables literature_search (sources=springer) and the Springer JATS full-text tier in paper_context. Free developer keys have a daily quota. Read per call, no restart." },
  { field: "IEEE_API_KEY", label: "IEEE Xplore", group: "Academic databases", hint: "Optional \u2014 enables literature_search (sources=ieee) through the IEEE Xplore metadata API. Free developer keys have a daily quota. Read per call, no restart." },
  { field: "ELICIT_API_KEY", label: "Elicit", group: "Academic databases", hint: "Required for elicit_search \u2014 Elicit Pro plan or above. 100 requests/minute per IP, then a 5-minute block." },
  { field: "TYPESAFE_API_KEY", label: "TypeSafe (Jev)", group: "Literature search", hint: "Optional \u2014 TypeSafe API key for Jev, which picks the literature_search sources for a query (PubMed, arXiv, bioRxiv, INSPIRE) instead of keyword rules. Without it, search falls back to the rules. The query text is sent to api.typesafe.ai. Key from console.typesafe.ai/keys. Read per call, no restart." },
  { field: "COHERE_API_KEY", label: "Cohere (Rerank)", group: "Literature search", hint: "Optional \u2014 Cohere API key for the literature_search reranker, an alternative to Jev for ordering merged results by relevance. The query and public abstracts are sent to api.cohere.com. A trial key is rate limited (about 10 rerank calls a minute). Key from dashboard.cohere.com/api-keys. Read per call, no restart." },
  { field: "FUTUREHOUSE_API_KEY", label: "FutureHouse / Edison", group: "Research agents", hint: "Required for futurehouse_agent (Crow/Falcon/Owl on the Edison Scientific platform). Tasks are asynchronous: start, then poll status in a later turn." },
  { field: "OPENFDA_API_KEY", label: "openFDA", group: "Regulatory data", hint: "Optional \u2014 openFDA works keyless at a low shared daily limit; a free key raises the quota. Used by the openfda tool." },
  { field: "SHERPA_ROMERO_API_KEY", label: "Sherpa Romeo", group: "Data and compliance", hint: "Optional \u2014 without it journal_policy returns DOAJ data only and notes that Sherpa Romeo was not checked. A free key adds per-version self-archiving policy." },
  { field: "DATACITE_API_KEY", label: "DataCite", group: "Data and compliance", hint: "Optional \u2014 public DataCite reads need no key; set this only if your gateway requires a bearer token. Used by dataset_search." },
  { field: "ZENODO_API_KEY", label: "Zenodo", group: "Data and compliance", hint: "Optional \u2014 a Zenodo personal access token (sent as a Bearer token) lets dataset_search files list restricted records you can access. Public records work keyless." },
  { field: "FIGSHARE_API_KEY", label: "Figshare", group: "Data and compliance", hint: 'Optional \u2014 a Figshare personal token (sent as "token \u2026") lets dataset_search files access records available to your account. Public records work keyless.' },
  { field: "PATENTSVIEW_API_KEY", label: "PatentsView", group: "Patents", hint: "Required for patent_search (optional tool). Free key from search.patentsview.org; without it the tool returns a clear error." },
  { field: "ORCID_TOKEN", label: "ORCID", group: "Identity", hint: "Optional \u2014 used by the optional author_lookup tool as a Bearer token for higher ORCID rate limits. Public reads work without it; ROR needs no key." },
  { field: "GEMINI_API_KEY", label: "Gemini", group: "Image generation", hint: "Enables image_generate and coscientist embed." },
  { field: "IMAGE_MODEL", label: "Image model", group: "Image generation", type: "select", options: IMAGE_MODEL_OPTIONS, hint: "Which Gemini model image_generate uses by default. Defaults to nano banana if unset." },
  { field: "SUBAGENT_PRO_BASE_URL", label: "Pro endpoint URL", group: "Subagent model routing", type: "text", hint: "Endpoint root, for example https://api.deepseek.com/anthropic or https://api.openai.com/v1. Anthropic-style URLs use the Anthropic Messages protocol; other URLs use OpenAI Chat Completions." },
  { field: "SUBAGENT_PRO_MODEL", label: "Pro model", group: "Subagent model routing", type: "text", hint: "Model id sent to this endpoint. Set endpoint, model, and API key to activate the route; leave all three blank to inherit the session model." },
  { field: "SUBAGENT_PRO_API_KEY", label: "Pro API key", group: "Subagent model routing", hint: "Stored in the DSH credential store and used only for this route. Required with the endpoint and model." },
  { field: "SUBAGENT_VISION_BASE_URL", label: "Vision endpoint URL", group: "Subagent model routing", type: "text", hint: "Endpoint root for the image-reading route, for example https://api.deepseek.com/anthropic or https://api.openai.com/v1. Anthropic-style URLs use the Anthropic Messages protocol; other URLs use OpenAI Chat Completions." },
  { field: "SUBAGENT_VISION_MODEL", label: "Vision model", group: "Subagent model routing", type: "text", hint: "Image-capable model id sent to this endpoint. Set endpoint, model, and API key to activate the route; leave all three blank to inherit the session model." },
  { field: "SUBAGENT_VISION_API_KEY", label: "Vision API key", group: "Subagent model routing", hint: "Stored in the DSH credential store and used only for this route. Required with the endpoint and model." },
  { field: "MODAL_TOKEN_ID", label: "Modal \u2014 token ID", group: "Remote compute", hint: "From modal.com/settings." },
  { field: "MODAL_TOKEN_SECRET", label: "Modal \u2014 token secret", group: "Remote compute", hint: "From modal.com/settings." },
  { field: "RUNPOD_API_KEY", label: "Runpod", group: "Remote compute", hint: "From console.runpod.io/user/settings." },
  { field: "VAST_API_KEY", label: "Vast.ai", group: "Remote compute", hint: "From cloud.vast.ai/manage-keys." },
  { field: "CO_SCIENTIST_MAX_HYPOTHESES", label: "Hypotheses per tournament", group: "Hypothesis tournament", hint: "Default cap for `coscientist` action=start (5). Chosen so one review veto plus one dual-use withholding still leaves three ideas competing \u2014 at 3 the tournament stalls. Past 5 the extra ideas buy breadth while each pair meets less than twice. Debate matches are the expensive part. A per-call max_hypotheses wins; read per call, no restart." },
  { field: "CO_SCIENTIST_STEP_BUDGET", label: "Dispatch steps per tournament", group: "Hypothesis tournament", hint: "Default cap on dispatch rounds (36) \u2014 sized for the 5-hypothesis default: ~8 generations + 5 reviews + 15 matches \u2248 31, with slack. It is also the smallest budget where the Elo plateau can fire at all (needs 20 samples and 10 matches). Raise both together, or a bigger pool ends on budget instead of converged rankings. A per-call step_budget wins." },
  { field: "CO_SCIENTIST_DUP_THRESHOLD", label: "Duplicate gate", group: "Hypothesis tournament", hint: "Similarity (0-1) at which `coscientist` add discards a near-duplicate hypothesis. Leave empty for the measure default (0.70 lexical, 0.92 cosine); set 1 to turn the gate off." },
  { field: "CO_SCIENTIST_SEED", label: "Schedule seed", group: "Hypothesis tournament", hint: "Number that makes a tournament's sampled task schedule reproducible. Leave empty for a non-deterministic run." },
  { field: "CO_SCIENTIST_EMBED_MODEL", label: "Embedding model", group: "Hypothesis tournament", hint: "Optional. Model for `coscientist embed`, which switches the duplicate gate to cosine. Defaults to text-embedding-004 and needs GEMINI_API_KEY; leave empty to keep the lexical gate, which needs no key and no network." },
  { field: "DEEP_REVIEW_DEFAULT_RUBRIC", label: "Default score rubric", group: "Deep review", type: "text", hint: 'Rubric for `deep_review action=score`. Include a declared numeric range such as "1\u20135" or "1\u201310"; otherwise the default 1\u20135 scale applies. The rubric source is recorded in score.json. Leave empty for the built-in rubric.' },
  { field: "DEEP_REVIEW_MAX_ROUNDS", label: "Max review rounds", group: "Deep review", type: "text", hint: "Optional. Refuse a new `review` once this many rounds are stored for one manuscript. Leave empty or 0 for no limit. A round after a revision is what makes `compare` meaningful." },
  { field: "DEEP_REVIEW_COST_CEILING_USD", label: "Per-review cost ceiling (USD)", group: "Deep review", type: "text", hint: "Optional. Before a review, ask the engine for its median cost estimate and refuse if it exceeds this amount. Leave empty or 0 for no ceiling. This is a user preference, not an autonomy gate." },
  { field: "ZVEC_GREP_AUTO_INDEX", label: "Index at session start", group: "Workspace search (zvec-grep)", type: "select", options: ZVEC_GREP_AUTO_INDEX_OPTIONS, hideCustom: true, hint: "Default is No. When No, you can still ask in chat to index, and the agent will ask first when semantic search would help. When Yes, an Academic Harness session indexes that workspace in the background if no index exists yet. Applies to the next session \u2014 no restart. While indexing, a progress bar with estimated time and Cancel appear here and in the session header. There is no timeout." },
  { field: "ZVEC_GREP_EMBEDDING", label: "zvec-grep embedding", group: "Workspace search (zvec-grep)", type: "select", options: ZVEC_GREP_EMBEDDING_OPTIONS, hint: "Default local model for new zg indexes (potion-retrieval-32m, ~130 MB download, no API key). Existing indexes keep their stored model. A new index run uses the current value; restart dsh so the search daemon uses it too." },
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
      stored || (k.options[0].value ? `default (${k.options[0].value})` : k.options[0].label)
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
function SecretField({ k, scope, snapshot, writable, presence }) {
  const [draft, setDraft] = (0, import_react2.useState)("");
  const [busy, setBusy] = (0, import_react2.useState)(false);
  const [error, setError] = (0, import_react2.useState)();
  const fromSidecar = presence?.get(k.field);
  const configured = fromSidecar !== void 0 ? fromSidecar : Boolean(snapshot.value?.[k.field]);
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
function TextField({ k, scope, snapshot, writable }) {
  const stored = snapshot.value?.[k.field] || "";
  const [draft, setDraft] = (0, import_react2.useState)(stored);
  const [busy, setBusy] = (0, import_react2.useState)(false);
  const [error, setError] = (0, import_react2.useState)();
  (0, import_react2.useEffect)(() => {
    setDraft(stored);
  }, [stored]);
  const save = async () => {
    const value = draft.trim();
    setBusy(true);
    setError(void 0);
    try {
      await scope.set(k.field, value);
      setDraft(value);
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
      setDraft("");
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
      stored || "not set"
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", gap: "0.5rem" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "input",
        {
          type: "text",
          autoComplete: "off",
          value: draft,
          disabled: busy || !writable,
          onChange: (e) => setDraft(e.target.value),
          style: { flex: 1 }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", disabled: busy || !writable || !draft.trim() || draft.trim() === stored, onClick: save, children: "Save" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", disabled: busy || !writable || !stored, onClick: clear, children: "Clear" })
    ] }),
    error && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: errorText2, children: error }),
    k.hint && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: hintText2, children: k.hint })
  ] }, k.field);
}
function ApiKeysSection(props) {
  const { scope, describe } = props;
  const [snapshot, setSnapshot] = (0, import_react2.useState)(() => scope.getSnapshot());
  const [described, setDescribed] = (0, import_react2.useState)(() => describe?.getSnapshot?.());
  (0, import_react2.useEffect)(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope]);
  (0, import_react2.useEffect)(() => {
    if (!describe?.subscribe) return void 0;
    setDescribed(describe.getSnapshot());
    return describe.subscribe(() => setDescribed(describe.getSnapshot()));
  }, [describe]);
  const presence = secretPresence(described?.view);
  if (snapshot.status === "loading") {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { padding: "4px 0" }, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: { margin: 0, opacity: 0.75, fontSize: "0.9em" }, children: "Connecting\u2026" }) });
  }
  if (snapshot.status === "unavailable") {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: { padding: "4px 0" }, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: { margin: 0, opacity: 0.75, fontSize: "0.9em" }, children: "Settings storage is unavailable in this browser session (non-loopback connections don't get durable settings). Set the matching environment variables before starting DSH instead." }) });
  }
  const writable = snapshot.writable !== false;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: "1.5rem", padding: "4px 0" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: { margin: 0, opacity: 0.75, fontSize: "0.9em" }, children: "API keys for Academic Harness's academic- and web-search connectors, image generation, remote-compute tools, optional zvec-grep remote embeddings, and the deep-review score preferences. A key set here is used only when the matching environment variable isn't already set when DSH starts." }),
    !writable && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { style: errorText2, children: "Settings storage is read-only in this session." }),
    GROUPS.map((group) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: "0.75rem" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { style: { margin: 0, fontSize: "0.95em" }, children: group }),
      KEYS.filter((k) => k.group === group).map((k) => k.type === "select" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SelectField, { k, scope, snapshot, writable }, k.field) : k.type === "text" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(TextField, { k, scope, snapshot, writable }, k.field) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SecretField, { k, scope, snapshot, writable, presence }, k.field)),
      group === "Workspace search (zvec-grep)" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(IndexProgressPanel, { scope })
    ] }, group))
  ] });
}

// client/FoldPane.js
var import_react4 = require("react");

// client/reply-fold.js
var import_react3 = require("react");

// fold-core.js
var LEVEL_ALIASES = /* @__PURE__ */ new Map([
  ["full", "full"],
  ["1", "full"],
  ["brief", "brief"],
  ["2", "brief"],
  ["points", "points"],
  ["3", "points"],
  ["outline", "outline"],
  ["4", "outline"],
  ["gist", "gist"],
  ["5", "gist"]
]);
var FENCE = /^\s*(`{3,}|~{3,})/;
var HEADING = /^\s{0,3}(#{1,6})\s+/;
var ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
var RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
var DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
var ABBREV = /\b(?:e\.g|i\.e|etc|vs|cf|al|approx|Dr|Mr|Ms|Fig|Eq|No)\.$/i;
var CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g;
var MORE = " \u2026";
function normalizeLevel(level = "brief") {
  const key = String(level).trim().toLowerCase();
  const normalized = LEVEL_ALIASES.get(key);
  if (!normalized) throw new Error(`unknown fold level: ${level}`);
  return normalized;
}
var tableAt = (lines, i) => (lines[i] ?? "").includes("|") && (lines[i + 1] ?? "").includes("|") && DELIM.test(lines[i + 1] ?? "");
function blocks(md) {
  const out = [];
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1] ?? "```";
      const buf2 = [line];
      i += 1;
      while (i < lines.length) {
        const current = lines[i] ?? "";
        buf2.push(current);
        i += 1;
        if (current.trim().startsWith(mark)) break;
      }
      out.push({ kind: "code", lines: buf2 });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ kind: "heading", level: heading[1].length, lines: [line] });
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ kind: "rule", lines: [line] });
      i += 1;
      continue;
    }
    const kind = tableAt(lines, i) ? "table" : /^\s*>/.test(line) ? "quote" : ITEM.test(line) ? "list" : "para";
    const buf = [line];
    i += 1;
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (!current.trim() || FENCE.test(current) || HEADING.test(current)) break;
      if (kind === "para" && (ITEM.test(current) || tableAt(lines, i))) break;
      buf.push(current);
      i += 1;
    }
    out.push({ kind, lines: buf });
  }
  return out;
}
function cut(text, at) {
  const rest = text.slice(at).trim();
  return { head: balance(text.slice(0, at).trim()), more: rest.length > 0, rest };
}
function balance(text) {
  let out = text;
  if ((out.match(/\*\*/g) ?? []).length % 2) out += "**";
  if ((out.match(/`/g) ?? []).length % 2) out += "`";
  return out;
}
function firstSentence(text) {
  let inCode = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? "";
    if (char === "`") {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if ("\u3002\uFF01\uFF1F".includes(char)) return cut(text, i + 1);
    if (!".!?".includes(char)) continue;
    const after = /^([*_)"'”’\]]*)(\s+|$)/.exec(text.slice(i + 1));
    if (!after) continue;
    if (ABBREV.test(text.slice(0, i + 1))) continue;
    return cut(text, i + 1 + (after[1] ?? "").length);
  }
  return { head: text.trim(), more: false, rest: "" };
}
function sentences(text, count) {
  let rest = text.trim();
  const out = [];
  let more = false;
  for (let k = 0; k < count && rest; k += 1) {
    const next = firstSentence(rest);
    out.push(next.head);
    rest = next.rest;
    more = next.more;
  }
  return { text: out.join(" "), more };
}
function items(block) {
  const out = [];
  for (const line of block.lines) {
    const match = ITEM.exec(line);
    if (match) {
      out.push({ indent: (match[1] ?? "").length, marker: match[2] ?? "-", text: match[3] ?? "" });
    } else if (out.length) {
      const last = out[out.length - 1];
      last.text += ` ${line.trim()}`;
    }
  }
  return out;
}
function tableRows(lines) {
  const rows = [];
  for (const line of lines) {
    if (DELIM.test(line)) continue;
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    if (cells.some(Boolean)) rows.push(cells);
  }
  return rows;
}
function words(md) {
  const plain = String(md ?? "").replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ");
  const cjk = (plain.match(CJK) ?? []).length;
  const latin = (plain.replace(CJK, " ").match(/[A-Za-z0-9][\w'’-]*/g) ?? []).length;
  return cjk + latin;
}
function reading(md) {
  const plain = String(md ?? "").replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ");
  const cjk = (plain.match(CJK) ?? []).length;
  return words(md) - cjk + cjk / 1.6;
}
var MIN_WORDS = 80;
var MIN_HIDDEN = 0.25;
function worthFolding(md, folded) {
  const all = reading(md);
  if (all <= 0) return false;
  return all >= MIN_WORDS && 1 - reading(folded) / all >= MIN_HIDDEN;
}
function foldStats(before, after) {
  const wordsBefore = words(before);
  const wordsAfter = words(after);
  return {
    words_before: wordsBefore,
    words_after: wordsAfter,
    hidden_ratio: wordsBefore ? Number((1 - wordsAfter / wordsBefore).toFixed(3)) : 0
  };
}
function blockText(block) {
  switch (block.kind) {
    case "heading":
    case "code":
    case "table":
    case "rule":
      return block.lines.join("\n");
    case "list":
      return block.items.map((item) => `${" ".repeat(item.indent)}${item.marker} ${item.text}${item.more ? MORE : ""}`).join("\n");
    case "quote":
      return `> ${block.text}`;
    default:
      return block.text;
  }
}
function fullBlock(block) {
  switch (block.kind) {
    case "heading":
      return { kind: "heading", level: block.level, lines: block.lines };
    case "para":
    case "paragraph":
      return { kind: "paragraph", text: block.lines.join("\n") };
    case "quote":
      return { kind: "quote", text: block.lines.map((line) => line.replace(/^\s*>\s?/, "")).join("\n") };
    case "list": {
      const all = items(block);
      return {
        kind: "list",
        ordered: /^\d/.test(all[0]?.marker ?? ""),
        items: all.map((item) => ({ ...item, more: false }))
      };
    }
    case "table":
      return { kind: "table", lines: block.lines, rows: tableRows(block.lines) };
    case "code":
      return { kind: "code", lines: block.lines };
    case "rule":
      return { kind: "rule", lines: block.lines };
    default:
      return null;
  }
}
function foldReply(md, level = "brief") {
  const source = String(md ?? "");
  const requested = normalizeLevel(level);
  const total = words(source);
  if (!source.trim()) {
    return { requested_level: requested, level: requested, text: "", blocks: [], total: 0, shown: 0, changed: false };
  }
  if (requested === "full") {
    return {
      requested_level: requested,
      level: "full",
      text: source,
      blocks: blocks(source).map(fullBlock).filter(Boolean),
      total,
      shown: total,
      changed: false
    };
  }
  const parsed = blocks(source);
  let applied = requested;
  if (applied === "outline" && !parsed.some((block) => block.kind === "heading")) applied = "points";
  const out = [];
  let underHeading = true;
  let first = true;
  for (const block of parsed) {
    if (applied === "gist" && !first) break;
    switch (block.kind) {
      case "rule":
        break;
      case "heading":
        if (applied !== "gist") out.push({ kind: "heading", level: block.level, lines: block.lines });
        underHeading = true;
        break;
      case "code":
      case "table":
        if (applied === "outline" || applied === "gist") break;
        if (block.kind === "table") {
          out.push({ kind: "table", lines: block.lines, rows: tableRows(block.lines) });
        } else if (block.lines.length <= 8) {
          out.push({ kind: "code", lines: block.lines });
        } else {
          const hidden = Math.max(0, block.lines.length - 2);
          out.push({ kind: "paragraph", text: `\`\u22EF ${hidden} lines of code\`` });
        }
        break;
      case "list": {
        const all = items(block);
        const visible = all.filter((item) => applied === "brief" || item.indent === 0);
        if (applied === "brief" || applied === "points") {
          out.push({
            kind: "list",
            ordered: /^\d/.test(all[0]?.marker ?? ""),
            items: visible.map((item) => {
              const sentence = firstSentence(item.text);
              return { indent: item.indent, marker: item.marker, text: sentence.head, more: sentence.more };
            })
          });
        } else if (underHeading || applied === "gist" && first) {
          const item = visible[0];
          if (item) {
            const sentence = firstSentence(item.text);
            out.push({
              kind: "list",
              ordered: /^\d/.test(item.marker),
              items: [{ indent: 0, marker: item.marker, text: sentence.head, more: sentence.more || visible.length > 1 }]
            });
          }
          underHeading = false;
          first = false;
        }
        break;
      }
      case "quote":
      case "para": {
        const raw = block.lines.map((line) => (block.kind === "quote" ? line.replace(/^\s*>\s?/, "") : line).trim()).join(" ");
        if (applied !== "brief" && applied !== "points" && !underHeading) break;
        const sentence = sentences(raw, applied === "brief" ? 2 : 1);
        out.push({
          kind: block.kind === "quote" ? "quote" : "paragraph",
          text: sentence.text + (sentence.more ? MORE : "")
        });
        underHeading = false;
        first = false;
        break;
      }
      default:
        break;
    }
  }
  const text = out.map(blockText).join("\n\n");
  return {
    requested_level: requested,
    level: applied,
    text,
    blocks: out,
    total,
    shown: words(text),
    changed: text !== source
  };
}

// client/reply-fold.js
var FOLD_LEVELS = ["full", "brief", "points", "outline", "gist"];
var LEVEL_LABELS = { full: "Full", brief: "Brief", points: "Points", outline: "Outline", gist: "Gist" };
var FOLD_STORAGE_KEY = "ah-fold-level";
var FOLD_TAB_ID = "academic-harness-reply-fold-pane";
function readFoldLevel() {
  try {
    const value = globalThis.localStorage?.getItem(FOLD_STORAGE_KEY);
    return FOLD_LEVELS.includes(value) ? value : "full";
  } catch {
    return "full";
  }
}
function writeFoldLevel(level) {
  if (!FOLD_LEVELS.includes(level)) return;
  try {
    globalThis.localStorage?.setItem(FOLD_STORAGE_KEY, level);
  } catch {
  }
}
function closingAssistantText(snapshot, turn) {
  if (!snapshot?.locations || !snapshot?.nodes || !Number.isInteger(turn)) return "";
  const keys = snapshot.locations.getTurn(turn) ?? [];
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const node = snapshot.nodes.get(keys[index]);
    if (node?.kind !== "assistant-step") continue;
    const blocks2 = node.data?.finalNode?.blocks ?? node.data?.blocks ?? [];
    const text = blocks2.filter((block) => block?.kind === "text" && typeof block.text === "string").map((block) => block.text).join("\n\n").trim();
    if (text) return text;
  }
  return "";
}
var INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)]+\))/g;
function renderInline(text, prefix) {
  const input = String(text ?? "");
  if (!input) return [];
  const out = [];
  let last = 0;
  let n = 0;
  for (const match of input.matchAll(INLINE)) {
    if (match.index > last) out.push(input.slice(last, match.index));
    const token = match[0];
    const key = `${prefix}-${n++}`;
    if (token.startsWith("`")) {
      out.push((0, import_react3.createElement)("code", { key, style: inlineCodeStyle }, token.slice(1, -1)));
    } else if (token.startsWith("**")) {
      out.push((0, import_react3.createElement)("strong", { key }, renderInline(token.slice(2, -2), `${key}-b`)));
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      out.push(link ? (0, import_react3.createElement)("span", { key, title: link[2] }, renderInline(link[1], `${key}-l`)) : token);
    } else {
      out.push((0, import_react3.createElement)("em", { key }, renderInline(token.slice(1, -1), `${key}-i`)));
    }
    last = match.index + token.length;
  }
  if (last < input.length) out.push(input.slice(last));
  return out;
}
function renderBlock(block, index) {
  switch (block.kind) {
    case "heading": {
      const text = String(block.lines?.[0] ?? "").replace(/^#{1,6}\s+/, "");
      const level = Math.min(6, Math.max(1, Number(block.level) || 2));
      return (0, import_react3.createElement)("div", {
        key: `h${index}`,
        role: "heading",
        "aria-level": level,
        style: headingStyle
      }, renderInline(text, `h${index}`));
    }
    case "paragraph":
      return (0, import_react3.createElement)("p", { key: `p${index}`, style: paragraphStyle }, renderInline(block.text, `p${index}`));
    case "quote":
      return (0, import_react3.createElement)("blockquote", { key: `q${index}`, style: quoteStyle }, renderInline(block.text, `q${index}`));
    case "list": {
      const items2 = (block.items ?? []).map((item, n) => (0, import_react3.createElement)("li", {
        key: `li${index}-${n}`,
        style: { marginLeft: item.indent ? item.indent * 8 : 0 }
      }, renderInline(`${item.text}${item.more ? " \u2026" : ""}`, `li${index}-${n}`)));
      return (0, import_react3.createElement)(block.ordered ? "ol" : "ul", { key: `l${index}`, style: listStyle }, items2);
    }
    case "table": {
      const rows = block.rows ?? [];
      if (!rows.length) return (0, import_react3.createElement)("pre", { key: `t${index}`, style: codeStyle }, (block.lines ?? []).join("\n"));
      const head = rows[0].map((cell, n) => (0, import_react3.createElement)("th", { key: `th${index}-${n}`, style: cellStyle }, renderInline(cell, `th${index}-${n}`)));
      const body = rows.slice(1).map((row2, r) => (0, import_react3.createElement)(
        "tr",
        { key: `tr${index}-${r}` },
        row2.map((cell, n) => (0, import_react3.createElement)("td", { key: `td${index}-${r}-${n}`, style: cellStyle }, renderInline(cell, `td${index}-${r}-${n}`)))
      ));
      return (0, import_react3.createElement)("table", { key: `t${index}`, style: tableStyle }, [
        (0, import_react3.createElement)("thead", { key: "head" }, (0, import_react3.createElement)("tr", null, head)),
        (0, import_react3.createElement)("tbody", { key: "body" }, body)
      ]);
    }
    case "code": {
      const lines = block.lines ?? [];
      const first = String(lines[0] ?? "").trim();
      const last = String(lines[lines.length - 1] ?? "").trim();
      const fenced = /^(`{3,}|~{3,})/.test(first) && /^(`{3,}|~{3,})/.test(last);
      const code = (fenced ? lines.slice(1, -1) : lines).join("\n");
      return (0, import_react3.createElement)("pre", { key: `c${index}`, style: codeStyle }, (0, import_react3.createElement)("code", null, code));
    }
    case "rule":
      return (0, import_react3.createElement)("hr", { key: `r${index}`, style: ruleStyle });
    default:
      return null;
  }
}
function FoldContent({ text, level }) {
  const source = typeof text === "string" ? text : "";
  const requested = FOLD_LEVELS.includes(level) ? level : "full";
  const folded = (0, import_react3.useMemo)(() => foldReply(source, requested), [source, requested]);
  const stats = foldStats(source, folded.text);
  const label = LEVEL_LABELS[folded.level] ?? "Brief";
  return (0, import_react3.createElement)("div", { "data-ah-fold-content": true, style: contentStyle }, [
    (0, import_react3.createElement)("div", { key: "blocks", style: blocksStyle }, (folded.blocks ?? []).map(renderBlock).filter(Boolean)),
    (0, import_react3.createElement)("div", { key: "footer", style: footerStyle }, `${label} \xB7 ${stats.words_after}/${stats.words_before} words`)
  ]);
}
function FoldLevelRow({
  level,
  onSelect,
  onOpenPane,
  label = "Read folded:",
  ariaLabel = "Read this reply folded",
  panelId
}) {
  const requested = FOLD_LEVELS.includes(level) ? level : "full";
  return (0, import_react3.createElement)("div", {
    "data-ah-fold-row": true,
    role: "group",
    "aria-label": ariaLabel,
    style: rowStyle
  }, [
    (0, import_react3.createElement)("span", { key: "label", style: labelStyle }, label),
    ...FOLD_LEVELS.map((name) => (0, import_react3.createElement)("button", {
      key: name,
      type: "button",
      "aria-pressed": requested === name,
      "aria-expanded": requested === name ? requested !== "full" : void 0,
      "aria-controls": panelId && requested === name && requested !== "full" ? panelId : void 0,
      onClick: () => onSelect?.(name),
      style: requested === name ? selectedButtonStyle : buttonStyle
    }, LEVEL_LABELS[name])),
    onOpenPane ? (0, import_react3.createElement)("button", {
      key: "pane",
      type: "button",
      onClick: () => onOpenPane(requested),
      style: paneActionStyle
    }, "Open in sidebar") : null
  ]);
}
function ReplyFoldView({ text, level, onSelect, onOpenPane }) {
  const source = typeof text === "string" ? text : "";
  const requested = FOLD_LEVELS.includes(level) ? level : "full";
  const panelId = (0, import_react3.useId)();
  const gist = (0, import_react3.useMemo)(() => foldReply(source, "gist"), [source]);
  const applied = (0, import_react3.useMemo)(() => requested === "full" ? null : foldReply(source, requested), [source, requested]);
  if (!source.trim() || !gist.text.trim() || !worthFolding(source, gist.text)) return null;
  const label = applied ? LEVEL_LABELS[applied.level] ?? "Brief" : "";
  const row2 = (0, import_react3.createElement)(FoldLevelRow, {
    level: requested,
    onSelect,
    panelId,
    onOpenPane: onOpenPane ? (nextLevel) => onOpenPane({ text: source, level: nextLevel }) : void 0
  });
  const panel = requested === "full" ? null : (0, import_react3.createElement)("div", {
    id: panelId,
    "data-ah-fold-panel": true,
    role: "region",
    "aria-label": `Folded reply, ${label} level`,
    style: panelStyle
  }, (0, import_react3.createElement)(FoldContent, { text: source, level: requested }));
  return (0, import_react3.createElement)("div", { "data-ah-fold-root": true, style: rootStyle }, row2, panel);
}
var rootStyle = { marginTop: 6, color: "inherit", fontFamily: "inherit" };
var rowStyle = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, fontSize: "0.78em", lineHeight: 1.4, opacity: 0.85 };
var labelStyle = { opacity: 0.55, marginRight: 2 };
var buttonStyle = {
  border: "1px solid transparent",
  background: "transparent",
  color: "inherit",
  borderRadius: 999,
  padding: "1px 8px",
  fontFamily: "inherit",
  fontSize: "1em",
  cursor: "pointer",
  opacity: 0.7
};
var selectedButtonStyle = {
  ...buttonStyle,
  background: "var(--color-surface-tertiary, rgba(127,127,127,0.18))",
  borderColor: "var(--color-border, rgba(127,127,127,0.28))",
  opacity: 1
};
var panelStyle = {
  marginTop: 6,
  padding: "8px 10px",
  border: "1px solid var(--color-border, rgba(127,127,127,0.22))",
  borderRadius: 8,
  background: "var(--color-surface-secondary, rgba(127,127,127,0.07))",
  fontSize: "0.92em",
  lineHeight: 1.55
};
var blocksStyle = { display: "flex", flexDirection: "column", gap: 6 };
var contentStyle = { display: "flex", flexDirection: "column", gap: 6 };
var paneActionStyle = {
  marginLeft: "auto",
  border: "none",
  background: "transparent",
  color: "inherit",
  fontFamily: "inherit",
  fontSize: "0.95em",
  cursor: "pointer",
  opacity: 0.6,
  textDecoration: "underline",
  padding: "1px 2px"
};
var headingStyle = { margin: 0, fontWeight: 600, fontSize: "1em", lineHeight: 1.4 };
var paragraphStyle = { margin: 0 };
var quoteStyle = { margin: 0, paddingLeft: 10, borderLeft: "3px solid var(--color-border, rgba(127,127,127,0.3))", opacity: 0.9 };
var listStyle = { margin: 0, paddingLeft: "1.25em" };
var inlineCodeStyle = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "0.92em",
  padding: "0 3px",
  borderRadius: 4,
  background: "var(--color-surface-tertiary, rgba(127,127,127,0.14))"
};
var codeStyle = {
  margin: 0,
  padding: 8,
  borderRadius: 6,
  background: "var(--color-surface-tertiary, rgba(127,127,127,0.12))",
  overflowX: "auto",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "0.9em",
  lineHeight: 1.45
};
var tableStyle = { borderCollapse: "collapse", width: "100%", fontSize: "0.92em" };
var cellStyle = { border: "1px solid var(--color-border, rgba(127,127,127,0.22))", padding: "3px 6px", textAlign: "left", verticalAlign: "top" };
var ruleStyle = { border: 0, borderTop: "1px solid var(--color-border, rgba(127,127,127,0.25))", margin: "4px 0" };
var footerStyle = { marginTop: 6, opacity: 0.55, fontSize: "0.85em" };

// client/FoldPane.js
function FoldPane({ useTabInfo }) {
  const info = useTabInfo();
  const navigation = info?.tab?.navigation;
  const params = navigation?.params ?? {};
  const text = typeof params.text === "string" ? params.text : "";
  const requested = FOLD_LEVELS.includes(params.level) ? params.level : readFoldLevel();
  const revision = navigation?.revision ?? 0;
  const [level, setLevel] = (0, import_react4.useState)(requested);
  (0, import_react4.useEffect)(() => {
    setLevel(requested);
  }, [revision, requested]);
  const select = (next) => {
    setLevel(next);
    writeFoldLevel(next);
  };
  if (!text) {
    return (0, import_react4.createElement)("div", { style: emptyStyle }, [
      "Open a reply with ",
      (0, import_react4.createElement)("strong", { key: "strong" }, "Open in sidebar"),
      " to read it here at another level."
    ]);
  }
  return (0, import_react4.createElement)("div", { "data-ah-fold-pane": FOLD_TAB_ID, style: paneStyle }, [
    (0, import_react4.createElement)("div", { key: "header", style: headerStyle }, [
      (0, import_react4.createElement)("span", { key: "title", style: titleStyle }, "Read folded"),
      (0, import_react4.createElement)("span", { key: "hint", style: hintStyle }, "Chat reply, at the level you choose")
    ]),
    (0, import_react4.createElement)(FoldLevelRow, {
      key: "levels",
      level,
      onSelect: select,
      label: "Level:",
      ariaLabel: "Folded reply level"
    }),
    (0, import_react4.createElement)(
      "div",
      { key: "content", style: contentStyle2 },
      (0, import_react4.createElement)(FoldContent, { text, level })
    )
  ]);
}
var paneStyle = {
  height: "100%",
  boxSizing: "border-box",
  padding: "14px 16px",
  overflow: "auto",
  color: "inherit",
  fontFamily: "inherit"
};
var headerStyle = { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 };
var titleStyle = { fontWeight: 600, fontSize: "0.95em" };
var hintStyle = { opacity: 0.55, fontSize: "0.8em" };
var contentStyle2 = { marginTop: 10, fontSize: "0.95em", lineHeight: 1.55 };
var emptyStyle = { padding: 16, opacity: 0.65, fontSize: "0.9em", lineHeight: 1.5 };

// client/ReplyFold.jsx
var import_react5 = require("react");
var import_jsx_runtime3 = require("react/jsx-runtime");
function ReplyFold({ turn, useChat, openFoldPane }) {
  const turnNumber = turn && typeof turn === "object" ? turn.turn : turn;
  const text = useChat((snapshot) => closingAssistantText(snapshot, turnNumber));
  const [level, setLevel] = (0, import_react5.useState)(readFoldLevel);
  const select = (next) => {
    setLevel(next);
    writeFoldLevel(next);
  };
  const openPane = openFoldPane ? (payload) => {
    try {
      openFoldPane(payload);
    } catch (error) {
      console.warn("[academic-harness] could not open the fold pane", error);
    }
  } : void 0;
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(ReplyFoldView, { text, level, onSelect: select, onOpenPane: openPane });
}

// task-modes.js
var TASK_COMMAND = "academic-task";
var RESEARCH_TOKEN = "/research";
var REVIEW_TOKEN = "/review";
var PAPERS_TOKEN = "/papers";
var REFERENCES_TOKEN = "/references";
var WRITE_TOKEN = "/write";
var ANALYZE_TOKEN = "/analyze";
var HYPOTHESES_TOKEN = "/hypotheses";
var TASK_EFFORTS = Object.freeze(["auto", "low", "medium", "high"]);
var REVIEW_TOPOLOGY = Object.freeze({ low: "LOW", medium: "MID", high: "HIGH" });
var PAPER_LIMITS = Object.freeze({ low: 10, medium: 20, high: 50 });
var AUDIT_LIMITS = Object.freeze({ low: 25, medium: 100, high: 250 });
var REVISION_COMPILE = Object.freeze({ low: false, medium: true, high: true });
var HYPOTHESIS_LIMITS = Object.freeze({ low: 3, medium: 5, high: 8 });
var TASK_TOKENS = Object.freeze({
  deep_research: RESEARCH_TOKEN,
  deep_review: REVIEW_TOKEN,
  find_papers: PAPERS_TOKEN,
  check_references: REFERENCES_TOKEN,
  write_revise: WRITE_TOKEN,
  analyze_data: ANALYZE_TOKEN,
  generate_hypotheses: HYPOTHESES_TOKEN
});
var TASK_MODES = Object.freeze([
  { id: "deep_research", label: "Deep Research", phase: 1, enabled: true },
  { id: "deep_review", label: "Deep Review", phase: 2, enabled: true },
  { id: "find_papers", label: "Find Papers", phase: 3, enabled: true },
  { id: "check_references", label: "Check References", phase: 4, enabled: true },
  { id: "write_revise", label: "Write / Revise", phase: 5, enabled: true },
  { id: "analyze_data", label: "Analyze Data", phase: 6, enabled: true },
  { id: "generate_hypotheses", label: "Generate Hypotheses", phase: 7, enabled: true }
].map(Object.freeze));
function taskToken(task) {
  const token = TASK_TOKENS[task];
  if (!token) throw new Error("task is not available");
  return token;
}
function taskForToken(token) {
  const normalized = String(token ?? "").trim();
  return Object.entries(TASK_TOKENS).find(([, value]) => value === normalized)?.[0];
}
function object(value, label, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} contains unknown fields`);
}
function validateTaskRequest(value) {
  object(value, "task request", ["version", "request_id", "task", "prompt", "options"]);
  if (value.version !== 1) throw new Error("unsupported task request version");
  if (typeof value.request_id !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/u.test(value.request_id)) {
    throw new Error("task request_id must contain 16\u2013100 letters, digits, dashes, or underscores");
  }
  if (!TASK_MODES.some((mode) => mode.id === value.task && mode.enabled)) throw new Error("task is not available");
  if (typeof value.prompt !== "string" || !value.prompt.trim()) {
    const empty = {
      deep_review: "enter a manuscript path first",
      find_papers: "enter a search query first",
      check_references: "enter a bibliography path first",
      write_revise: "enter the two manuscript paths first",
      analyze_data: "enter an analysis question first",
      generate_hypotheses: "enter a research goal first"
    };
    throw new Error(empty[value.task] || "enter a research question first");
  }
  if (value.prompt.length > 64e3) throw new Error("research prompt exceeds 64000 characters");
  const options = value.options ?? {};
  object(options, "task options", ["effort"]);
  const effort = options.effort ?? "auto";
  if (!TASK_EFFORTS.includes(effort)) throw new Error("effort must be auto, low, medium, or high");
  return { version: 1, request_id: value.request_id, task: value.task, prompt: value.prompt, options: { effort } };
}
function taskCommandLine(request) {
  return `/${TASK_COMMAND} ${JSON.stringify(validateTaskRequest(request))}`;
}

// client/task-mode-store.js
function createTaskModeStore({ sessionId, storage } = {}) {
  try {
    storage ??= globalThis.sessionStorage;
  } catch {
  }
  const key = `academic-harness.task-draft.v1.${sessionId}`;
  let restored;
  try {
    restored = JSON.parse(storage?.getItem(key) ?? "null");
  } catch {
  }
  let snapshot = { available: false, loading: true, effort: "auto", error: null, lastTask: null, inTranscript: false };
  let request = null;
  try {
    if (restored?.request) {
      request = validateTaskRequest(restored.request);
      snapshot.effort = request.options.effort;
    }
  } catch {
  }
  const listeners = /* @__PURE__ */ new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(patch) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of [...listeners]) listener();
    },
    getRequest: () => request,
    setRequest(value) {
      request = value;
      try {
        if (value) storage?.setItem(key, JSON.stringify({ request: value }));
        else storage?.removeItem(key);
      } catch {
      }
    }
  };
}

// client/task-selector.js
var import_react6 = require("react");
var import_react_dom = require("react-dom");
var row = { display: "inline-flex", alignItems: "center", gap: 4, maxWidth: "100%", flexWrap: "wrap" };
var segment = { font: "inherit", fontSize: 11, lineHeight: "16px", minHeight: 24, padding: "1px 6px", border: 0, borderRadius: 0, color: "inherit", background: "transparent", cursor: "pointer", whiteSpace: "nowrap" };
var chip = { display: "inline-flex", alignItems: "stretch", flex: "0 0 auto", position: "relative", border: "1px solid var(--dsw-border, var(--color-border, currentColor))", borderRadius: 6 };
var menu = { position: "fixed", zIndex: 1e3, minWidth: 190, padding: 4, borderRadius: 10, border: "1px solid var(--dsw-border, var(--color-border, currentColor))", background: "var(--dsw-surface-overlay, var(--dsw-bg-elevated, var(--color-surface-secondary, Canvas)))", boxShadow: "0 8px 24px rgba(0,0,0,0.28)" };
var menuRow = { display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", gap: 12, font: "inherit", fontSize: 12, padding: "7px 9px", border: 0, borderRadius: 7, color: "inherit", background: "transparent", textAlign: "left", cursor: "pointer" };
var MENU_WIDTH = 190;
var MENU_ROW_HEIGHT = 31;
var TASK_CHROME = {
  deep_research: { description: "researchDescription", effort: "effort", current: "effort.current", started: "started", notice: "costNotice" },
  deep_review: { description: "reviewDescription", effort: "depth", current: "depth.current", started: "startedReview", notice: "costNoticeReview" },
  find_papers: { description: "papersDescription", effort: "breadth", current: "breadth.current", started: "startedPapers", notice: "costNoticePapers" },
  check_references: { description: "referencesDescription", effort: "scope", current: "scope.current", started: "startedReferences", notice: "costNoticeReferences" },
  write_revise: { description: "writeDescription", effort: "effort", current: "compile.current", started: "startedWrite", notice: "costNoticeWrite" },
  analyze_data: { description: "analyzeDescription", effort: null, current: null, started: "startedAnalyze", notice: "costNoticeAnalyze" },
  generate_hypotheses: { description: "hypothesesDescription", effort: "ideas", current: "ideas.current", started: "startedHypotheses", notice: "costNoticeHypotheses" }
};
function taskChrome(id) {
  return TASK_CHROME[id] || TASK_CHROME.deep_research;
}
function EffortMenu({ effort, disabled, onEffort, t, labelKey = "effort", currentKey = "effort.current" }) {
  const [open, setOpen] = (0, import_react6.useState)(false);
  const [position, setPosition] = (0, import_react6.useState)(null);
  const [active, setActive] = (0, import_react6.useState)(() => Math.max(0, TASK_EFFORTS.indexOf(effort)));
  const trigger = (0, import_react6.useRef)(null);
  const list = (0, import_react6.useRef)(null);
  const rows = (0, import_react6.useRef)([]);
  const id = (0, import_react6.useId)();
  (0, import_react6.useEffect)(() => {
    if (!open) {
      setPosition(null);
      return void 0;
    }
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 8;
      const height = TASK_EFFORTS.length * MENU_ROW_HEIGHT + 8;
      const left = Math.min(Math.max(rect.right - MENU_WIDTH, margin), window.innerWidth - MENU_WIDTH - margin);
      const below = rect.bottom + 6;
      const top = below + height <= window.innerHeight - margin ? below : Math.max(margin, rect.top - height - 6);
      setPosition({ left, top });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);
  const ready = position !== null;
  (0, import_react6.useEffect)(() => {
    if (open && ready) rows.current[Math.max(0, TASK_EFFORTS.indexOf(effort))]?.focus();
  }, [open, ready, effort]);
  (0, import_react6.useEffect)(() => {
    if (!open) return void 0;
    const onPointerDown = (event) => {
      if (trigger.current?.contains(event.target) || list.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown2 = (event) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      queueMicrotask(() => trigger.current?.focus());
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown2);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown2);
    };
  }, [open]);
  const choose = (level) => {
    onEffort(level);
    setOpen(false);
    queueMicrotask(() => trigger.current?.focus());
  };
  const show = () => {
    setActive(Math.max(0, TASK_EFFORTS.indexOf(effort)));
    setOpen(true);
  };
  const onKeyDown = (event) => {
    if (!open || event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const next = (active + (event.key === "ArrowDown" ? 1 : -1) + TASK_EFFORTS.length) % TASK_EFFORTS.length;
    setActive(next);
    rows.current[next]?.focus();
  };
  return (0, import_react6.createElement)("span", { style: { display: "inline-flex" }, onKeyDown, "data-ah-effort-menu": true }, [
    (0, import_react6.createElement)("button", {
      key: "trigger",
      ref: trigger,
      type: "button",
      style: { ...segment, borderLeft: "1px solid var(--dsw-border, var(--color-border, currentColor))", paddingLeft: 5 },
      disabled,
      "aria-label": t(currentKey, { effort: t(`effort.${effort}`) }),
      "aria-haspopup": "menu",
      "aria-expanded": open,
      "aria-controls": open ? id : void 0,
      onClick: () => {
        if (open) setOpen(false);
        else show();
      }
    }, `${t(`effort.${effort}`)} \u25BE`),
    open && position ? (0, import_react_dom.createPortal)((0, import_react6.createElement)("div", {
      key: "menu",
      ref: list,
      id,
      role: "menu",
      "aria-label": t(labelKey),
      style: { ...menu, left: position.left, top: position.top }
    }, TASK_EFFORTS.map((level, index) => (0, import_react6.createElement)("button", {
      key: level,
      ref: (node) => {
        rows.current[index] = node;
      },
      type: "button",
      role: "menuitemradio",
      "aria-checked": effort === level,
      tabIndex: active === index ? 0 : -1,
      style: { ...menuRow, background: active === index ? "var(--dsw-bg-active, var(--color-surface-secondary, transparent))" : "transparent" },
      onMouseEnter: () => setActive(index),
      onFocus: () => setActive(index),
      onClick: () => choose(level)
    }, [
      (0, import_react6.createElement)("span", { key: "label" }, t(`effort.${level}`)),
      effort === level ? (0, import_react6.createElement)("span", { key: "check", "aria-hidden": true }, "\u2713") : null
    ]))), document.body) : null
  ]);
}
function TaskSelectorView({ selected, effort, available, loading, locked, planActive, disabled, onSelect, onEffort, t }) {
  const modes = TASK_MODES.filter((mode) => mode.enabled);
  const selectedFill = "var(--dsw-alias-button-primary-fill, var(--dsw-alias-interactive-bg-active, #fff))";
  const selectedInk = "var(--dsw-alias-label-primary-foreground, #000)";
  return (0, import_react6.createElement)("span", { style: row, "data-ah-task-selector": true }, modes.map((mode) => {
    const isSelected = selected === mode.id;
    const chrome = taskChrome(mode.id);
    const unusable = (planActive || !available) && !isSelected;
    const reason = planActive ? "planBlocked" : loading ? "loading" : !available ? "unavailable" : chrome.description;
    return (0, import_react6.createElement)("span", {
      key: mode.id,
      "data-ah-task": mode.id,
      style: {
        ...chip,
        background: isSelected ? selectedFill : "transparent",
        color: isSelected ? selectedInk : "inherit",
        borderColor: isSelected ? selectedFill : "var(--dsw-border, var(--color-border, currentColor))"
      }
    }, [
      (0, import_react6.createElement)("button", {
        key: "task",
        type: "button",
        "aria-pressed": isSelected,
        disabled: locked || unusable,
        onClick: () => onSelect(mode.id),
        title: t(reason),
        style: { ...segment, fontWeight: isSelected ? 600 : 400 }
      }, `${isSelected ? "\u2713 " : ""}${t(mode.id)}`),
      isSelected && chrome.effort ? (0, import_react6.createElement)(EffortMenu, {
        key: "effort",
        effort,
        disabled: disabled ?? locked,
        onEffort,
        t,
        labelKey: chrome.effort,
        currentKey: chrome.current
      }) : null
    ]);
  }));
}
function TaskSelector({ useInput, useTaskMode, useProjection, selectTask, setEffort, t }) {
  const phase = useInput((input) => input.phase);
  const token = useInput((input) => input.claim?.token);
  const plan = useProjection("plan");
  const state = useTaskMode((value) => value);
  const frozen = !["plain", "claimed"].includes(phase);
  return (0, import_react6.createElement)(TaskSelectorView, {
    ...state,
    selected: taskForToken(token) ?? null,
    locked: frozen,
    disabled: frozen,
    planActive: Boolean(plan && (plan.active || plan.pending)),
    onSelect: selectTask,
    onEffort: setEffort,
    t
  });
}
var RECEIPT_IDS = /(?:Research run|Review|Papers|References|Diff|Analysis|Tournament):\s*(\S+)/u;
function taskReceiptFromCommand(node) {
  const text = typeof node?.outcome?.text === "string" ? node.outcome.text : "";
  let request = null;
  try {
    request = JSON.parse(String(node?.args ?? ""));
  } catch {
  }
  const task = TASK_CHROME[request?.task] ? request.task : "deep_research";
  const prompt = typeof request?.prompt === "string" ? request.prompt : "";
  const effort = TASK_EFFORTS.includes(request?.options?.effort) ? request.options.effort : "auto";
  const jobId = /Job:\s*(\S+)/u.exec(text)?.[1] ?? null;
  const runId = RECEIPT_IDS.exec(text)?.[1] ?? null;
  return { task, prompt, effort, jobId, runId };
}
function receiptPrompt(prompt) {
  const flat = String(prompt ?? "").replace(/[ \t]*\n[ \t]*/g, " \xB7 ").replace(/[ \t]+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}\u2026` : flat;
}
function TaskReceiptCard({ task, shown, meta, hint, dismiss, dismissLabel, transcript = false }) {
  return (0, import_react6.createElement)("div", {
    "data-ah-task-run": true,
    ...transcript ? { "data-ah-task-transcript": true } : {},
    role: "status",
    style: {
      display: "flex",
      alignItems: "flex-start",
      alignSelf: "center",
      gap: 8,
      margin: "6px auto",
      padding: "8px 10px",
      width: "min(100%, var(--dsh-composer-card-max-width, 46rem))",
      maxWidth: "var(--dsh-composer-card-max-width, 46rem)",
      boxSizing: "border-box",
      fontSize: 12,
      lineHeight: 1.45,
      border: "1px solid var(--dsw-alias-state-business-primary, var(--color-border, currentColor))",
      borderRadius: 8,
      background: "var(--dsw-alias-bg-layer-1, transparent)"
    }
  }, [
    (0, import_react6.createElement)("span", {
      key: "dot",
      "aria-hidden": true,
      style: { width: 8, height: 8, marginTop: 5, flex: "0 0 auto", borderRadius: "50%", background: "var(--dsw-alias-state-business-primary, #22c55e)" }
    }),
    (0, import_react6.createElement)("div", { key: "body", style: { display: "flex", flex: "1 1 auto", flexDirection: "column", gap: 2, minWidth: 0 } }, [
      (0, import_react6.createElement)("strong", { key: "title" }, task),
      (0, import_react6.createElement)("span", { key: "prompt", style: { overflowWrap: "anywhere" } }, shown),
      (0, import_react6.createElement)("span", { key: "meta", style: { opacity: 0.75, overflowWrap: "anywhere" } }, meta),
      (0, import_react6.createElement)("span", { key: "hint", style: { opacity: 0.75 } }, hint)
    ]),
    dismiss ? (0, import_react6.createElement)("button", {
      key: "dismiss",
      type: "button",
      onClick: dismiss,
      "aria-label": dismissLabel,
      title: dismissLabel,
      style: { border: 0, background: "transparent", color: "inherit", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }
    }, "\xD7") : null
  ]);
}
function TaskRunNotice({ useTaskMode, dismiss, t }) {
  const task = useTaskMode((state) => state.lastTask);
  const inTranscript = useTaskMode((state) => state.inTranscript);
  if (!task || inTranscript) return null;
  const meta = [t(`effort.${task.effort}`), task.runId, task.jobId].filter(Boolean).join(" \xB7 ");
  return TaskReceiptCard({
    task: t(taskChrome(task.task).started),
    shown: receiptPrompt(task.prompt),
    meta,
    hint: t("backgroundHint"),
    dismiss,
    dismissLabel: t("dismiss")
  });
}
function TaskCommandReceipt({ node, markInTranscript, t }) {
  (0, import_react6.useEffect)(() => {
    markInTranscript?.();
  }, [markInTranscript]);
  if (node?.outcome?.kind === "error") {
    return (0, import_react6.createElement)("div", {
      "data-ah-task-run": true,
      "data-ah-task-transcript": true,
      role: "alert",
      style: {
        margin: "6px auto",
        alignSelf: "center",
        boxSizing: "border-box",
        overflowWrap: "anywhere",
        width: "min(100%, var(--dsh-composer-card-max-width, 46rem))",
        maxWidth: "var(--dsh-composer-card-max-width, 46rem)",
        fontSize: 12,
        lineHeight: 1.45
      }
    }, node.outcome.text || "");
  }
  const receipt = taskReceiptFromCommand(node);
  const meta = [t(`effort.${receipt.effort}`), receipt.runId, receipt.jobId].filter(Boolean).join(" \xB7 ");
  return TaskReceiptCard({
    task: t(taskChrome(receipt.task).started),
    shown: receiptPrompt(receipt.prompt),
    meta,
    hint: t("backgroundHint"),
    transcript: true
  });
}
function TaskSelectorStatus({ useInput, useTaskMode, t }) {
  const selected = taskForToken(useInput((input) => input.claim?.token));
  const error = useTaskMode((state) => state.error);
  if (!selected && !error) return null;
  const notice = taskChrome(selected).notice;
  return (0, import_react6.createElement)("p", {
    "data-ah-task-status": true,
    role: error ? "alert" : "status",
    style: {
      // The dock slot is a flex child of the full-width composer stack. Match
      // the input card: side clearance on a narrow column, the card cap when
      // the column is wider, centered either way.
      margin: "6px auto",
      alignSelf: "center",
      boxSizing: "border-box",
      width: "calc(100% - 2 * var(--dsh-composer-side-clearance, 16px))",
      maxWidth: "var(--dsh-composer-card-max-width, 46rem)",
      fontSize: 12,
      lineHeight: 1.5,
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere"
    }
  }, error || t(notice));
}

// client/task-modes.js
var en = {
  deep_research: "Deep Research",
  deep_review: "Deep Review",
  find_papers: "Find Papers",
  check_references: "Check References",
  write_revise: "Write / Revise",
  analyze_data: "Analyze Data",
  generate_hypotheses: "Generate Hypotheses",
  effort: "Effort",
  depth: "Depth",
  breadth: "Results",
  scope: "Checks",
  ideas: "Ideas",
  "effort.auto": "Auto",
  "effort.low": "Low",
  "effort.medium": "Medium",
  "effort.high": "High",
  "effort.current": "Deep Research effort: {effort}",
  "depth.current": "Deep Review depth: {effort}",
  "breadth.current": "Find Papers results: {effort}",
  "scope.current": "Check References online checks: {effort}",
  "compile.current": "Write / Revise compile: {effort}",
  "ideas.current": "Generate Hypotheses cap: {effort}",
  started: "Deep Research started",
  startedReview: "Deep Review started",
  startedPapers: "Find Papers started",
  startedReferences: "Check References started",
  startedWrite: "Write / Revise started",
  startedAnalyze: "Analyze Data started",
  startedHypotheses: "Generate Hypotheses started",
  backgroundHint: "Follow live status in Background tasks",
  dismiss: "Dismiss",
  researchDescription: "Select a cited, multi-step investigation. Send starts the task; click again to return to Chat.",
  reviewDescription: "Select a multi-pass manuscript review. The first line is a workspace path; later lines are optional focus. Send starts the review; click again to return to Chat.",
  papersDescription: "Search the literature and return one merged list. Send starts the search; click again to return to Chat.",
  referencesDescription: "Audit a bibliography. The first line is a .bib, RIS, or CSL path; the second line is an optional manuscript. Send starts the check; click again to return to Chat.",
  writeDescription: "Compare an earlier manuscript with a revised one. Two paths, .tex, .md, or .txt. Neither file is edited. Send starts the diff; click again to return to Chat.",
  analyzeDescription: "Freeze an analysis plan from the question. A slug may go on the first line. No command runs. Send starts the plan; click again to return to Chat.",
  hypothesesDescription: "Open a hypothesis tournament for a goal. A slug may go on the first line. No hypothesis text is written. Send starts the ledger; click again to return to Chat.",
  costNotice: "Multi-step research uses extra time and tokens. Send starts one run.",
  costNoticeReview: "A deep review reads the whole manuscript and can take several minutes. Auto uses the engine default (MID, two passes). Low, Medium, and High pass LOW, MID, and HIGH. Send starts one review.",
  costNoticePapers: "Find Papers runs one literature search. Auto asks for the default 20 results. Low, Medium, and High ask for 10, 20, and 50. Send starts one search.",
  costNoticeReferences: "Check References audits the bibliography and looks up DOIs. Auto checks up to 100 online. Low, Medium, and High check 25, 100, and 250. Send starts one audit.",
  costNoticeWrite: "Write / Revise builds a diff of two manuscript versions and does not edit either file. Auto leaves TeX compilation at the tool default. Low skips the PDF. Medium and High compile it. Send starts one diff.",
  costNoticeAnalyze: "Analyze Data freezes the question as an analysis plan. It does not run a program or choose a statistical test. Send starts one plan.",
  costNoticeHypotheses: "Generate Hypotheses opens a tournament ledger. Auto keeps the default cap of 5. Low, Medium, and High cap the set at 3, 5, and 8. No hypothesis text is written. Send starts one tournament.",
  loading: "Checking tasks\u2026",
  unavailable: "Academic tasks are unavailable on this session\u2019s preset.",
  planBlocked: "Switch out of Plan mode before starting this task.",
  hint: "Enter the research question",
  hintReview: "Enter the manuscript path",
  hintPapers: "Enter what to find",
  hintReferences: "Enter the bibliography path",
  hintWrite: "Enter the earlier path, then the revised path",
  hintAnalyze: "Enter the analysis question",
  hintHypotheses: "Enter the research goal",
  attachments: "Deep Research takes a text question. Remove attachments before sending.",
  attachmentsReview: "Deep Review takes a manuscript path. Remove attachments before sending.",
  attachmentsPapers: "Find Papers takes a search query. Remove attachments before sending.",
  attachmentsReferences: "Check References takes a bibliography path. Remove attachments before sending.",
  attachmentsWrite: "Write / Revise takes two manuscript paths. Remove attachments before sending.",
  attachmentsAnalyze: "Analyze Data takes an analysis question. Remove attachments before sending.",
  attachmentsHypotheses: "Generate Hypotheses takes a research goal. Remove attachments before sending.",
  empty: "Enter a research question first.",
  emptyReview: "Enter a manuscript path first.",
  emptyPapers: "Enter a search query first.",
  emptyReferences: "Enter a bibliography path first.",
  emptyWrite: "Enter the two manuscript paths first.",
  emptyAnalyze: "Enter an analysis question first.",
  emptyHypotheses: "Enter a research goal first.",
  conflict: "Clear the current command before selecting a task.",
  changed: "The draft changed. Select the task again."
};
var zh = {
  deep_research: "\u6DF1\u5EA6\u7814\u7A76",
  deep_review: "\u6DF1\u5EA6\u8BC4\u5BA1",
  find_papers: "\u67E5\u627E\u8BBA\u6587",
  check_references: "\u68C0\u67E5\u53C2\u8003\u6587\u732E",
  write_revise: "\u5199\u4F5C / \u4FEE\u8BA2",
  analyze_data: "\u5206\u6790\u6570\u636E",
  generate_hypotheses: "\u751F\u6210\u5047\u8BBE",
  effort: "\u7814\u7A76\u5F3A\u5EA6",
  depth: "\u8BC4\u5BA1\u6DF1\u5EA6",
  breadth: "\u7ED3\u679C\u6570",
  scope: "\u6838\u67E5\u6570",
  ideas: "\u60F3\u6CD5\u6570",
  "effort.auto": "\u81EA\u52A8",
  "effort.low": "\u4F4E",
  "effort.medium": "\u4E2D",
  "effort.high": "\u9AD8",
  "effort.current": "\u6DF1\u5EA6\u7814\u7A76\u5F3A\u5EA6\uFF1A{effort}",
  "depth.current": "\u6DF1\u5EA6\u8BC4\u5BA1\u6DF1\u5EA6\uFF1A{effort}",
  "breadth.current": "\u67E5\u627E\u8BBA\u6587\u7ED3\u679C\u6570\uFF1A{effort}",
  "scope.current": "\u53C2\u8003\u6587\u732E\u5728\u7EBF\u6838\u67E5\uFF1A{effort}",
  "compile.current": "\u5199\u4F5C\u4FEE\u8BA2\u7F16\u8BD1\uFF1A{effort}",
  "ideas.current": "\u5047\u8BBE\u6570\u91CF\u4E0A\u9650\uFF1A{effort}",
  started: "\u6DF1\u5EA6\u7814\u7A76\u5DF2\u542F\u52A8",
  startedReview: "\u6DF1\u5EA6\u8BC4\u5BA1\u5DF2\u542F\u52A8",
  startedPapers: "\u8BBA\u6587\u67E5\u627E\u5DF2\u542F\u52A8",
  startedReferences: "\u53C2\u8003\u6587\u732E\u68C0\u67E5\u5DF2\u542F\u52A8",
  startedWrite: "\u5199\u4F5C\u4FEE\u8BA2\u5DF2\u542F\u52A8",
  startedAnalyze: "\u6570\u636E\u5206\u6790\u5DF2\u542F\u52A8",
  startedHypotheses: "\u5047\u8BBE\u751F\u6210\u5DF2\u542F\u52A8",
  backgroundHint: "\u8BF7\u5728\u540E\u53F0\u4EFB\u52A1\u4E2D\u67E5\u770B\u5B9E\u65F6\u72B6\u6001",
  dismiss: "\u5173\u95ED",
  researchDescription: "\u9009\u62E9\u5E26\u5F15\u7528\u7684\u591A\u6B65\u9AA4\u7814\u7A76\u3002\u53D1\u9001\u540E\u5F00\u59CB\uFF1B\u518D\u6B21\u70B9\u51FB\u8FD4\u56DE\u666E\u901A\u804A\u5929\u3002",
  reviewDescription: "\u9009\u62E9\u591A\u8F6E\u6587\u7A3F\u8BC4\u5BA1\u3002\u7B2C\u4E00\u884C\u662F\u5DE5\u4F5C\u533A\u8DEF\u5F84\uFF0C\u540E\u7EED\u884C\u662F\u53EF\u9009\u5173\u6CE8\u70B9\u3002\u53D1\u9001\u540E\u5F00\u59CB\uFF1B\u518D\u6B21\u70B9\u51FB\u8FD4\u56DE\u666E\u901A\u804A\u5929\u3002",
  papersDescription: "\u68C0\u7D22\u6587\u732E\u5E76\u8FD4\u56DE\u4E00\u4EFD\u5408\u5E76\u5217\u8868\u3002\u53D1\u9001\u540E\u5F00\u59CB\uFF1B\u518D\u6B21\u70B9\u51FB\u8FD4\u56DE\u666E\u901A\u804A\u5929\u3002",
  referencesDescription: "\u5BA1\u8BA1\u53C2\u8003\u6587\u732E\u3002\u7B2C\u4E00\u884C\u662F .bib\u3001RIS \u6216 CSL \u8DEF\u5F84\uFF0C\u7B2C\u4E8C\u884C\u662F\u53EF\u9009\u6587\u7A3F\u3002\u53D1\u9001\u540E\u5F00\u59CB\uFF1B\u518D\u6B21\u70B9\u51FB\u8FD4\u56DE\u666E\u901A\u804A\u5929\u3002",
  writeDescription: "\u6BD4\u8F83\u4FEE\u8BA2\u524D\u540E\u7684\u6587\u7A3F\u3002\u4E24\u884C\u8DEF\u5F84\uFF0C.tex\u3001.md \u6216 .txt\u3002\u4E0D\u4F1A\u4FEE\u6539\u6587\u4EF6\u3002\u53D1\u9001\u540E\u5F00\u59CB\uFF1B\u518D\u6B21\u70B9\u51FB\u8FD4\u56DE\u666E\u901A\u804A\u5929\u3002",
  analyzeDescription: "\u628A\u95EE\u9898\u51BB\u7ED3\u4E3A\u5206\u6790\u8BA1\u5212\u3002\u7B2C\u4E00\u884C\u53EF\u4EE5\u662F\u77ED\u6807\u8BC6\u3002\u4E0D\u4F1A\u8FD0\u884C\u547D\u4EE4\u3002\u53D1\u9001\u540E\u5F00\u59CB\uFF1B\u518D\u6B21\u70B9\u51FB\u8FD4\u56DE\u666E\u901A\u804A\u5929\u3002",
  hypothesesDescription: "\u4E3A\u4E00\u4E2A\u76EE\u6807\u6253\u5F00\u5047\u8BBE\u9526\u6807\u8D5B\u3002\u7B2C\u4E00\u884C\u53EF\u4EE5\u662F\u77ED\u6807\u8BC6\u3002\u4E0D\u4F1A\u5199\u4E0B\u5047\u8BBE\u6B63\u6587\u3002\u53D1\u9001\u540E\u5F00\u59CB\uFF1B\u518D\u6B21\u70B9\u51FB\u8FD4\u56DE\u666E\u901A\u804A\u5929\u3002",
  costNotice: "\u591A\u6B65\u9AA4\u7814\u7A76\u9700\u8981\u66F4\u591A\u65F6\u95F4\u548C token\u3002\u53D1\u9001\u540E\u5F00\u59CB\u4E00\u6B21\u7814\u7A76\u3002",
  costNoticeReview: "\u6DF1\u5EA6\u8BC4\u5BA1\u4F1A\u901A\u8BFB\u6574\u7BC7\u6587\u7A3F\uFF0C\u53EF\u80FD\u9700\u8981\u6570\u5206\u949F\u3002\u81EA\u52A8\u4F7F\u7528\u5F15\u64CE\u9ED8\u8BA4\u6DF1\u5EA6\uFF08MID\uFF0C\u4E24\u8F6E\uFF09\u3002\u4F4E\u3001\u4E2D\u3001\u9AD8\u5206\u522B\u5BF9\u5E94 LOW\u3001MID\u3001HIGH\u3002\u53D1\u9001\u540E\u5F00\u59CB\u4E00\u6B21\u8BC4\u5BA1\u3002",
  costNoticePapers: "\u67E5\u627E\u8BBA\u6587\u4F1A\u6267\u884C\u4E00\u6B21\u6587\u732E\u68C0\u7D22\u3002\u81EA\u52A8\u4F7F\u7528\u9ED8\u8BA4\u7684 20 \u6761\u7ED3\u679C\u3002\u4F4E\u3001\u4E2D\u3001\u9AD8\u5206\u522B\u4E3A 10\u300120\u300150 \u6761\u3002\u53D1\u9001\u540E\u5F00\u59CB\u4E00\u6B21\u68C0\u7D22\u3002",
  costNoticeReferences: "\u68C0\u67E5\u53C2\u8003\u6587\u732E\u4F1A\u5BA1\u8BA1\u4E66\u76EE\u5E76\u67E5\u8BE2 DOI\u3002\u81EA\u52A8\u6700\u591A\u5728\u7EBF\u6838\u67E5 100 \u6761\u3002\u4F4E\u3001\u4E2D\u3001\u9AD8\u5206\u522B\u4E3A 25\u3001100\u3001250 \u6761\u3002\u53D1\u9001\u540E\u5F00\u59CB\u4E00\u6B21\u5BA1\u8BA1\u3002",
  costNoticeWrite: "\u5199\u4F5C\u4FEE\u8BA2\u4F1A\u751F\u6210\u4E24\u4E2A\u6587\u7A3F\u7248\u672C\u7684\u5DEE\u5F02\uFF0C\u4E0D\u4F1A\u4FEE\u6539\u539F\u6587\u4EF6\u3002\u81EA\u52A8\u6CBF\u7528\u5DE5\u5177\u9ED8\u8BA4\u7684 TeX \u7F16\u8BD1\u3002\u4F4E\u8DF3\u8FC7 PDF\u3002\u4E2D\u548C\u9AD8\u4F1A\u7F16\u8BD1\u3002\u53D1\u9001\u540E\u5F00\u59CB\u4E00\u6B21\u6BD4\u8F83\u3002",
  costNoticeAnalyze: "\u5206\u6790\u6570\u636E\u4F1A\u628A\u95EE\u9898\u51BB\u7ED3\u4E3A\u5206\u6790\u8BA1\u5212\u3002\u4E0D\u4F1A\u8FD0\u884C\u7A0B\u5E8F\uFF0C\u4E5F\u4E0D\u4F1A\u9009\u62E9\u7EDF\u8BA1\u68C0\u9A8C\u3002\u53D1\u9001\u540E\u5F00\u59CB\u4E00\u4EFD\u8BA1\u5212\u3002",
  costNoticeHypotheses: "\u751F\u6210\u5047\u8BBE\u4F1A\u6253\u5F00\u9526\u6807\u8D5B\u8D26\u672C\u3002\u81EA\u52A8\u4FDD\u6301\u9ED8\u8BA4\u4E0A\u9650 5\u3002\u4F4E\u3001\u4E2D\u3001\u9AD8\u5206\u522B\u4E3A 3\u30015\u30018\u3002\u4E0D\u4F1A\u5199\u4E0B\u5047\u8BBE\u6B63\u6587\u3002\u53D1\u9001\u540E\u5F00\u59CB\u4E00\u6B21\u9526\u6807\u8D5B\u3002",
  loading: "\u6B63\u5728\u68C0\u67E5\u4EFB\u52A1\u2026",
  unavailable: "\u6B64\u4F1A\u8BDD\u7684\u9884\u8BBE\u4E0D\u652F\u6301\u8FD9\u4E9B\u5B66\u672F\u4EFB\u52A1\u3002",
  planBlocked: "\u5F00\u59CB\u6B64\u4EFB\u52A1\u524D\u8BF7\u5148\u9000\u51FA\u8BA1\u5212\u6A21\u5F0F\u3002",
  hint: "\u8F93\u5165\u7814\u7A76\u95EE\u9898",
  hintReview: "\u8F93\u5165\u6587\u7A3F\u8DEF\u5F84",
  hintPapers: "\u8F93\u5165\u8981\u67E5\u627E\u7684\u5185\u5BB9",
  hintReferences: "\u8F93\u5165\u53C2\u8003\u6587\u732E\u8DEF\u5F84",
  hintWrite: "\u5148\u8F93\u5165\u65E7\u8DEF\u5F84\uFF0C\u518D\u8F93\u5165\u4FEE\u8BA2\u540E\u8DEF\u5F84",
  hintAnalyze: "\u8F93\u5165\u5206\u6790\u95EE\u9898",
  hintHypotheses: "\u8F93\u5165\u7814\u7A76\u76EE\u6807",
  attachments: "\u6DF1\u5EA6\u7814\u7A76\u63A5\u53D7\u6587\u672C\u95EE\u9898\uFF0C\u8BF7\u5148\u79FB\u9664\u9644\u4EF6\u3002",
  attachmentsReview: "\u6DF1\u5EA6\u8BC4\u5BA1\u63A5\u53D7\u6587\u7A3F\u8DEF\u5F84\uFF0C\u8BF7\u5148\u79FB\u9664\u9644\u4EF6\u3002",
  attachmentsPapers: "\u67E5\u627E\u8BBA\u6587\u63A5\u53D7\u68C0\u7D22\u8BCD\uFF0C\u8BF7\u5148\u79FB\u9664\u9644\u4EF6\u3002",
  attachmentsReferences: "\u68C0\u67E5\u53C2\u8003\u6587\u732E\u63A5\u53D7\u4E66\u76EE\u8DEF\u5F84\uFF0C\u8BF7\u5148\u79FB\u9664\u9644\u4EF6\u3002",
  attachmentsWrite: "\u5199\u4F5C\u4FEE\u8BA2\u63A5\u53D7\u4E24\u4E2A\u6587\u7A3F\u8DEF\u5F84\uFF0C\u8BF7\u5148\u79FB\u9664\u9644\u4EF6\u3002",
  attachmentsAnalyze: "\u5206\u6790\u6570\u636E\u63A5\u53D7\u5206\u6790\u95EE\u9898\uFF0C\u8BF7\u5148\u79FB\u9664\u9644\u4EF6\u3002",
  attachmentsHypotheses: "\u751F\u6210\u5047\u8BBE\u63A5\u53D7\u7814\u7A76\u76EE\u6807\uFF0C\u8BF7\u5148\u79FB\u9664\u9644\u4EF6\u3002",
  empty: "\u8BF7\u5148\u8F93\u5165\u7814\u7A76\u95EE\u9898\u3002",
  emptyReview: "\u8BF7\u5148\u8F93\u5165\u6587\u7A3F\u8DEF\u5F84\u3002",
  emptyPapers: "\u8BF7\u5148\u8F93\u5165\u68C0\u7D22\u8BCD\u3002",
  emptyReferences: "\u8BF7\u5148\u8F93\u5165\u53C2\u8003\u6587\u732E\u8DEF\u5F84\u3002",
  emptyWrite: "\u8BF7\u5148\u8F93\u5165\u4E24\u4E2A\u6587\u7A3F\u8DEF\u5F84\u3002",
  emptyAnalyze: "\u8BF7\u5148\u8F93\u5165\u5206\u6790\u95EE\u9898\u3002",
  emptyHypotheses: "\u8BF7\u5148\u8F93\u5165\u7814\u7A76\u76EE\u6807\u3002",
  conflict: "\u9009\u62E9\u4EFB\u52A1\u524D\u8BF7\u5148\u6E05\u9664\u5F53\u524D\u547D\u4EE4\u3002",
  changed: "\u8349\u7A3F\u5DF2\u66F4\u6539\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u4EFB\u52A1\u3002"
};
var TASK_FACE = {
  deep_research: { claim: "research", hint: "hint", attachments: "attachments", empty: "empty", started: "Deep Research" },
  deep_review: { claim: "review", hint: "hintReview", attachments: "attachmentsReview", empty: "emptyReview", started: "Deep Review" },
  find_papers: { claim: "papers", hint: "hintPapers", attachments: "attachmentsPapers", empty: "emptyPapers", started: "Find Papers" },
  check_references: { claim: "references", hint: "hintReferences", attachments: "attachmentsReferences", empty: "emptyReferences", started: "Check References" },
  write_revise: { claim: "write", hint: "hintWrite", attachments: "attachmentsWrite", empty: "emptyWrite", started: "Write / Revise" },
  analyze_data: { claim: "analyze", hint: "hintAnalyze", attachments: "attachmentsAnalyze", empty: "emptyAnalyze", started: "Analyze Data" },
  generate_hypotheses: { claim: "hypotheses", hint: "hintHypotheses", attachments: "attachmentsHypotheses", empty: "emptyHypotheses", started: "Generate Hypotheses" }
};
function taskRequestId(crypto = globalThis.crypto) {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function applyTaskModes(ctx) {
  const states = /* @__PURE__ */ new Map();
  const t = ctx.locale.bind("academicTasks");
  ctx.effect(() => ctx.locale.register("academicTasks", { en, zh }), "academic-harness: task copy");
  function sessionState(sessionId) {
    if (states.has(sessionId)) return states.get(sessionId);
    const actx = ctx.sessions.scope(sessionId);
    if (!actx) throw new Error("Academic task session is no longer open");
    const store = createTaskModeStore({ sessionId });
    const state = { actx, store, alive: true };
    states.set(sessionId, state);
    ctx.effect(() => actx.effect(() => () => {
      state.alive = false;
      states.delete(sessionId);
    }, "academic-harness: session task state"));
    void ctx.remote.commands.list(sessionId).then((response) => {
      if (!state.alive) return;
      if (!response.ok) throw new Error(response.error.message);
      store.update({ loading: false, available: response.value.some((command) => command.name === TASK_COMMAND) });
    }).catch((error) => {
      if (state.alive) store.update({ loading: false, error: error.message });
    });
    return state;
  }
  function claimFor(sessionId, task = "deep_research") {
    const state = sessionState(sessionId);
    const face = TASK_FACE[task] || TASK_FACE.deep_research;
    return {
      name: face.claim,
      token: `${taskToken(task)} `,
      hint: t(face.hint),
      async submit(prompt, _actx, attachments = []) {
        if (attachments.length) return { kind: "error", text: t(face.attachments) };
        if (!prompt.trim()) return { kind: "error", text: t(face.empty) };
        state.store.update({ lastTask: null, inTranscript: false });
        const effort = state.store.getSnapshot().effort;
        let request = state.store.getRequest();
        if (!request || request.task !== task || request.prompt !== prompt || request.options.effort !== effort) {
          request = { version: 1, request_id: taskRequestId(), task, prompt, options: { effort } };
          state.store.setRequest(request);
        }
        let result;
        try {
          result = await ctx.remote.commands.execute(sessionId, taskCommandLine(request), []);
        } catch (error) {
          state.store.update({ error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
        if (!result.ok) {
          state.store.update({ error: result.error.message });
          return { kind: "error", text: result.error.message };
        }
        const outcome = result.value?.result;
        if (!outcome) {
          state.store.update({ error: t("unavailable") });
          return { kind: "error", text: t("unavailable") };
        }
        if (outcome.kind === "error") {
          state.store.update({ error: outcome.text });
          return outcome;
        }
        const receipt = String(outcome.text ?? "");
        const jobId = /Job:\s*(\S+)/u.exec(receipt)?.[1] ?? null;
        const runId = /Research run:\s*(\S+)/u.exec(receipt)?.[1] ?? /Review:\s*(\S+)/u.exec(receipt)?.[1] ?? null;
        state.store.setRequest(null);
        state.store.update({
          effort: "auto",
          error: null,
          inTranscript: false,
          lastTask: { task, prompt, effort, jobId, runId, startedAt: Date.now() }
        });
        revealSessionTranscript(ctx, sessionId);
        const started = face.started;
        return { kind: "success", text: `${started} started${runId ? ` (${runId})` : ""}${jobId ? ` \xB7 ${jobId}` : ""}. Follow progress in Background tasks.` };
      }
    };
  }
  ctx.effect(() => ctx.inputTriggers.registerSource({
    trigger: "/",
    name: "academic-research",
    order: 45,
    candidates: async () => [],
    onPick: ({ session }) => ({ claim: claimFor(session.sessionId) }),
    matchSpace: (session, token) => {
      const task = taskForToken(token);
      return task ? { claim: claimFor(session.sessionId, task) } : void 0;
    },
    matchClaim: async (session, token) => {
      const task = taskForToken(token);
      return task ? claimFor(session.sessionId, task) : void 0;
    },
    async matchEnter(session, line, _signal, envelope) {
      const task = taskForToken(line.split(/[\s\n]/u, 1)[0]);
      if (!task) return void 0;
      if (envelope.attachments || envelope.images) throw new Error(t((TASK_FACE[task] || TASK_FACE.deep_research).attachments));
      return { claim: claimFor(session.sessionId, task) };
    }
  }), "academic-harness: research command claim");
  ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
    name: "conversation.input.left",
    id: "academic-task-selector",
    order: 45,
    locale: "academicTasks",
    inject: (sessionId) => {
      const state = sessionState(sessionId);
      const input = () => ctx.conversation.input.for(state.actx);
      return {
        hooks: { taskMode: state.store },
        setEffort: (effort) => {
          if (TASK_EFFORTS.includes(effort)) state.store.update({ effort, error: null });
        },
        selectTask: (taskId = "deep_research") => {
          const current = input().state.getSnapshot();
          if (!["plain", "claimed"].includes(current.phase)) return;
          const token = taskToken(taskId);
          const active = current.claim?.token.trim();
          const clearClaim = (snapshot) => {
            const end = snapshot.claim.name ? 1 : snapshot.claim.token.length;
            return state.actx.bail("slash/input-consume-token", { guard: { kind: "span", span: { start: 0, end, draftRev: snapshot.draftRev } } });
          };
          if (active === token) {
            if (clearClaim(current)) {
              state.store.setRequest(null);
              state.store.update({ effort: "auto", error: null });
            } else state.store.update({ error: t("changed") });
          } else if (active && taskForToken(active)) {
            if (!clearClaim(current)) {
              state.store.update({ error: t("changed") });
            } else {
              const next = input().state.getSnapshot();
              const changed = state.actx.bail("slash/input-begin-command", { claim: claimFor(sessionId, taskId), span: { start: 0, end: 0, draftRev: next.draftRev } });
              if (changed) {
                state.store.setRequest(null);
                state.store.update({ effort: "auto", error: null });
              } else state.store.update({ error: t("changed") });
            }
          } else if (current.claim || /^\s*\//u.test(current.draft)) {
            state.store.update({ error: t("conflict") });
          } else {
            const changed = state.actx.bail("slash/input-begin-command", { claim: claimFor(sessionId, taskId), span: { start: 0, end: 0, draftRev: current.draftRev } });
            state.store.update({ error: changed ? null : t("changed") });
          }
          input().focus?.();
        }
      };
    }
  }, TaskSelector));
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",
    id: "academic-task-run",
    order: 44,
    locale: "academicTasks",
    inject: (sessionId) => {
      const state = sessionState(sessionId);
      return {
        hooks: { taskMode: state.store },
        dismiss: () => state.store.update({ lastTask: null })
      };
    }
  }, TaskRunNotice));
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",
    id: "academic-task-status",
    order: 45,
    locale: "academicTasks",
    inject: (sessionId) => ({ hooks: { taskMode: sessionState(sessionId).store } })
  }, TaskSelectorStatus));
  ctx.slots.inject("conversation.chat.commandview", () => ctx.slots.register({
    name: "conversation.chat.commandview",
    key: TASK_COMMAND,
    locale: "academicTasks",
    inject: (sessionId) => {
      const state = sessionState(sessionId);
      return {
        markInTranscript: () => {
          if (state.alive) state.store.update({ inTranscript: true });
        }
      };
    }
  }, TaskCommandReceipt));
}
function revealSessionTranscript(ctx, sessionId) {
  try {
    const session = ctx.sessions.binding?.(sessionId)?.session;
    if (typeof session?.acceptPrompt === "function") session.acceptPrompt();
  } catch {
  }
}

// client/index.js
var ENTRY_ID = "academic-harness";
var inject = ["slots", "configForms", "sidebarRight", "sidebarRightTabs", "sessions", "conversation", "inputTriggers", "remote", "remote.commands", "locale"];
function apply(ctx) {
  applyTaskModes(ctx);
  const scope = ctx.configForms.get(ENTRY_ID);
  const openFoldPane = ({ text, level }) => {
    ctx.sidebarRight.openTab(FOLD_TAB_ID, { params: { text, level } });
  };
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: FOLD_TAB_ID,
    kind: FOLD_TAB_ID,
    title: () => "Read folded",
    keepMounted: true
  }), "academic-harness: reply fold pane type");
  ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
    name: "sidebar.right.pane.tab",
    key: FOLD_TAB_ID
  }, FoldPane));
  ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "academic-harness-api-keys",
    order: 60,
    label: () => "Academic Harness API keys",
    // `describe` is the shared mirror of the host's settings document; it carries the
    // `secrets` presence sidecar the page needs now that credential fields are redacted.
    inject: () => ({ scope, describe: ctx.configForms.describe?.() })
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
  ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
    name: "conversation.chat.turnTail",
    id: "academic-harness-reply-fold",
    order: 40,
    inject: () => ({ openFoldPane })
  }, ReplyFold));
}
return module.exports; } });
//# sourceMappingURL=client.js.map

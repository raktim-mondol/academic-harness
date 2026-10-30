import type { UniversalLLMClient } from "../llm/client.ts";
import { UniversalLLMClient as LLM } from "../llm/client.ts";
import type {
  Author,
  CitationMetadata,
  CitationReport,
  CitationVerdict,
  FieldComparison,
  GroundingUrl,
  SearchVerdict,
} from "../types/schema.ts";

/**
 * Citation Checker module (`pat_run_config.modules.citation_checker`), reconstructed from the
 * Deep Review v1 `CitationReport` schema:
 *  1. Extract bibliography entries (LLM) -> `extractedMetadata`, `entryType`, `citationKey`
 *  2. Scholarly database lookup: OpenAlex then Crossref, `searchMethod` in
 *     {"doi", "title", "title_author", "autocomplete"}
 *  3. `retrievedMetadata` is populated ONLY when the retrieved title matches the extracted title
 *  4. Per-field comparisons (`title`, `authors`, `year`, `journal`, `volume`, `pages`, `doi`)
 *  5. `lookupVerdict` -> optional search grounding -> `finalVerdict`
 */

export interface ExtractedReference {
  refNum: number;
  rawReference: string;
  entryType: string;
  title?: string;
  authors?: Author[];
  year?: number;
  journal?: string;
  volume?: string;
  pages?: string;
  doi?: string;
  urls?: string[];
  isNonPaper?: boolean;
}

const USER_AGENT = "open-deepreview/1.0 (mailto:open-deepreview@users.noreply.github.com)";

export function normalizeTitle(t: string | undefined): string {
  return (t ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Token-level Jaccard similarity between normalized titles. */
export function titleSimilarity(a: string | undefined, b: string | undefined): number {
  const ta = new Set(normalizeTitle(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeTitle(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export function titlesMatch(a: string | undefined, b: string | undefined): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length > 20 && (na.includes(nb) || nb.includes(na))) return true;
  return titleSimilarity(a, b) >= 0.8;
}

export function makeCitationKey(ref: ExtractedReference): string {
  const fam = normalizeTitle(ref.authors?.[0]?.familyName).replace(/\s+/g, "") || "anon";
  const year = ref.year ? String(ref.year) : "nd";
  const stop = new Set(["a", "an", "the", "on", "of", "for", "and", "in", "to", "with"]);
  const word =
    normalizeTitle(ref.title)
      .split(" ")
      .find((w) => w && !stop.has(w)) ?? "untitled";
  return `${fam}${year}${word}`;
}

function toMetadata(ref: ExtractedReference): CitationMetadata {
  return {
    title: ref.title,
    authors: ref.authors,
    publicationDate: ref.year ? { year: ref.year, month: 0, day: 0 } : undefined,
    journal: ref.journal,
    volume: ref.volume,
    pages: ref.pages,
    doi: ref.doi,
    urls: ref.urls,
    source: "",
  };
}

async function fetchJson(url: string, timeoutMs = 15000): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function openAlexToMetadata(work: any): CitationMetadata {
  const authors: Author[] = (work.authorships ?? []).map((a: any) => {
    const name: string = a.author?.display_name ?? "";
    const parts = name.trim().split(/\s+/);
    const familyName = parts.length > 1 ? parts[parts.length - 1] : name;
    const givenName = parts.length > 1 ? parts.slice(0, -1).join(" ") : "";
    return { givenName, familyName };
  });
  const biblio = work.biblio ?? {};
  const pages =
    biblio.first_page && biblio.last_page
      ? `${biblio.first_page}--${biblio.last_page}`
      : biblio.first_page ?? undefined;
  return {
    title: work.title ?? work.display_name,
    authors,
    publicationDate: work.publication_year
      ? { year: Number(work.publication_year), month: 0, day: 0 }
      : undefined,
    journal: work.primary_location?.source?.display_name ?? undefined,
    volume: biblio.volume ?? undefined,
    pages,
    doi: work.doi ? String(work.doi).replace(/^https?:\/\/doi\.org\//i, "") : undefined,
    urls: [work.id, work.primary_location?.landing_page_url].filter(Boolean),
    source: "openalex",
  };
}

function crossrefToMetadata(item: any): CitationMetadata {
  const authors: Author[] = (item.author ?? []).map((a: any) => ({
    givenName: a.given ?? "",
    familyName: a.family ?? a.name ?? "",
  }));
  const dateParts =
    item.issued?.["date-parts"]?.[0] ?? item.published?.["date-parts"]?.[0] ?? [];
  return {
    title: Array.isArray(item.title) ? item.title[0] : item.title,
    authors,
    publicationDate: dateParts[0]
      ? { year: Number(dateParts[0]), month: Number(dateParts[1] ?? 0), day: Number(dateParts[2] ?? 0) }
      : undefined,
    journal: Array.isArray(item["container-title"]) ? item["container-title"][0] : undefined,
    volume: item.volume ?? undefined,
    pages: item.page ?? undefined,
    doi: item.DOI ?? undefined,
    urls: item.URL ? [item.URL] : [],
    source: "crossref",
  };
}

/** Looks up a reference in OpenAlex then Crossref; returns the first title-matching candidate. */
export async function lookupScholarly(
  ref: ExtractedReference
): Promise<{ metadata?: CitationMetadata; searchMethod: string }> {
  const candidates: Array<{ meta: CitationMetadata; method: string }> = [];

  if (ref.doi) {
    const doi = ref.doi.replace(/^https?:\/\/doi\.org\//i, "").trim();
    const oa = await fetchJson(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`);
    if (oa?.id) candidates.push({ meta: openAlexToMetadata(oa), method: "doi" });
    else {
      const cr = await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
      if (cr?.message) candidates.push({ meta: crossrefToMetadata(cr.message), method: "doi" });
    }
  }

  if (ref.title && !candidates.some((c) => titlesMatch(c.meta.title, ref.title))) {
    const q = encodeURIComponent(ref.title.slice(0, 250));
    const oa = await fetchJson(`https://api.openalex.org/works?search=${q}&per-page=5`);
    for (const w of oa?.results ?? []) {
      candidates.push({ meta: openAlexToMetadata(w), method: "title" });
    }

    const fam = ref.authors?.[0]?.familyName;
    if (!candidates.some((c) => titlesMatch(c.meta.title, ref.title))) {
      const authorQ = fam ? `&query.author=${encodeURIComponent(fam)}` : "";
      const cr = await fetchJson(
        `https://api.crossref.org/works?query.bibliographic=${q}${authorQ}&rows=5`
      );
      for (const it of cr?.message?.items ?? []) {
        candidates.push({ meta: crossrefToMetadata(it), method: fam ? "title_author" : "title" });
      }
    }

    if (!candidates.some((c) => titlesMatch(c.meta.title, ref.title))) {
      const ac = await fetchJson(`https://api.openalex.org/autocomplete/works?q=${q}`);
      for (const r of ac?.results ?? []) {
        if (r.id) {
          const id = String(r.id).split("/").pop();
          const w = await fetchJson(`https://api.openalex.org/works/${id}`);
          if (w?.id) candidates.push({ meta: openAlexToMetadata(w), method: "autocomplete" });
          break;
        }
      }
    }
  }

  // Only accept candidates whose title matches the extracted title (schema guarantee)
  const match = candidates.find((c) => !ref.title || titlesMatch(c.meta.title, ref.title));
  if (match && (ref.title ? titlesMatch(match.meta.title, ref.title) : true)) {
    return { metadata: match.meta, searchMethod: match.method };
  }
  return { metadata: undefined, searchMethod: "" };
}

export function compareFields(
  extracted: CitationMetadata,
  retrieved: CitationMetadata
): { comparisons: FieldComparison[]; firstAuthorMatch: boolean } {
  const comparisons: FieldComparison[] = [];

  const titleMatch = titlesMatch(extracted.title, retrieved.title);
  comparisons.push({
    fieldKey: "title",
    match: titleMatch,
    detail: titleMatch ? "titles match" : `extracted="${extracted.title}", found="${retrieved.title}"`,
  });

  const exFam = normalizeTitle(extracted.authors?.[0]?.familyName);
  const reFam = normalizeTitle(retrieved.authors?.[0]?.familyName);
  const firstAuthorMatch = Boolean(exFam && reFam && (exFam === reFam || reFam.includes(exFam) || exFam.includes(reFam)));
  if (extracted.authors?.length) {
    const exSet = new Set((extracted.authors ?? []).map((a) => normalizeTitle(a.familyName)));
    const reSet = new Set((retrieved.authors ?? []).map((a) => normalizeTitle(a.familyName)));
    let overlap = 0;
    for (const n of exSet) if (reSet.has(n)) overlap++;
    const ok = firstAuthorMatch && overlap >= Math.min(exSet.size, reSet.size) * 0.6;
    comparisons.push({
      fieldKey: "authors",
      match: ok,
      detail: `first_author=${firstAuthorMatch ? "match" : "mismatch"}, overlap=${overlap}/${exSet.size}`,
    });
  }

  const ey = extracted.publicationDate?.year;
  const ry = retrieved.publicationDate?.year;
  if (ey && ry) {
    comparisons.push({
      fieldKey: "year",
      match: ey === ry,
      detail: ey === ry ? `year=${ey}` : `extracted=${ey}, found=${ry} (diff=${Math.abs(ey - ry)})`,
    });
  }

  if (extracted.journal && retrieved.journal) {
    const ok =
      titleSimilarity(extracted.journal, retrieved.journal) >= 0.5 ||
      normalizeTitle(retrieved.journal).includes(normalizeTitle(extracted.journal)) ||
      normalizeTitle(extracted.journal).includes(normalizeTitle(retrieved.journal));
    comparisons.push({
      fieldKey: "journal",
      match: ok,
      detail: ok ? "venue matches" : `extracted="${extracted.journal}", found="${retrieved.journal}"`,
    });
  }

  if (extracted.volume && retrieved.volume) {
    const ok = String(extracted.volume).trim() === String(retrieved.volume).trim();
    comparisons.push({
      fieldKey: "volume",
      match: ok,
      detail: ok ? `volume=${extracted.volume}` : `extracted=${extracted.volume}, found=${retrieved.volume}`,
    });
  }

  if (extracted.pages && retrieved.pages) {
    const norm = (p: string) => p.replace(/[–—-]+/g, "-").replace(/\s+/g, "");
    const ok = norm(extracted.pages) === norm(retrieved.pages);
    comparisons.push({
      fieldKey: "pages",
      match: ok,
      detail: ok ? `pages=${extracted.pages}` : `extracted=${extracted.pages}, found=${retrieved.pages}`,
    });
  }

  if (extracted.doi && retrieved.doi) {
    const ok = extracted.doi.toLowerCase().trim() === retrieved.doi.toLowerCase().trim();
    comparisons.push({
      fieldKey: "doi",
      match: ok,
      detail: ok ? `doi=${extracted.doi}` : `extracted=${extracted.doi}, found=${retrieved.doi}`,
    });
  }

  return { comparisons, firstAuthorMatch };
}

/**
 * Verdict derivation:
 *  - OK: all compared fields match
 *  - MINOR_MISMATCH: year off by 1, or only venue/volume/pages variation
 *  - MAJOR_MISMATCH: authors mismatch, year off by >1, or DOI mismatch
 */
export function deriveLookupVerdict(comparisons: FieldComparison[]): CitationVerdict {
  const failed = comparisons.filter((c) => !c.match);
  if (failed.length === 0) return "OK";
  const majorKeys = new Set(["authors", "doi", "title"]);
  for (const f of failed) {
    if (majorKeys.has(f.fieldKey)) return "MAJOR_MISMATCH";
    if (f.fieldKey === "year") {
      const m = f.detail.match(/diff=(\d+)/);
      if (m && Number(m[1]) > 1) return "MAJOR_MISMATCH";
    }
  }
  return "MINOR_MISMATCH";
}

export function formatBibtex(key: string, entryType: string, m: CitationMetadata): string {
  const fields: string[] = [];
  if (m.title) fields.push(`  title = {${m.title}}`);
  if (m.authors?.length) {
    fields.push(
      `  author = {${m.authors
        .map((a) => (a.givenName ? `${a.familyName}, ${a.givenName}` : a.familyName))
        .join(" and ")}}`
    );
  }
  if (m.publicationDate?.year) fields.push(`  year = {${m.publicationDate.year}}`);
  if (m.journal) {
    fields.push(entryType === "inproceedings" ? `  booktitle = {${m.journal}}` : `  journal = {${m.journal}}`);
  }
  if (m.volume) fields.push(`  volume = {${m.volume}}`);
  if (m.pages) fields.push(`  pages = {${m.pages}}`);
  if (m.doi) fields.push(`  doi = {${m.doi}}`);
  return `@${entryType || "article"}{${key},\n${fields.join(",\n")}\n}`;
}

const EXTRACT_SYSTEM = `You are the Citation Extraction agent of Deep Review. Extract every bibliography entry from the manuscript's reference list. Return strict JSON:
{"references":[{"refNum":1,"rawReference":"verbatim string","entryType":"article|inproceedings|book|misc|techreport|phdthesis","title":"...","authors":[{"givenName":"...","familyName":"..."}],"year":2020,"journal":"venue","volume":"...","pages":"...","doi":"...","urls":["..."],"isNonPaper":false}]}
Set isNonPaper=true for software packages, datasets, websites, or URLs that are not scholarly papers. Use 1-indexed refNum in bibliography order. Return {"references":[]} if there is no bibliography.`;

export async function extractReferences(
  llm: UniversalLLMClient,
  manuscriptText: string
): Promise<ExtractedReference[]> {
  // Focus on the tail where references normally live
  const idx = manuscriptText.search(/\n\s*(?:#+\s*)?(references|bibliography|works cited)\b/i);
  const slice = idx >= 0 ? manuscriptText.slice(idx) : manuscriptText.slice(-60000);
  const res = await llm.complete({
    systemPrompt: EXTRACT_SYSTEM,
    userPrompt: `MANUSCRIPT REFERENCE SECTION:\n\n${slice.slice(0, 80000)}`,
    jsonMode: true,
    temperature: 0,
  });
  const parsed = LLM.parseJsonResponse<{ references?: ExtractedReference[] }>(res.content, {
    references: [],
  });
  return (parsed.references ?? []).map((r, i) => ({ ...r, refNum: Number(r.refNum ?? i + 1) }));
}

const GROUNDING_SYSTEM = `You are the Search Grounding verifier of Deep Review's citation checker. Given a bibliography entry that could not be found in OpenAlex or Crossref, decide whether this work plausibly exists using your knowledge (and any web search capability you have). Return strict JSON:
{"verdict":"NOT_HALLUCINATED"|"HALLUCINATED_BY_SEARCH"|"UNSURE","rationale":"one or two sentences","urls":[{"title":"...","url":"https://..."}]}
Only return HALLUCINATED_BY_SEARCH when the entry is very likely fabricated (e.g., impossible author/venue/year combination or no trace of the work). Never invent URLs.`;

export async function groundWithSearch(
  llm: UniversalLLMClient,
  ref: ExtractedReference
): Promise<{ verdict: SearchVerdict; rationale: string; urls: GroundingUrl[] }> {
  try {
    const res = await llm.complete({
      systemPrompt: GROUNDING_SYSTEM,
      userPrompt: `REFERENCE [${ref.refNum}]: ${ref.rawReference}`,
      jsonMode: true,
      temperature: 0,
    });
    const parsed = LLM.parseJsonResponse<{ verdict?: string; rationale?: string; urls?: GroundingUrl[] }>(
      res.content,
      {}
    );
    const v =
      parsed.verdict === "NOT_HALLUCINATED"
        ? "NOT_HALLUCINATED"
        : parsed.verdict === "HALLUCINATED_BY_SEARCH"
        ? "HALLUCINATED_BY_SEARCH"
        : "SEARCH_VERDICT_UNSPECIFIED";
    return {
      verdict: v,
      rationale: String(parsed.rationale ?? ""),
      urls: (parsed.urls ?? []).filter((u) => u && typeof u.url === "string" && /^https?:\/\//.test(u.url)),
    };
  } catch (e) {
    return { verdict: "SEARCH_ERROR", rationale: String((e as Error).message ?? e), urls: [] };
  }
}

export async function verifyReference(
  llm: UniversalLLMClient | null,
  ref: ExtractedReference,
  options: { enableSearchGrounding: boolean; offline?: boolean }
): Promise<CitationReport> {
  const extractedMetadata = toMetadata(ref);
  const citationKey = makeCitationKey(ref);
  const base: CitationReport = {
    refNum: ref.refNum,
    rawReference: ref.rawReference,
    citationKey,
    entryType: ref.entryType || "misc",
    extractedMetadata,
    lookupVerdict: "VERDICT_UNSPECIFIED",
    finalVerdict: "VERDICT_UNSPECIFIED",
  };

  if (ref.isNonPaper) {
    return { ...base, lookupVerdict: "SKIPPED", finalVerdict: "SKIPPED", searchMethod: "" };
  }

  const { metadata, searchMethod } = options.offline
    ? { metadata: undefined, searchMethod: "" }
    : await lookupScholarly(ref);

  if (metadata) {
    const { comparisons, firstAuthorMatch } = compareFields(extractedMetadata, metadata);
    const verdict = deriveLookupVerdict(comparisons);
    return {
      ...base,
      retrievedMetadata: metadata,
      retrievedBibtex: formatBibtex(citationKey, ref.entryType, metadata),
      searchMethod,
      firstAuthorFamilyNameMatch: firstAuthorMatch,
      fieldComparisons: comparisons,
      lookupVerdict: verdict,
      finalVerdict: verdict,
    };
  }

  const notFound: CitationReport = {
    ...base,
    searchMethod: "",
    lookupVerdict: "NOT_FOUND",
    finalVerdict: "NOT_FOUND",
  };

  if (!options.enableSearchGrounding || !llm) return notFound;

  const g = await groundWithSearch(llm, ref);
  return {
    ...notFound,
    searchVerdict: g.verdict,
    searchRationale: g.rationale,
    groundingUrls: g.urls,
    finalVerdict:
      g.verdict === "NOT_HALLUCINATED"
        ? "VERIFIED_BY_SEARCH"
        : g.verdict === "HALLUCINATED_BY_SEARCH"
        ? "HALLUCINATED"
        : "NOT_FOUND",
  };
}

export async function runCitationChecker(
  llm: UniversalLLMClient,
  manuscriptText: string,
  options: { enableSearchGrounding: boolean; concurrency?: number; offline?: boolean; onProgress?: (done: number, total: number) => void }
): Promise<CitationReport[]> {
  const refs = await extractReferences(llm, manuscriptText);
  const results: CitationReport[] = new Array(refs.length);
  const concurrency = Math.max(1, options.concurrency ?? 4);
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(concurrency, refs.length) }, async () => {
    while (next < refs.length) {
      const i = next++;
      results[i] = await verifyReference(llm, refs[i], options);
      done++;
      options.onProgress?.(done, refs.length);
    }
  });
  await Promise.all(workers);
  return results;
}

export const VERDICT_LABELS: Record<CitationVerdict, string> = {
  VERDICT_UNSPECIFIED: "Unspecified",
  OK: "Verified",
  MINOR_MISMATCH: "Minor mismatch",
  MAJOR_MISMATCH: "Major mismatch",
  VERIFIED_BY_SEARCH: "Verified by search",
  NOT_FOUND: "Not found",
  HALLUCINATED: "Likely hallucinated",
  SKIPPED: "Skipped (non-paper)",
};

/** Builds the `# CITATION & REFERENCE VERIFICATION` report section. */
export function renderCitationSection(reports: CitationReport[]): string {
  const out: string[] = ["# CITATION & REFERENCE VERIFICATION", "---", "## Reference Check Summary"];
  if (reports.length === 0) {
    out.push("No references extracted from the document.");
    return out.join("\n");
  }
  const counts = new Map<CitationVerdict, number>();
  for (const r of reports) counts.set(r.finalVerdict, (counts.get(r.finalVerdict) ?? 0) + 1);
  out.push(
    `Checked ${reports.length} references: ` +
      [...counts.entries()].map(([k, v]) => `${v} ${VERDICT_LABELS[k].toLowerCase()}`).join(", ") +
      "."
  );
  const flagged = reports.filter((r) => !["OK", "SKIPPED", "VERIFIED_BY_SEARCH"].includes(r.finalVerdict));
  if (flagged.length) {
    out.push("", "## Flagged References");
    for (const r of flagged) {
      const issues = (r.fieldComparisons ?? []).filter((c) => !c.match).map((c) => `${c.fieldKey}: ${c.detail}`);
      out.push(
        `* **[${r.refNum}] ${VERDICT_LABELS[r.finalVerdict]}:** ${r.rawReference}` +
          (issues.length ? `\n  * ${issues.join("\n  * ")}` : "") +
          (r.searchRationale ? `\n  * Search grounding: ${r.searchRationale}` : "")
      );
    }
  }
  return out.join("\n");
}

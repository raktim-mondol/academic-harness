#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DeepReviewPipeline, estimateReviewCost, formatMoneyUsd } from "./agents/pipeline.ts";
import { renderCitationSection, runCitationChecker } from "./citation/checker.ts";
import {
  getConfigPath,
  resolveConfig,
  saveStoredConfig,
  TOPOLOGY_PROFILES,
} from "./config/store.ts";
import { inspectAndConvertPdfToMarkdown, parseManuscriptFile } from "./doc/parser.ts";
import {
  computeCategoryFilterChips,
  computeQuoteBoundingBoxesOnPage,
  formatCommentLocationBadge,
  normalizeRawPatFixture,
  sortAnchoredComments,
} from "./doc/target_algorithms.ts";
import { UniversalLLMClient } from "./llm/client.ts";
import type { RawPatFixture, ThinkingLevel, Topology } from "./types/schema.ts";
import { DeepReviewServer } from "./ui/viewer_server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures");

const HELP_TEXT = `
open-deepreview — Open-source recreation of Google Deep Review (Paper Assistant Tool)

USAGE:
  deepreview <command> [options]

COMMANDS:
  review <file>            Convert PDF to Markdown via @firecrawl/pdf-inspector & run the 4-stage PAT review
                           (Outputs review in Markdown by default and saves <paper>.review.md)
  pdf2md <file.pdf>        Convert a PDF paper to clean Markdown using Firecrawl's pdf-inspector
                           (Aliases: inspect-pdf, pdf-inspector)
  verify-citations <file>  Extract & verify bibliography entries against OpenAlex, Crossref & LLM grounding
  estimate-cost <file>     Estimate low/median/high review cost for a manuscript & topology
  config [set|show|path]   Configure or inspect persistent LLM settings (baseUrl, apiKey, model, topology)
  fixture                  Inspect and verify the embedded Google Deep Review PAT fixture ("Newton's Third Law")
  serve [file]             Start the local Deep Review REST API v1 + interactive split-pane web viewer

LLM & PIPELINE OPTIONS (work across commands or via 'deepreview config set'):
  --base-url <url>         OpenAI-compatible, Gemini, or Anthropic API base URL
                           (env: DEEPREVIEW_BASE_URL or OPENAI_BASE_URL)
  --api-key <key>          API key for the chosen LLM endpoint
                           (env: DEEPREVIEW_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY)
  --model <name>           LLM model identifier (e.g. gpt-4o, gemini-2.5-pro, claude-3-7-sonnet-latest, deepseek-reasoner)
                           (env: DEEPREVIEW_MODEL)
  --topology <level>       Review depth topology: LOW | MID | HIGH | EXTRA_HIGH (default: MID)
  --thinking-level <lvl>   Reasoning effort: THINKING_LEVEL_LOW | THINKING_LEVEL_MEDIUM | THINKING_LEVEL_HIGH
  --prompt <text>          Custom author guidance / target venue / focus areas for the review
  --save-markdown <path>   When reviewing a PDF, also save the converted Firecrawl pdf-inspector Markdown to <path>
  --no-citations           Disable the scholarly citation verification module
  --no-scholar-peer        Disable the high-level Scholar Peer summary/strengths/weaknesses module
  --offline-citations      Skip live OpenAlex/Crossref HTTP queries during citation verification
  -o, --output <path>      Write output Markdown (or JSON with --json) to a file
  --json                   Emit JSON instead of Markdown
  -p, --port <port>        Port for 'deepreview serve' (default: 8787)
  -h, --help               Show this help message
`.trim();

function normalizeTopologyFlag(val?: string): Topology | undefined {
  if (!val) return undefined;
  const u = val.trim().toUpperCase();
  if (u === "LOW" || u === "1") return "LOW";
  if (u === "MID" || u === "MEDIUM" || u === "2") return "MID";
  if (u === "HIGH" || u === "3") return "HIGH";
  if (u === "EXTRA_HIGH" || u === "EXTRA-HIGH" || u === "4") return "EXTRA_HIGH";
  throw new Error(`Invalid --topology "${val}". Expected LOW, MID, HIGH, or EXTRA_HIGH.`);
}

function normalizeThinkingFlag(val?: string): ThinkingLevel | undefined {
  if (!val) return undefined;
  const u = val.trim().toUpperCase();
  if (u === "LOW" || u === "THINKING_LEVEL_LOW") return "THINKING_LEVEL_LOW";
  if (u === "MEDIUM" || u === "MID" || u === "THINKING_LEVEL_MEDIUM") return "THINKING_LEVEL_MEDIUM";
  if (u === "HIGH" || u === "THINKING_LEVEL_HIGH") return "THINKING_LEVEL_HIGH";
  throw new Error(
    `Invalid --thinking-level "${val}". Expected LOW, MEDIUM, HIGH (or THINKING_LEVEL_*).`
  );
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      "base-url": { type: "string" },
      "api-key": { type: "string" },
      model: { type: "string" },
      topology: { type: "string" },
      "thinking-level": { type: "string" },
      prompt: { type: "string" },
      "save-markdown": { type: "string" },
      output: { type: "string", short: "o" },
      json: { type: "boolean" },
      "no-citations": { type: "boolean" },
      "no-scholar-peer": { type: "boolean" },
      "offline-citations": { type: "boolean" },
      port: { type: "string", short: "p" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP_TEXT);
    return 0;
  }

  const command = positionals[0].toLowerCase();
  const topologyOverride = normalizeTopologyFlag(values.topology as string | undefined);
  const thinkingOverride = normalizeThinkingFlag(values["thinking-level"] as string | undefined);

  const cfg = resolveConfig({
    baseUrl: values["base-url"] as string | undefined,
    apiKey: values["api-key"] as string | undefined,
    model: values.model as string | undefined,
    topology: topologyOverride,
    thinkingLevel: thinkingOverride,
  });

  if (values["no-citations"]) {
    cfg.patModules.citation_checker.enabled = false;
  }
  if (values["no-scholar-peer"]) {
    cfg.patModules.scholar_peer.enabled = false;
  }

  // 1. CONFIG COMMAND
  if (command === "config") {
    const sub = (positionals[1] || "show").toLowerCase();
    if (sub === "path") {
      console.log(getConfigPath());
      return 0;
    }
    if (sub === "set") {
      const saved = saveStoredConfig({
        baseUrl: values["base-url"] as string | undefined,
        apiKey: values["api-key"] as string | undefined,
        model: values.model as string | undefined,
        topology: topologyOverride,
        thinkingLevel: thinkingOverride,
      });
      console.log(`Saved configuration to ${getConfigPath()}:`);
      console.log(
        JSON.stringify(
          {
            ...saved,
            apiKey: saved.apiKey ? `${saved.apiKey.slice(0, 4)}...${saved.apiKey.slice(-4)}` : "(not set)",
          },
          null,
          2
        )
      );
      return 0;
    }
    console.log(
      JSON.stringify(
        {
          configPath: getConfigPath(),
          baseUrl: cfg.baseUrl,
          model: cfg.model,
          apiKeySet: Boolean(cfg.apiKey),
          topology: cfg.topology,
          thinkingLevel: cfg.thinkingLevel,
          patModules: cfg.patModules,
        },
        null,
        2
      )
    );
    return 0;
  }

  // 2. PDF2MD / INSPECT-PDF / PDF-INSPECTOR COMMAND (Firecrawl pdf-inspector)
  if (command === "pdf2md" || command === "inspect-pdf" || command === "pdf-inspector") {
    const filePath = positionals[1];
    if (!filePath) {
      throw new Error(`Usage: deepreview ${command} <file.pdf> [-o output.md] [--json]`);
    }
    const absPath = resolve(filePath);
    const bytes = new Uint8Array(readFileSync(absPath));
    const { result, perPage, classification, markdown } = inspectAndConvertPdfToMarkdown(bytes);

    console.error(
      `[pdf-inspector] Classified "${basename(absPath)}" as ${result.pdfType} (${result.pageCount} pages, confidence=${(result.confidence * 100).toFixed(0)}%, ${result.processingTimeMs}ms)`
    );

    const outContent = values.json
      ? JSON.stringify(
          {
            filename: basename(absPath),
            classification,
            pdfType: result.pdfType,
            pageCount: result.pageCount,
            confidence: result.confidence,
            processingTimeMs: result.processingTimeMs,
            isComplexLayout: result.isComplexLayout,
            pagesWithTables: result.pagesWithTables,
            pagesWithColumns: result.pagesWithColumns,
            pagesNeedingOcr: result.pagesNeedingOcr,
            markdown,
            pages: perPage.pages.map((p) => ({
              pageNumber: p.page + 1,
              needsOcr: p.needsOcr,
              ocrReason: p.ocrReason,
              markdown: p.markdown,
            })),
          },
          null,
          2
        )
      : markdown;

    if (values.output) {
      writeFileSync(String(values.output), outContent, "utf8");
      console.error(`[pdf-inspector] Saved converted Markdown to ${values.output}`);
    } else {
      console.log(outContent);
    }
    return 0;
  }

  // 3. FIXTURE COMMAND
  if (command === "fixture") {
    const jsonPath = join(FIXTURES_DIR, "google_deepreview_fixture.json");
    const pdfPath = join(FIXTURES_DIR, "newton_third_law_fixture.pdf");
    const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as RawPatFixture;
    const { document, review } = normalizeRawPatFixture(raw);
    const parsedPdf = await parseManuscriptFile(pdfPath);
    const comments = sortAnchoredComments(review.result?.anchoredComments ?? []);
    const chips = computeCategoryFilterChips(comments);

    const page1Layer = parsedPdf.pages[0]?.pdfTextLayer;
    let recomputedMatches = 0;
    if (page1Layer) {
      for (const c of comments) {
        const q = c.location?.pdf?.quoteSelector?.exact;
        if (q && c.location?.pdf?.pageNumber === 1) {
          const boxes = computeQuoteBoundingBoxesOnPage(
            q,
            page1Layer.items,
            page1Layer.width,
            page1Layer.height
          );
          if (boxes.length > 0) recomputedMatches++;
        }
      }
    }

    if (values.json) {
      const out = JSON.stringify(
        {
          document,
          review,
          chips,
          pdfInspector: parsedPdf.pdfInspector,
          recomputedPage1Matches: recomputedMatches,
        },
        null,
        2
      );
      if (values.output) writeFileSync(String(values.output), out, "utf8");
      else console.log(out);
      return 0;
    }

    console.log(`Document:      ${document.name} (${document.displayName})`);
    console.log(`Review:        ${review.name} [${review.state}]`);
    console.log(`Model:         ${review.runConfig?.model} | Topology: ${review.runConfig?.topology}`);
    console.log(
      `PDF Inspector: type=${parsedPdf.pdfInspector?.pdfType} | pages=${parsedPdf.pages.length} | time=${parsedPdf.pdfInspector?.processingTimeMs}ms`
    );
    console.log(
      `Comments:      ${comments.length} | Page-1 Quote BBox Matches: ${recomputedMatches}`
    );
    console.log(`Filter Chips:  ${chips.map((c) => `${c.label}: ${c.count}`).join(" | ")}`);
    console.log("\nTop Anchored Comments:");
    for (const c of comments.slice(0, 8)) {
      console.log(
        `  - [${c.severity}] (${formatCommentLocationBadge(c) || "Summary"}) ${c.summary}`
      );
    }
    if (values.output) {
      writeFileSync(String(values.output), review.result?.reviewMarkdown ?? "", "utf8");
      console.log(`\nWrote fixture review Markdown to ${values.output}`);
    }
    return 0;
  }

  // 4. ESTIMATE-COST COMMAND
  if (command === "estimate-cost") {
    const filePath = positionals[1];
    if (!filePath) throw new Error("Usage: deepreview estimate-cost <file>");
    const doc = await parseManuscriptFile(resolve(filePath));
    const est = estimateReviewCost(doc, {
      model: cfg.model,
      topology: cfg.topology,
      thinkingLevel: cfg.thinkingLevel,
    });
    if (values.json) {
      console.log(JSON.stringify(est, null, 2));
      return 0;
    }
    const profile = TOPOLOGY_PROFILES[cfg.topology === "TOPOLOGY_UNSPECIFIED" ? "MID" : cfg.topology];
    console.log(`Manuscript:     ${doc.filename} (${doc.pages.length} pages, format: ${doc.format})`);
    if (doc.pdfInspector) {
      console.log(
        `PDF Inspector:  ${doc.pdfInspector.pdfType} (confidence ${(doc.pdfInspector.confidence * 100).toFixed(0)}%, converted to Markdown in ${doc.pdfInspector.processingTimeMs}ms)`
      );
    }
    console.log(`Model:          ${cfg.model} (${cfg.baseUrl})`);
    console.log(`Topology:       ${cfg.topology} (${profile.description})`);
    console.log(`Thinking Level: ${cfg.thinkingLevel}`);
    console.log(`Estimated Cost: Low ${formatMoneyUsd(est.lowCost)} | Median ${formatMoneyUsd(est.medianCost)} | High ${formatMoneyUsd(est.highCost)}`);
    return 0;
  }

  // 5. VERIFY-CITATIONS COMMAND
  if (command === "verify-citations") {
    const filePath = positionals[1];
    if (!filePath) throw new Error("Usage: deepreview verify-citations <file>");
    const doc = await parseManuscriptFile(resolve(filePath));
    if (doc.pdfInspector) {
      console.error(
        `[pdf-inspector] Converted "${doc.filename}" (${doc.pdfInspector.pdfType}, ${doc.pages.length} pages) to clean Markdown in ${doc.pdfInspector.processingTimeMs}ms`
      );
    }
    const llm = new UniversalLLMClient({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      thinkingLevel: cfg.thinkingLevel,
    });
    const reports = await runCitationChecker(llm, doc.fullText, {
      enableSearchGrounding: cfg.patModules.pat.enable_search,
      offline: Boolean(values["offline-citations"]),
      onProgress: (done, total) => {
        process.stderr.write(`\rVerifying citations: ${done}/${total}...`);
      },
    });
    process.stderr.write("\n");

    const outputText = values.json
      ? JSON.stringify(reports, null, 2)
      : renderCitationSection(reports);

    if (values.output) {
      writeFileSync(String(values.output), outputText, "utf8");
      console.error(`Saved citation report to ${values.output}`);
    } else {
      console.log(outputText);
    }
    return 0;
  }

  // 6. REVIEW COMMAND
  if (command === "review") {
    const filePath = positionals[1];
    if (!filePath) throw new Error("Usage: deepreview review <file> [options]");
    const absInput = resolve(filePath);
    const doc = await parseManuscriptFile(absInput);

    if (doc.pdfInspector) {
      console.error(
        `[pdf-inspector] Converted PDF "${doc.filename}" (${doc.pdfInspector.pdfType}, ${doc.pages.length} pages) -> clean Markdown in ${doc.pdfInspector.processingTimeMs}ms`
      );
    }
    if (values["save-markdown"]) {
      const mdOut = resolve(String(values["save-markdown"]));
      writeFileSync(mdOut, doc.markdown, "utf8");
      console.error(`[pdf-inspector] Saved converted paper Markdown to ${mdOut}`);
    }

    console.error(
      `[DeepReview] Analyzing "${doc.filename}" (${doc.pages.length} pages) with model="${cfg.model}" @ ${cfg.baseUrl} (topology=${cfg.topology})`
    );
    const pipeline = new DeepReviewPipeline({
      config: cfg,
      userPrompt: values.prompt as string | undefined,
      offlineCitations: Boolean(values["offline-citations"]),
      onProgress: (p) => {
        process.stderr.write(`[${String(p.percent).padStart(3, " ")}%] [${p.stage}] ${p.message}\n`);
      },
    });
    const review = await pipeline.run(doc);
    const reviewMarkdown = review.result?.reviewMarkdown ?? "";
    const outputContent = values.json ? JSON.stringify(review, null, 2) : reviewMarkdown;

    if (values.output) {
      writeFileSync(String(values.output), outputContent, "utf8");
      console.error(`[DeepReview] Saved review output to ${values.output}`);
    } else {
      // Emit review Markdown to stdout AND write a default `<paper>.review.md` file alongside when not in --json mode
      console.log(outputContent);
      if (!values.json) {
        const stem = basename(absInput, extname(absInput));
        const defaultMdPath = join(dirname(absInput), `${stem}.review.md`);
        try {
          writeFileSync(defaultMdPath, reviewMarkdown, "utf8");
          console.error(`[DeepReview] Saved Markdown review report to ${defaultMdPath}`);
        } catch {
          // Ignore if directory is read-only
        }
      }
    }
    return 0;
  }

  // 7. SERVE COMMAND
  if (command === "serve") {
    const port = Number(values.port || 8787);
    const serverApp = new DeepReviewServer();

    if (positionals[1]) {
      const filePath = resolve(positionals[1]);
      const doc = await parseManuscriptFile(filePath);
      console.error(`[DeepReview] Running review on ${doc.filename} before launching viewer...`);
      const pipeline = new DeepReviewPipeline({
        config: cfg,
        userPrompt: values.prompt as string | undefined,
        offlineCitations: Boolean(values["offline-citations"]),
        documentId: "cli-doc-1",
        reviewId: "cli-review-1",
      });
      const review = await pipeline.run(doc);
      serverApp.addDocumentAndReview(
        "cli-doc-1",
        doc.filename,
        doc.rawBytes,
        doc.format === "pdf" ? "application/pdf" : "text/plain",
        review
      );
    }

    const server = Bun.serve({
      port,
      fetch: (req) => serverApp.handleRequest(req),
    });
    console.log(`Open Deep Review API v1 & Interactive Viewer listening on http://localhost:${server.port}`);
    console.log(`  - Web Viewer:           http://localhost:${server.port}/`);
    console.log(`  - REST API Documents:   http://localhost:${server.port}/v1/documents`);
    console.log(`  - REST API User Quota:  http://localhost:${server.port}/v1/userQuota`);
    return 0;
  }

  throw new Error(`Unknown command "${command}". Run 'deepreview --help' for usage.`);
}

if (import.meta.main) {
  runCli().then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (err) => {
      console.error(`Error: ${(err as Error).message || err}`);
      process.exit(1);
    }
  );
}

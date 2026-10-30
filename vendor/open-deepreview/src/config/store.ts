import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PatModulesConfig, ThinkingLevel, Topology } from "../types/schema.ts";

export interface LLMUserConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  topology: Topology;
  thinkingLevel: ThinkingLevel;
  patModules: PatModulesConfig;
}

export const DEFAULT_PAT_MODULES: PatModulesConfig = {
  pat: {
    enabled: true,
    topology: 2,
    enable_search: true,
    include_segment_summaries: true,
    enforce_category_limits: true,
    segment_model_overrides: [],
  },
  scholar_peer: {
    enabled: true,
  },
  citation_checker: {
    enabled: true,
  },
};

export const TOPOLOGY_PROFILES: Record<
  Exclude<Topology, "TOPOLOGY_UNSPECIFIED">,
  {
    code: number;
    label: string;
    description: string;
    verifierPassesPerSegment: number;
    maxCommentsPerReview: number;
    enableDebateRefinement: boolean;
  }
> = {
  LOW: {
    code: 1,
    label: "Low",
    description: "Quick single-pass check for fast feedback on early drafts",
    verifierPassesPerSegment: 1,
    maxCommentsPerReview: 40,
    enableDebateRefinement: false,
  },
  MID: {
    code: 2,
    label: "Medium",
    description: "Standard review balancing turnaround speed and analytical depth",
    verifierPassesPerSegment: 2,
    maxCommentsPerReview: 100,
    enableDebateRefinement: true,
  },
  HIGH: {
    code: 3,
    label: "High",
    description: "Thorough multi-agent conference-level evaluation and verification",
    verifierPassesPerSegment: 3,
    maxCommentsPerReview: 200,
    enableDebateRefinement: true,
  },
  EXTRA_HIGH: {
    code: 4,
    label: "Extra High",
    description: "Exhaustive multi-pass evaluation for complex theoretical and empirical documents",
    verifierPassesPerSegment: 4,
    maxCommentsPerReview: 300,
    enableDebateRefinement: true,
  },
};

export function getConfigPath(): string {
  return (
    process.env.DEEPREVIEW_CONFIG_PATH ||
    join(homedir(), ".config", "deepreview", "config.json")
  );
}

export function loadStoredConfig(): Partial<LLMUserConfig> {
  const path = getConfigPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as Partial<LLMUserConfig>;
  } catch {
    return {};
  }
}

export function saveStoredConfig(update: Partial<LLMUserConfig>): LLMUserConfig {
  const current = resolveConfig(update);
  const path = getConfigPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(current, null, 2), "utf8");
  return current;
}

export function resolveConfig(overrides: Partial<LLMUserConfig> = {}): LLMUserConfig {
  const stored = loadStoredConfig();

  const baseUrl = (
    overrides.baseUrl ??
    process.env.DEEPREVIEW_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    stored.baseUrl ??
    "https://api.openai.com/v1"
  ).trim();

  const apiKey = (
    overrides.apiKey ??
    process.env.DEEPREVIEW_API_KEY ??
    process.env.OPENAI_API_KEY ??
    process.env.GEMINI_API_KEY ??
    process.env.ANTHROPIC_API_KEY ??
    stored.apiKey ??
    ""
  ).trim();

  const model = (
    overrides.model ??
    process.env.DEEPREVIEW_MODEL ??
    stored.model ??
    "gpt-4o"
  ).trim();

  const topology: Topology =
    overrides.topology ??
    (process.env.DEEPREVIEW_TOPOLOGY as Topology | undefined) ??
    stored.topology ??
    "MID";

  const thinkingLevel: ThinkingLevel =
    overrides.thinkingLevel ??
    (process.env.DEEPREVIEW_THINKING_LEVEL as ThinkingLevel | undefined) ??
    stored.thinkingLevel ??
    "THINKING_LEVEL_MEDIUM";

  const topoKey = topology === "TOPOLOGY_UNSPECIFIED" ? "MID" : topology;
  const topoNum = TOPOLOGY_PROFILES[topoKey]?.code ?? 2;

  const patModules: PatModulesConfig = overrides.patModules ??
    stored.patModules ?? {
      ...DEFAULT_PAT_MODULES,
      pat: {
        ...DEFAULT_PAT_MODULES.pat,
        topology: topoNum,
      },
    };

  return {
    baseUrl,
    apiKey,
    model,
    topology: topoKey,
    thinkingLevel,
    patModules,
  };
}

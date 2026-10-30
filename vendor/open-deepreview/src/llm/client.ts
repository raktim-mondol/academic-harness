import type { ThinkingLevel } from "../types/schema.ts";

export interface LLMClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  timeoutMs?: number;
}

export interface LLMCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  jsonMode?: boolean;
  modelOverride?: string;
}

export interface LLMCompletionResponse {
  content: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Universal LLM Client supporting any user-configured `baseUrl`, `apiKey`, and `model`:
 * - OpenAI-compatible `/chat/completions` endpoints (OpenAI, OpenRouter, Ollama, vLLM, DeepSeek, Groq, Gemini OpenAI compatibility, etc.)
 * - Native Google Gemini `/v1beta/models/{model}:generateContent`
 * - Native Anthropic `/v1/messages`
 */
export class UniversalLLMClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly thinkingLevel: ThinkingLevel;
  private readonly timeoutMs: number;

  constructor(options: LLMClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey.trim();
    this.model = options.model.trim();
    this.thinkingLevel = options.thinkingLevel ?? "THINKING_LEVEL_MEDIUM";
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  public getConfigSummary(): { baseUrl: string; model: string; hasApiKey: boolean } {
    return {
      baseUrl: this.baseUrl,
      model: this.model,
      hasApiKey: Boolean(this.apiKey),
    };
  }

  private detectProtocol(): "gemini-native" | "anthropic-native" | "openai-compatible" {
    const lowerUrl = this.baseUrl.toLowerCase();
    if (
      lowerUrl.includes("generativelanguage.googleapis.com") &&
      !lowerUrl.includes("/openai")
    ) {
      return "gemini-native";
    }
    if (lowerUrl.includes("api.anthropic.com") && !lowerUrl.includes("/v1/chat")) {
      return "anthropic-native";
    }
    return "openai-compatible";
  }

  private mapReasoningEffort(): "low" | "medium" | "high" {
    switch (this.thinkingLevel) {
      case "THINKING_LEVEL_LOW":
        return "low";
      case "THINKING_LEVEL_HIGH":
        return "high";
      default:
        return "medium";
    }
  }

  public async complete(req: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const activeModel = (req.modelOverride || this.model).trim();
    const protocol = this.detectProtocol();

    if (protocol === "gemini-native") {
      return this.completeGeminiNative(activeModel, req);
    }
    if (protocol === "anthropic-native") {
      return this.completeAnthropicNative(activeModel, req);
    }
    return this.completeOpenAICompatible(activeModel, req);
  }

  private async completeOpenAICompatible(
    model: string,
    req: LLMCompletionRequest
  ): Promise<LLMCompletionResponse> {
    const endpoint = this.baseUrl.endsWith("/chat/completions")
      ? this.baseUrl
      : `${this.baseUrl}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: req.systemPrompt },
        { role: "user", content: req.userPrompt },
      ],
      temperature: req.temperature ?? 0.2,
    };

    if (req.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    // Attach reasoning_effort for reasoning models (o1, o3, deepseek-reasoner, etc.)
    if (/^(o1|o3|o4|deepseek-r1|gemini-2\.5|gemini-3)/i.test(model)) {
      body.reasoning_effort = this.mapReasoningEffort();
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      // Retry without response_format / reasoning_effort if endpoint rejects optional fields
      if (res.status === 400 && (body.response_format || body.reasoning_effort)) {
        delete body.response_format;
        delete body.reasoning_effort;
        const retryRes = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (retryRes.ok) {
          const data = (await retryRes.json()) as any;
          return {
            content: String(data.choices?.[0]?.message?.content ?? ""),
            model: String(data.model ?? model),
            promptTokens: data.usage?.prompt_tokens,
            completionTokens: data.usage?.completion_tokens,
          };
        }
      }
      throw new Error(
        `LLM request failed (${res.status} ${res.statusText}) at ${endpoint}: ${errText.slice(0, 400)}`
      );
    }

    const data = (await res.json()) as any;
    return {
      content: String(data.choices?.[0]?.message?.content ?? ""),
      model: String(data.model ?? model),
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
    };
  }

  private async completeGeminiNative(
    model: string,
    req: LLMCompletionRequest
  ): Promise<LLMCompletionResponse> {
    const cleanModel = model.replace(/^models\//, "");
    const base = this.baseUrl.includes("/v1")
      ? this.baseUrl
      : `${this.baseUrl}/v1beta`;
    const endpoint = `${base}/models/${encodeURIComponent(cleanModel)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const generationConfig: Record<string, unknown> = {
      temperature: req.temperature ?? 0.2,
    };
    if (req.jsonMode) {
      generationConfig.responseMimeType = "application/json";
    }

    const body = {
      systemInstruction: {
        parts: [{ text: req.systemPrompt }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: req.userPrompt }],
        },
      ],
      generationConfig,
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `Gemini API request failed (${res.status} ${res.statusText}): ${errText.slice(0, 400)}`
      );
    }

    const data = (await res.json()) as any;
    const text =
      data.candidates?.[0]?.content?.parts
        ?.map((p: any) => p.text ?? "")
        .join("") ?? "";
    return {
      content: text,
      model: cleanModel,
      promptTokens: data.usageMetadata?.promptTokenCount,
      completionTokens: data.usageMetadata?.candidatesTokenCount,
    };
  }

  private async completeAnthropicNative(
    model: string,
    req: LLMCompletionRequest
  ): Promise<LLMCompletionResponse> {
    const endpoint = this.baseUrl.endsWith("/messages")
      ? this.baseUrl
      : `${this.baseUrl}/v1/messages`.replace("/v1/v1/", "/v1/");

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        temperature: req.temperature ?? 0.2,
        system: req.systemPrompt,
        messages: [{ role: "user", content: req.userPrompt }],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `Anthropic API request failed (${res.status} ${res.statusText}): ${errText.slice(0, 400)}`
      );
    }

    const data = (await res.json()) as any;
    const text =
      data.content
        ?.filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("") ?? "";
    return {
      content: text,
      model,
      promptTokens: data.usage?.input_tokens,
      completionTokens: data.usage?.output_tokens,
    };
  }

  /**
   * Parses JSON from an LLM response, resiliently stripping markdown code fences if present.
   */
  public static parseJsonResponse<T>(rawText: string, fallback: T): T {
    const cleaned = rawText
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      const firstBrace = cleaned.indexOf("{");
      const lastBrace = cleaned.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        try {
          return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as T;
        } catch {
          return fallback;
        }
      }
      return fallback;
    }
  }
}

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { generateImages } from './image-gen-client.js'
import { getImageGenConfig, imageGenConfigured } from './image-gen-config.js'
import { resolveEnv } from './credential-env.js'

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function resolveWorkspacePath(cwd, path) {
  const target = isAbsolute(path) ? path : resolve(cwd, path)
  if (!target.startsWith(resolve(cwd))) {
    throw new Error(`path escapes the workspace: ${path}`)
  }
  return target
}

/** Register the conceptual-figure image-generation tool ("nano banana" by default). */
export function applyImageGenerate(ctx) {
  ctx.tools.register(defineTool({
    name: 'image_generate',
    description: [
      'Generate a conceptual scientific schematic, diagram, or illustration and write it to the workspace.',
      'Uses Gemini image generation (gemini-2.5-flash-image "nano banana" by default; gemini-3.1-flash-image "nano',
      'banana 2" and gemini-3-pro-image "nano banana pro" also available) — needs GEMINI_API_KEY. Model is set via',
      'Settings -> Academic Harness API keys, the IMAGE_MODEL env var, or the model arg here (highest priority).',
      'Set IMAGE_PROVIDER=openai plus IMAGE_BASE_URL/IMAGE_API_KEY to use an OpenAI-compatible Images API instead.',
      'Do not use this for quantitative data plots or charts — write Python (matplotlib/etc.) for those.',
    ].join(' '),
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Full image instruction: layout, labels, style. Do not invent numbers or data — this is for conceptual figures, not plots.',
      },
      path: {
        type: 'string',
        required: true,
        description: 'Workspace-relative output path, e.g. figures/pathway-schematic.png',
      },
      reference_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Workspace-relative paths to existing images to compose from or edit (Gemini only).',
      },
      provider: { type: 'string', enum: ['gemini', 'openai'], description: 'Overrides IMAGE_PROVIDER for this call.' },
      model: { type: 'string', description: 'Overrides IMAGE_MODEL for this call.' },
      aspect_ratio: { type: 'string', description: 'Gemini aspect ratio, e.g. "16:9".' },
      size: { type: 'string', description: 'OpenAI image size, e.g. "1024x1024".' },
      quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'], description: 'OpenAI image quality.' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        if (!value.ok) return [{ type: 'text', text: value.error ?? 'image generation failed' }]
        return [{ type: 'text', text: `wrote conceptual figure ${value.path} (${value.provider}/${value.model})` }]
      },
    },
    async execute(args, exec) {
      const [geminiApiKey, imageApiKey, settingsModel] = await Promise.all([
        resolveEnv('GEMINI_API_KEY'),
        resolveEnv('IMAGE_API_KEY'),
        resolveEnv('IMAGE_MODEL'),
      ])
      const keyOverrides = { geminiApiKey, imageApiKey }
      const model = args.model?.trim() || settingsModel

      if (!imageGenConfigured(keyOverrides) && !model) {
        return {
          ok: false,
          error: 'image_generate is not configured. Set GEMINI_API_KEY (Settings -> Academic Harness API keys, or the '
            + 'env var) for the default nano-banana path, or IMAGE_MODEL + IMAGE_BASE_URL + IMAGE_API_KEY for an '
            + 'OpenAI-compatible Images API.',
        }
      }
      const cfg = getImageGenConfig({ model, provider: args.provider, ...keyOverrides })
      if (!cfg.apiKey || !cfg.model) {
        return { ok: false, error: 'an image model and API key are required (see the tool description)' }
      }

      const cwd = workspaceRoot(exec)
      let references
      if (Array.isArray(args.reference_paths) && args.reference_paths.length) {
        const { readFileSync } = await import('node:fs')
        references = args.reference_paths.map((path) => {
          const abs = resolveWorkspacePath(cwd, path)
          const buffer = readFileSync(abs)
          const ext = abs.toLowerCase().split('.').pop()
          const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
          return { mimeType, dataBase64: buffer.toString('base64') }
        })
      }

      try {
        const result = await generateImages({
          provider: cfg.provider,
          model: cfg.model,
          prompt: args.prompt,
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          size: args.size,
          quality: args.quality,
          aspectRatio: args.aspect_ratio,
          references,
          signal: exec.signal,
        })
        const out = resolveWorkspacePath(cwd, args.path)
        mkdirSync(dirname(out), { recursive: true })
        const image = result.images[0]
        if (!image) return { ok: false, error: 'provider returned no image' }
        writeFileSync(out, image.buffer)
        return { ok: true, path: args.path, provider: result.provider, model: result.model }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: 'Generate figure',
        kind: 'other',
        locations: args.path ? [{ path: args.path }] : undefined,
      }
    },
  }))
}

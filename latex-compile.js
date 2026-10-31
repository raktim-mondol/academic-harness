import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'

const execFileAsync = promisify(execFile)
const ENGINES = ['pdflatex', 'xelatex', 'lualatex']
const COMMAND_TIMEOUT_MS = 60_000
const MAX_LOG_RETURN = 8_000

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function resolveWorkspacePath(cwd, path) {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

function clampLog(log) {
  return log.length > MAX_LOG_RETURN ? log.slice(-MAX_LOG_RETURN) : log
}

async function hasCommand(cmd) {
  try {
    await execFileAsync(cmd, ['-version'], { timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

/** Which bibliography tool does this source need, if any? Ignores comments. */
function detectBibTool(src) {
  if (
    /^[^%\n]*\\addbibresource\b/m.test(src)
    || /^[^%\n]*\\usepackage(\[[^\]]*\])?\{biblatex\}/m.test(src)
  ) {
    return 'biber'
  }
  if (/^[^%\n]*\\bibliography\{/m.test(src)) return 'bibtex'
  return null
}

/** Ordered list of argv arrays to run in the target's directory. */
function buildCompilePlan({ engine, targetAbs, hasLatexmk, bibTool }) {
  if (hasLatexmk) {
    // -norc keeps a workspace .latexmkrc from running arbitrary Perl.
    return [['latexmk', '-norc', `-${engine}`, '-interaction=nonstopmode', '-cd', '-file-line-error', '-synctex=1', targetAbs]]
  }
  const base = basename(targetAbs)
  const stem = base.replace(/\.(tex|latex)$/i, '')
  const engineCmd = [engine, '-no-shell-escape', '-interaction=nonstopmode', '-file-line-error', '-synctex=1', base]
  const plan = [engineCmd]
  if (bibTool) plan.push([bibTool, stem], engineCmd)
  plan.push(engineCmd)
  return plan
}

/** Compile one .tex file in place and return the PDF path or the compiler log. */
export async function compileLatex(cwd, path, engineArg = 'pdflatex') {
  const target = resolveWorkspacePath(cwd, path)
  if (!existsSync(target)) return { success: false, error: `file not found: ${path}` }

  const engine = ENGINES.includes(engineArg) ? engineArg : 'pdflatex'
  const workDir = dirname(target)
  const stem = basename(target).replace(/\.(tex|latex)$/i, '')
  const pdfAbs = join(workDir, `${stem}.pdf`)
  const src = readFileSync(target, 'utf8')
  const hasLatexmk = await hasCommand('latexmk')
  const plan = buildCompilePlan({
    engine,
    targetAbs: target,
    hasLatexmk,
    bibTool: hasLatexmk ? null : detectBibTool(src),
  })

  let log = ''
  let lastStatus = 0
  for (const [cmd, ...cmdArgs] of plan) {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
        cwd: workDir,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
      })
      log += `${stdout}${stderr}`
      lastStatus = 0
    } catch (error) {
      log += `${error.stdout ?? ''}${error.stderr ?? ''}`
      if (error.code === 'ENOENT') {
        return { success: false, error: `LaTeX compiler not found. Install TeX Live or add ${cmd} to PATH.`, log: clampLog(log) }
      }
      lastStatus = typeof error.code === 'number' ? error.code : 1
      // bibtex/biber failures shouldn't kill the run — the engine pass that
      // follows surfaces the real problem in the log.
      if (cmd !== 'bibtex' && cmd !== 'biber') break
    }
  }

  if (lastStatus === 0 && existsSync(pdfAbs)) {
    return { success: true, pdf_path: path.replace(/\.(tex|latex)$/i, '.pdf'), log: clampLog(log) }
  }
  if (existsSync(pdfAbs) && lastStatus !== 0) {
    return { success: false, log: clampLog(log), error: 'LaTeX compile failed; an older PDF exists and is not treated as the build output' }
  }
  return { success: false, log: clampLog(log), error: lastStatus === 0 ? 'compiler finished but no PDF was written' : 'LaTeX compile failed' }
}

/** Register the LaTeX-to-PDF compile tool. */
export function applyLatexCompile(ctx) {
  ctx.tools.register(defineTool({
    name: 'latex_compile',
    description: 'Compile a LaTeX .tex file in the workspace to PDF using latexmk when available (handles bibtex/biber automatically), otherwise pdflatex/xelatex/lualatex with a bibtex/biber pass when the source needs one. Returns the PDF path or the compiler log.',
    parameters: {
      path: { type: 'string', required: true, description: 'Workspace-relative or absolute .tex path.' },
      engine: { type: 'string', enum: ENGINES, description: 'TeX engine (default pdflatex).' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        if (value.success) return [{ type: 'text', text: `compiled PDF: ${value.pdf_path}` }]
        return [{ type: 'text', text: value.error ?? value.log ?? 'LaTeX compile failed' }]
      },
    },
    async execute(args, exec) {
      return compileLatex(workspaceRoot(exec), args.path, args.engine)
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `Compile ${args.path ?? 'LaTeX'}`,
        kind: 'other',
        locations: args.path ? [{ path: args.path }] : undefined,
      }
    },
  }))
}

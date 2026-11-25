/**
 * dsh-devloop — 把 devloop CLI 包成 DSH 工具，在对话里直接调用（发布版）。
 *
 * 自包含：CLI 与本插件同目录（cli.mjs），不依赖本机绝对路径。
 * 运行方式：
 *  - 在 DSH 里：注册 devloop_* 工具
 *  - 单独用：node cli.mjs <命令>
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-devloop'
export const inject = ['tools']

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEBUG_DIR = join(homedir(), '.dsh', 'dsh-devloop')
const DEBUG_LOG = join(DEBUG_DIR, 'debug.log')
function dlog(msg) {
  try {
    mkdirSync(DEBUG_DIR, { recursive: true })
    appendFileSync(DEBUG_LOG, new Date().toISOString() + ' ' + msg + '\n')
  } catch {}
}

dlog('module evaluated')

export const Config = Schema.object({
  nodePath: Schema.string().default(''),
  cliPath: Schema.string().default(''),
})

const RESULT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      result: { type: 'string', required: true },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.result }],
}

function toResult(report) {
  return { ok: report.ok !== false, result: JSON.stringify(report, null, 2) }
}

/** 决定用哪个可执行文件跑 CLI：配置优先；Electron 下用自身 + ELECTRON_RUN_AS_NODE */
function nodeCommand(config) {
  if (config.nodePath && config.nodePath.trim()) {
    return { cmd: config.nodePath.trim(), env: process.env }
  }
  if (process.versions.electron) {
    return {
      cmd: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }
  }
  return { cmd: process.execPath, env: process.env }
}

export function apply(ctx, config) {
  dlog('apply start')

  const cliPath = (config.cliPath && config.cliPath.trim()) || join(__dirname, 'cli.mjs')

  const runCli = (args) => {
    const { cmd, env } = nodeCommand(config)
    try {
      const r = spawnSync(cmd, [cliPath, ...args, '--json'], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 180_000,
        env,
      })
      const out = (r.stdout || '').trim()
      if (!out) {
        return { ok: false, error: (r.stderr || '').trim() || 'devloop 无输出，exit=' + r.code }
      }
      try {
        return JSON.parse(out)
      } catch (e) {
        return { ok: false, error: '解析 devloop 输出失败: ' + e.message, raw: out.slice(0, 1500) }
      }
    } catch (e) {
      return { ok: false, error: '调用 devloop 失败: ' + (e && e.message) }
    }
  }

  const tools = [
    {
      name: 'devloop_status',
      description:
        '列出工作区里所有 DSH 插件，以及它们在 profile 里的声明、安装和同步状态。用于检查“哪个插件没装、哪个有未同步改动”。只读。',
      parameters: {},
      safe: true,
      execute: async () => toResult(runCli(['status'])),
    },
    {
      name: 'devloop_check',
      description:
        '对工作区里的插件做静态自检：package.json、cordis.patch.yml、index.js 导出、defineTool 的 output、render 返回数组、编码、原生模块、profile 声明状态。只读，不改任何文件。注意这是静态启发式，最终验收仍需装进 profile 重启后看工具列表。',
      parameters: {
        name: { type: 'string', required: true, description: '插件目录名，如 dsh-memory。' },
      },
      safe: true,
      execute: async (args) => toResult(runCli(['check', String(args.name || '')])),
    },
    {
      name: 'devloop_sync',
      description:
        '把工作区插件目录用 robocopy 镜像到 profile/node_modules（排除 _test），并做哈希对比确认一致。不修改 profile/package.json。改完插件代码后使用，之后需要重启 DSH。',
      parameters: {
        name: { type: 'string', required: true, description: '插件目录名。' },
      },
      safe: false,
      execute: async (args) => toResult(runCli(['sync', String(args.name || '')])),
    },
    {
      name: 'devloop_install',
      description:
        '把工作区插件声明进 profile（dependencies + dsh.profile.bundles）并运行 pnpm install。会修改 profile/package.json，但改前强制备份。属真实安装操作，只在用户明确要求安装或重装插件时使用。',
      parameters: {
        name: { type: 'string', required: true, description: '插件目录名。' },
        force: { type: 'boolean', description: '已安装时也强制重装，默认 false。' },
      },
      safe: false,
      execute: async (args) =>
        toResult(runCli(['install', String(args.name || ''), ...(args.force ? ['--force'] : [])])),
    },
    {
      name: 'devloop_logs',
      description: '查看插件自己的调试日志 ~/.dsh/<插件>/debug.log 尾部。插件没写日志时提示文件不存在。',
      parameters: {
        name: { type: 'string', required: true, description: '插件目录名。' },
        tail: { type: 'integer', description: '显示最后多少行，默认 30。' },
      },
      safe: true,
      execute: async (args) =>
        toResult(
          runCli(['logs', String(args.name || ''), ...(args.tail ? ['--tail', String(args.tail)] : [])]),
        ),
    },
    {
      name: 'devloop_new',
      description:
        '在工作区（DEVLOOP_WORKSPACE 或当前目录）下生成一个新的 DSH 插件骨架（含正确的 output/render、cordis.patch.yml、冒烟测试）。目录已存在时默认拒绝，除非 force。',
      parameters: {
        name: { type: 'string', required: true, description: '新插件目录名，字母数字点下划线横线。' },
        desc: { type: 'string', description: '插件描述。' },
        force: { type: 'boolean', description: '覆盖同名文件。' },
      },
      safe: false,
      execute: async (args) =>
        toResult(
          runCli([
            'new',
            String(args.name || ''),
            ...(args.desc ? ['--desc', String(args.desc)] : []),
            ...(args.force ? ['--force'] : []),
          ]),
        ),
    },
  ]

  for (const t of tools) {
    try {
      ctx.tools.register(
        defineTool({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          output: RESULT_OUTPUT,
          isConcurrencySafe: () => Boolean(t.safe),
          execute: t.execute,
        }),
      )
      dlog('tool ' + t.name + ' registered')
    } catch (e) {
      dlog('register ' + t.name + ' failed: ' + (e && e.stack))
      console.error('[dsh-devloop] 注册 ' + t.name + ' 失败: ' + (e && e.message))
    }
  }
}

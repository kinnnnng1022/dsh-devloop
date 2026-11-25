/**
 * scaffold.mjs — `devloop new`：生成一个结构正确的 DSH 插件骨架。
 *
 * 骨架刻意写死 AGENTS.md 里踩过的坑：
 *  - defineTool 必带 output
 *  - render 返回 [{ type: 'text', ... }] 数组
 *  - type: module + dsh.bundle.patch 指向 cordis.patch.yml
 *  - 自带 debug.log（纯英文路径 ~/.dsh/<插件>/debug.log）
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isValidPluginName, WORKSPACE } from './paths.mjs'
import { c, emitReport, fail, heading, info, ok, warn } from './util.mjs'

function packageTemplate(name, desc) {
  return JSON.stringify(
    {
      name,
      version: '0.1.0',
      private: true,
      type: 'module',
      main: 'index.js',
      description: desc,
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    },
    null,
    2,
  ) + '\n'
}

function patchTemplate(name) {
  return `- insert:
    - id: ${name}
      name: ${name}
      config: {}
`
}

function indexTemplate(name, toolName) {
  return `/**
 * ${name} — DSH 插件骨架（devloop 生成）。
 *
 * 注意：
 *  - defineTool 必须带 output
 *  - render 必须返回 content 数组
 *  - 改完代码不会热加载，需要重启 DSH
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = '${name}'
export const inject = ['tools']

const DEBUG_DIR = join(homedir(), '.dsh', '${name}')
const DEBUG_LOG = join(DEBUG_DIR, 'debug.log')
function dlog(msg) {
  try {
    mkdirSync(DEBUG_DIR, { recursive: true })
    appendFileSync(DEBUG_LOG, new Date().toISOString() + ' ' + msg + '\\n')
  } catch {}
}

dlog('module evaluated')

export const Config = Schema.object({
  greeting: Schema.string().default('你好'),
})

const PING_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      greeting: { type: 'string', required: true },
      echo: { type: 'string', required: true },
    },
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

export function apply(ctx, config) {
  dlog('apply start, config=' + JSON.stringify(config))

  try {
    ctx.tools.register(
      defineTool({
        name: '${toolName}',
        description: '${name} 的冒烟工具：回显参数。确认插件已正确加载。',
        parameters: {
          echo: { type: 'string', description: '要回显的文本。' },
        },
        output: PING_OUTPUT,
        isConcurrencySafe: () => true,
        async execute(args) {
          dlog('ping called')
          return {
            greeting: String(config.greeting || '你好'),
            echo: String(args.echo || ''),
          }
        },
      }),
    )
    dlog('tool ${toolName} registered')
  } catch (e) {
    dlog('register ${toolName} failed: ' + (e && e.stack))
    console.error('[${name}] 注册工具失败: ' + (e && e.message))
  }
}
`
}

function coreTemplate(name) {
  return `/**
 * ${name} 的核心逻辑，纯函数，可脱离 DSH 单独测试。
 */

export function normalize(input) {
  return String(input || '').trim()
}
`
}

function readmeTemplate(name) {
  return `# ${name}

devloop 生成的 DSH 插件骨架。

## 开发循环

\`\`\`powershell
# 1. 静态自检
node <devloop仓库路径>/cli.mjs check ${name}

# 2. 同步进 profile（node_modules 里的真实目录）
node <devloop仓库路径>/cli.mjs sync ${name}

# 3. 重启 DSH（bundle 不会热加载）
\`\`\`

## 结构

- \`index.js\` — 插件入口：export name / inject / apply
- \`lib/core.js\` — 可单测的核心逻辑
- \`cordis.patch.yml\` — bundle 注册补丁
- \`_test/smoke.mjs\` — 冒烟测试
`
}

function smokeTemplate(name) {
  return `import assert from 'node:assert'
import { normalize } from '../lib/core.js'

assert.equal(normalize('  hi  '), 'hi')
console.log('[${name}] smoke ok')
`
}

export function scaffold(name, opts = {}) {
  heading(`devloop new ${name}`)

  if (!isValidPluginName(name)) {
    fail(`插件名不合法：${name}（只允许字母、数字、点、下划线、横线）`)
    return emitReport({ command: 'new', ok: false, errors: ['invalid name'] })
  }

  const target = join(WORKSPACE, name)
  if (existsSync(target) && !opts.force) {
    fail(`目录已存在：${target}`)
    info('要覆盖请加 --force（会覆盖同名文件，不删其他文件）')
    return emitReport({ command: 'new', ok: false, errors: ['directory exists'] })
  }

  const toolName = `${name.replace(/[^a-z0-9_]/gi, '_')}_ping`
  const desc = opts.desc || `${name} — DSH 插件`
  const files = {
    'package.json': packageTemplate(name, desc),
    'cordis.patch.yml': patchTemplate(name),
    'index.js': indexTemplate(name, toolName),
    'lib/core.js': coreTemplate(name),
    'README.md': readmeTemplate(name),
    '_test/smoke.mjs': smokeTemplate(name),
  }

  for (const [rel, content] of Object.entries(files)) {
    const full = join(target, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
    ok(`写入 ${rel}`)
  }

  console.log('')
  console.log(`  ${c.dim('插件目录:')} ${target}`)
  console.log(`  ${c.dim('工具名:')}   ${toolName}`)
  console.log('')
  console.log(c.bold('  下一步：'))
  info(`node tools/devloop/cli.mjs check ${name}`)
  info(`node tools/devloop/cli.mjs sync ${name}   # 需先手工装进 profile 一次`)
  warn('bundle 改动不会热加载，改完必须重启 DSH')

  return emitReport({
    command: 'new',
    ok: true,
    data: { name, target, toolName, files: Object.keys(files) },
  })
}

#!/usr/bin/env node
/**
 * devloop — DSH 插件开发闭环 CLI。
 *
 * 用法：
 *   node cli.mjs new <name> [--desc "描述"] [--force]
 *   node cli.mjs check <name>
 *   node cli.mjs sync <name>
 *   node cli.mjs status
 *   node cli.mjs logs <name> [--tail 30]
 *
 * 通用：--json 输出机器可读结果，--no-color 关闭颜色。
 */
import { check } from './lib/check.mjs'
import { install } from './lib/install.mjs'
import { logs, restartHint, status, sync } from './lib/sync.mjs'
import { scaffold } from './lib/scaffold.mjs'
import { c } from './lib/util.mjs'

// --json 时把人类可读输出赶到 stderr，保证 stdout 只有干净的 JSON
if (process.argv.includes('--json')) {
  const toStderr = (...args) => process.stderr.write(args.map((a) => String(a)).join(' ') + '\n')
  console.log = toStderr
  console.warn = toStderr
  console.error = toStderr
}

const VERSION = '0.1.0'

const USAGE = `
${c.bold('devloop')} — DSH 插件开发闭环 CLI  v${VERSION}

${c.bold('命令')}
  new <name>          生成插件骨架（默认写到工作区）
      --desc "..."    插件描述
      --force         目录已存在时覆盖同名文件
  check <name>        静态自检：package.json / cordis.patch.yml / 导出 / 编码 / profile 状态
  install <name>      声明进 profile + pnpm install（改 profile 前强制备份）
      --force         已安装也强制重装
  sync <name>         robocopy 镜像到 profile/node_modules，并做哈希对比
  status              列出工作区插件、profile 安装与同步状态
  logs <name>         查看 ~/.dsh/<name>/debug.log 尾部
      --tail N        显示最后 N 行（默认 30）
  restart             提示如何重启 DSH（不自动执行）
  help                显示本帮助

${c.bold('通用选项')}
  --json              输出机器可读 JSON（人类可读输出会被压掉）
  --no-color          关闭颜色

${c.bold('环境变量')}
  DEVLOOP_WORKSPACE   工作区根（默认从脚本位置推导）
  DEVLOOP_PROFILE     profile 目录（默认 ~/.dsh/profiles/desktop）
  DEVLOOP_NODE        指定 node 可执行文件
`

const argv = process.argv.slice(2)
const command = argv[0] || 'help'
const rest = argv.slice(1)
const positional = []
const flags = {}
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    if ((key === 'tail' || key === 'desc') && rest[i + 1] && !rest[i + 1].startsWith('--')) {
      flags[key] = rest[++i]
    } else {
      flags[key] = true
    }
  } else {
    positional.push(a)
  }
}

function needName() {
  const name = positional[0]
  if (!name) {
    console.log(USAGE)
    process.exitCode = 2
    return null
  }
  return name
}

let report = null
switch (command) {
  case 'new': {
    const name = needName()
    if (name) report = scaffold(name, { desc: flags.desc, force: Boolean(flags.force) })
    break
  }
  case 'check': {
    const name = needName()
    if (name) report = check(name)
    break
  }
  case 'install': {
    const name = needName()
    if (name) report = install(name, { force: Boolean(flags.force) })
    break
  }
  case 'sync': {
    const name = needName()
    if (name) report = sync(name)
    break
  }
  case 'status':
    report = status()
    break
  case 'restart':
    report = restartHint()
    break
  case 'logs': {
    const name = needName()
    if (name) report = logs(name, { tail: flags.tail })
    break
  }
  case 'version':
  case '--version':
  case '-v':
    console.log(`${VERSION}`)
    break
  case 'help':
  case '--help':
  case '-h':
    console.log(USAGE)
    break
  default:
    console.log(`未知命令：${command}`)
    console.log(USAGE)
    process.exitCode = 2
}

if (report && report.ok === false) process.exitCode = 1

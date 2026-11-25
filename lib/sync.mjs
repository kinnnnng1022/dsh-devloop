/**
 * sync.mjs — `devloop sync` / `devloop status` / `devloop logs`
 *
 * sync 只做一件事：把工作区插件目录镜像到 profile/node_modules/<name>。
 * 不动 profile/package.json（那是 install 的事，M2）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { findProfile, isValidPluginName, nodeModulesPath, WORKSPACE } from './paths.mjs'
import {
  c,
  diffDirs,
  emitReport,
  fail,
  heading,
  info,
  ok,
  padDisplay,
  run,
  warn,
} from './util.mjs'

const SKIP = ['node_modules', '.git', '_test']

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function sync(name) {
  const result = { command: 'sync', ok: false, name, errors: [], warnings: [], data: {} }
  heading(`devloop sync ${name}`)

  if (!isValidPluginName(name)) {
    fail(`插件名不合法：${name}`)
    result.errors.push('invalid name')
    return emitReport(result)
  }

  const src = join(WORKSPACE, name)
  if (!existsSync(join(src, 'package.json'))) {
    fail(`工作区里没有这个插件：${src}`)
    result.errors.push('source missing')
    return emitReport(result)
  }

  const prof = findProfile()
  if (!prof.path) {
    fail('没探测到 profile 目录，可用 DEVLOOP_PROFILE 指定')
    result.errors.push('profile not found')
    return emitReport(result)
  }
  info(`工作区  ${src}`)
  info(`Profile ${prof.path}`)

  const profilePkg = readJson(join(prof.path, 'package.json'))
  const dep = profilePkg?.dependencies?.[name]
  if (!dep) {
    fail(`profile 未声明依赖 ${name}，先 install 一次（M2 命令，或手工改 package.json + pnpm install）`)
    result.errors.push('dep not declared')
    return emitReport(result)
  }
  if (String(dep).startsWith('link:')) {
    fail(`profile 用的是 link:，DSH 加载器会静默跳过。改成 file: 后重装。`)
    result.errors.push('link dependency')
    return emitReport(result)
  }

  const dst = nodeModulesPath(prof.path, name)
  if (!existsSync(dst)) {
    fail(`profile 里没有 ${name} 目录，说明还没装过。先装一次再来 sync。`)
    result.errors.push('target missing')
    return emitReport(result)
  }

  const before = diffDirs(src, dst, SKIP)
  const beforeCount = before.added.length + before.changed.length + before.removed.length
  info(`同步前差异：新增 ${before.added.length} / 修改 ${before.changed.length} / 删除 ${before.removed.length}`)
  if (beforeCount === 0) {
    ok('两边已经一致，无需同步')
    result.ok = true
    result.data = { before, after: before, robocopy: null }
    return emitReport(result)
  }

  const r = run('robocopy', [src, dst, '/MIR', '/XD', '_test', 'node_modules', '.git', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'])
  // robocopy: 0-7 成功，>=8 失败
  if (r.code === null || r.code >= 8) {
    fail(`robocopy 失败（exit ${r.code}）`)
    if (r.stderr) console.log(c.dim(r.stderr.slice(0, 800)))
    result.errors.push('robocopy failed')
    return emitReport(result)
  }
  ok(`robocopy 完成（exit ${r.code}，0-7 均为成功）`)

  const after = diffDirs(src, dst, SKIP)
  const afterCount = after.added.length + after.changed.length + after.removed.length
  if (afterCount === 0) {
    ok(`同步后一致（${after.same} 个文件相同）`)
    result.ok = true
  } else {
    warn(`同步后仍有差异：新增 ${after.added.length} / 修改 ${after.changed.length} / 删除 ${after.removed.length}`)
    result.warnings.push('residual diff')
    result.ok = true
  }

  console.log('')
  console.log(`  ${c.bold('记得重启 DSH')}：bundle 代码不会热加载。`)
  result.data = { before, after, robocopy: { code: r.code } }
  return emitReport(result)
}

function listWorkspacePlugins() {
  const out = []
  if (!existsSync(WORKSPACE)) return out
  for (const d of readdirSync(WORKSPACE, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const dir = join(WORKSPACE, d.name)
    const pkg = readJson(join(dir, 'package.json'))
    if (!pkg || !pkg.dsh?.bundle?.patch) continue
    out.push({ name: pkg.name || d.name, dirName: d.name, dir, pkg })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function status() {
  const result = { command: 'status', ok: true, errors: [], warnings: [], plugins: [] }
  heading('devloop status')

  const plugins = listWorkspacePlugins()
  const prof = findProfile()
  if (!prof.path) {
    warn('没探测到 profile 目录，只能列工作区插件')
  }
  const profilePkg = prof.path ? readJson(join(prof.path, 'package.json')) : null
  const deps = profilePkg?.dependencies || {}

  info(`工作区 ${WORKSPACE}（${plugins.length} 个插件）`)
  if (prof.path) info(`Profile ${prof.path}`)

  if (plugins.length === 0) {
    warn('工作区里没有找到带 dsh.bundle.patch 的插件目录')
    return emitReport(result)
  }

  console.log('')
  console.log(
    `  ${c.bold(padDisplay('插件', 24))}${c.bold(padDisplay('版本', 9))}${c.bold(padDisplay('已声明', 8))}${c.bold(padDisplay('已安装', 8))}${c.bold(padDisplay('差异', 8))}备注`,
  )

  for (const p of plugins) {
    const dep = deps[p.name]
    const dst = prof.path ? nodeModulesPath(prof.path, p.name) : null
    const installed = dst && existsSync(dst)
    const diff = installed ? diffDirs(p.dir, dst, SKIP) : null
    const diffCount = diff ? diff.added.length + diff.changed.length + diff.removed.length : null

    let note = ''
    if (dep && String(dep).startsWith('link:')) note = 'link:（会被静默跳过）'
    else if (!dep) note = '未在 profile 声明'
    else if (!installed) note = '声明了但没装'
    else if (diffCount > 0) note = `未同步 ${diffCount} 个文件`
    else note = '已同步'

    const diffText = diffCount === null ? '-' : diffCount === 0 ? '0' : String(diffCount)
    console.log(
      `  ${padDisplay(p.name, 24)}${padDisplay(String(p.pkg.version || '?'), 9)}${padDisplay(dep ? '是' : '否', 8)}${padDisplay(installed ? '是' : '否', 8)}${padDisplay(diffText, 8)}${note}`,
    )

    result.plugins.push({
      name: p.name,
      version: p.pkg.version || null,
      declared: Boolean(dep),
      dependency: dep || null,
      installed: Boolean(installed),
      diff: diffCount,
      note,
    })
  }

  const unsynced = result.plugins.filter((x) => x.installed && x.diff > 0).length
  const undeclared = result.plugins.filter((x) => !x.declared).length
  console.log('')
  if (unsynced > 0) warn(`${unsynced} 个插件有未同步改动 → devloop sync <名字>`)
  if (undeclared > 0) info(`${undeclared} 个插件还没装进 profile`)
  return emitReport(result)
}

export function logs(name, opts = {}) {
  const tail = Math.max(5, Number(opts.tail) || 30)
  const result = { command: 'logs', ok: false, name, errors: [], lines: [] }
  heading(`devloop logs ${name}`)

  const dir = join(homedir(), '.dsh', name)
  const file = join(dir, 'debug.log')
  if (!existsSync(file)) {
    fail(`没有日志：${file}`)
    info('插件没写 debug.log 时这是正常的；也可能名字不对')
    result.errors.push('log missing')
    return emitReport(result)
  }
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/).filter(Boolean)
  const shown = lines.slice(-tail)
  info(`文件 ${file}（${lines.length} 行，显示最后 ${shown.length} 行）`)
  console.log('')
  for (const line of shown) console.log('  ' + line)
  result.ok = true
  result.lines = shown
  return emitReport(result)
}

export function restartHint() {
  const result = { command: 'restart', ok: true, running: null }
  heading('devloop restart')
  info('bundle 改动不会热加载，需要重启 DSH 才能生效。')
  info('做法：从系统托盘退出 DeepSeek Harness，再重新打开。')
  warn('devloop 不自动重启：杀 GUI 会丢当前会话状态。')

  const r = run('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'])
  const running = (r.stdout || '').includes('DeepSeek Harness.exe')
  result.running = running
  console.log('')
  if (running) info('检测到 DSH 正在运行 → 重启它')
  else info('当前没检测到 DSH 进程')
  return emitReport(result)
}

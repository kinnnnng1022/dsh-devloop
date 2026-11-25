/**
 * install.mjs — `devloop install`：把工作区插件声明进 profile 并安装。
 *
 * 安全约束：
 *  - 改 profile/package.json 前强制备份（<file>.bak-<时间戳>）
 *  - 只做增量：dependencies 加一条、bundles 加一项，不重排不删除
 *  - pnpm install 失败时打印备份路径，不自动回滚（避免二次破坏）
 *  - 不碰 node_modules 里的其他插件
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  findNode,
  findPnpm,
  findProfile,
  isValidPluginName,
  nodeModulesPath,
  WORKSPACE,
} from './paths.mjs'
import { c, emitReport, fail, heading, info, ok, run, shortDate, warn } from './util.mjs'

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function install(name, opts = {}) {
  const result = { command: 'install', ok: false, name, errors: [], warnings: [], data: {} }
  heading(`devloop install ${name}`)

  if (!isValidPluginName(name)) {
    fail(`插件名不合法：${name}`)
    result.errors.push('invalid name')
    return emitReport(result)
  }

  // 1. 源插件体检
  const src = join(WORKSPACE, name)
  const srcPkg = readJson(join(src, 'package.json'))
  if (!srcPkg) {
    fail(`工作区里没有可用插件：${src}`)
    result.errors.push('source missing')
    return emitReport(result)
  }
  if (!srcPkg.dsh?.bundle?.patch) {
    fail('package.json 缺 dsh.bundle.patch，装进 profile 也不会被加载')
    result.errors.push('no patch field')
    return emitReport(result)
  }

  // 2. profile
  const prof = findProfile()
  if (!prof.path) {
    fail('没探测到 profile 目录，可用 DEVLOOP_PROFILE 指定')
    result.errors.push('profile not found')
    return emitReport(result)
  }
  info(`工作区  ${src}`)
  info(`Profile ${prof.path}`)

  const pkgPath = join(prof.path, 'package.json')
  const pkg = readJson(pkgPath)
  if (!pkg) {
    fail(`profile package.json 读不出来：${pkgPath}`)
    result.errors.push('profile package unreadable')
    return emitReport(result)
  }
  const bundles = pkg.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) {
    fail('profile 缺 dsh.profile.bundles 数组，结构不对，停下')
    result.errors.push('no bundles array')
    return emitReport(result)
  }

  const depSpec = 'file:' + src.replaceAll('\\', '/')
  const prevDep = pkg.dependencies?.[name]
  const alreadyInBundle = bundles.includes(name)
  const alreadyInstalled = existsSync(nodeModulesPath(prof.path, name))

  // 3. 幂等
  if (prevDep === depSpec && alreadyInBundle && alreadyInstalled && !opts.force) {
    ok('已声明、已装、路径一致，无需重装')
    info('改了代码要同步用：devloop sync ' + name)
    result.ok = true
    result.data = { skipped: true, dependency: prevDep, installed: true }
    return emitReport(result)
  }

  // 4. 备份 + 修改
  const bak = `${pkgPath}.bak-${shortDate()}`
  copyFileSync(pkgPath, bak)
  ok(`已备份 profile/package.json → ${bak}`)

  pkg.dependencies = pkg.dependencies || {}
  pkg.dependencies[name] = depSpec
  const addedBundle = !alreadyInBundle
  if (addedBundle) bundles.push(name)
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

  ok(`dependencies：${name} = ${depSpec}`)
  if (addedBundle) ok(`dsh.profile.bundles 加入：${name}`)
  else info(`bundles 里已有：${name}`)

  // 5. pnpm install
  const nodeInfo = findNode()
  const pnpmPath = findPnpm(nodeInfo.path)
  if (!pnpmPath) {
    fail('没找到 pnpm.cjs，请手工在 profile 跑 pnpm install')
    info('可用 DEVLOOP_PNPM 指定 pnpm.cjs 路径')
    result.errors.push('pnpm not found')
    return emitReport(result)
  }
  const env = {
    ...process.env,
    PATH: dirname(nodeInfo.path) + ';' + (process.env.PATH || ''),
  }
  info(`运行 pnpm install（node=${nodeInfo.path}）…`)
  const r = run(nodeInfo.path, [pnpmPath, 'install'], {
    cwd: prof.path,
    env,
    timeout: 300_000,
  })
  if (r.code !== 0) {
    fail(`pnpm install 失败（exit ${r.code}）`)
    const tail = (r.stderr || r.stdout || '').trim().slice(-2000)
    if (tail) console.log(c.dim(tail))
    info(`配置已改坏的话，用备份恢复：${bak}`)
    result.errors.push('pnpm failed')
    return emitReport(result)
  }
  ok('pnpm install 完成')

  // 6. 验证
  const nm = nodeModulesPath(prof.path, name)
  const installed = existsSync(nm)
  if (installed) ok(`profile/node_modules/${name} 已就位`)
  else {
    warn('node_modules 里没出现目标目录（pnpm 跳过或安装异常）')
    result.warnings.push('target not materialized')
  }

  result.data = {
    backup: bak,
    dependency: readJson(pkgPath)?.dependencies?.[name] || depSpec,
    bundleAdded: addedBundle,
    installed,
  }
  result.ok = true

  console.log('')
  warn('bundle 不会热加载：重启 DSH 后工具才会出现')
  info(`重启后可跑 devloop check ${name} 确认 profile 侧全绿`)
  return emitReport(result)
}

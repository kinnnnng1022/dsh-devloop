/**
 * check.mjs — `devloop check`：静态自检。
 *
 * 诚实边界：全是静态/启发式检查，抓不到运行时错误。
 * 真正的验收永远是「装进 profile → 重启 → 工具出现」。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { findDshVersion, findProfile, nodeModulesPath, WORKSPACE } from './paths.mjs'
import { c, emitReport, encodingOf, fail, heading, info, ok, warn, walkFiles } from './util.mjs'

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function push(result, level, id, message) {
  result.checks.push({ id, level, message })
  if (level === 'error') {
    result.errors.push(message)
    fail(message)
  } else if (level === 'warn') {
    result.warnings.push(message)
    warn(message)
  } else {
    ok(message)
  }
}

export function check(name) {
  const result = {
    command: 'check',
    ok: true,
    name,
    path: '',
    errors: [],
    warnings: [],
    checks: [],
  }
  heading(`devloop check ${name}`)

  const dir = join(WORKSPACE, name)
  result.path = dir

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    push(result, 'error', 'dir', `插件目录不存在：${dir}`)
    result.ok = false
    return emitReport(result)
  }
  info(`目录 ${dir}`)

  // 1. package.json
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) {
    push(result, 'error', 'package-missing', '缺少 package.json')
    result.ok = false
    return emitReport(result)
  }
  const encPkg = encodingOf(pkgPath)
  if (encPkg === 'not-utf8') push(result, 'error', 'package-encoding', 'package.json 不是合法 UTF-8')
  else if (encPkg === 'utf8-bom') push(result, 'warn', 'package-bom', 'package.json 带 BOM，建议去掉')

  let pkg
  try {
    pkg = JSON.parse(readText(pkgPath))
    push(result, 'ok', 'package-json', `package.json 可解析（name=${pkg.name}，version=${pkg.version}）`)
  } catch (e) {
    push(result, 'error', 'package-parse', `package.json 解析失败：${e.message}`)
    result.ok = false
    return emitReport(result)
  }

  // 2. name / type / patch
  if (!pkg.name) push(result, 'error', 'name-missing', 'package.json 缺 name 字段')
  else if (pkg.name !== name) {
    push(result, 'warn', 'name-mismatch', `package.json name=${pkg.name} 与目录名 ${name} 不一致`)
  } else {
    push(result, 'ok', 'name', `name=${pkg.name}`)
  }

  if (pkg.type !== 'module') push(result, 'error', 'type', 'package.json 缺 type: module（DSH 插件用 ESM）')
  else push(result, 'ok', 'type', 'type=module')

  const patchRel = pkg.dsh?.bundle?.patch
  if (!patchRel) push(result, 'error', 'patch-field', 'package.json 缺 dsh.bundle.patch 字段，bundle 不会被加载')
  else push(result, 'ok', 'patch-field', `dsh.bundle.patch=${patchRel}`)

  // 3. cordis.patch.yml
  if (patchRel) {
    const patchPath = join(dir, patchRel)
    if (!existsSync(patchPath)) {
      push(result, 'error', 'patch-missing', `patch 文件不存在：${patchRel}`)
    } else {
      const encPatch = encodingOf(patchPath)
      if (encPatch === 'not-utf8') push(result, 'error', 'patch-encoding', 'cordis.patch.yml 不是合法 UTF-8')
      const text = readText(patchPath) || ''
      if (!/insert\s*:/.test(text)) {
        push(result, 'error', 'patch-insert', 'cordis.patch.yml 缺 insert: 段')
      } else {
        const names = [...text.matchAll(/^\s*name\s*:\s*([^\s#]+)/gm)].map((m) => m[1])
        const ids = [...text.matchAll(/^\s*-\s*id\s*:\s*([^\s#]+)/gm)].map((m) => m[1])
        if (ids.length === 0) {
          push(result, 'error', 'patch-id', 'insert 里没有 - id: 项')
        } else if (names.length > 0 && pkg.name && !names.includes(pkg.name)) {
          push(result, 'warn', 'patch-name', `patch 里的 name（${names.join(',')}）与包名不一致`)
        } else {
          push(result, 'ok', 'patch-ok', `cordis.patch.yml 有效：insert ${ids.length} 项`)
        }
      }
    }
  }

  // 4. main 与 index.js 导出
  const mainRel = pkg.main || 'index.js'
  const mainPath = join(dir, mainRel)
  if (!existsSync(mainPath)) {
    push(result, 'error', 'main-missing', `入口文件不存在：${mainRel}`)
  } else {
    const enc = encodingOf(mainPath)
    if (enc === 'not-utf8') push(result, 'error', 'main-encoding', `${mainRel} 不是合法 UTF-8`)
    const src = readText(mainPath) || ''
    if (/export\s+(const\s+)?name\b/.test(src)) push(result, 'ok', 'export-name', '导出 name')
    else push(result, 'error', 'export-name', '缺 export name（插件名）')

    if (/export\s+(const\s+)?inject\b/.test(src)) push(result, 'ok', 'export-inject', '导出 inject')
    else push(result, 'warn', 'export-inject', '缺 export inject（没有要用的服务时可省略，但要确认是有意的）')

    if (/export\s+(async\s+)?function\s+apply\b|export\s+(const\s+)?apply\b/.test(src)) {
      push(result, 'ok', 'export-apply', '导出 apply')
    } else {
      push(result, 'error', 'export-apply', '缺 export apply(ctx, config)')
    }

    const defineCount = (src.match(/defineTool\s*\(/g) || []).length
    const outputCount = (src.match(/output\s*:/g) || []).length
    if (defineCount > 0) {
      if (outputCount >= defineCount) push(result, 'ok', 'define-output', `defineTool ${defineCount} 处，output 字段齐全`)
      else push(result, 'warn', 'define-output', `defineTool ${defineCount} 处，只找到 ${outputCount} 个 output（启发式，确认没漏）`)
    }

    // render 检查：逐行看 => 之后的第一个非空白字符是不是 [
    const renderPositions = [...src.matchAll(/render\s*:/g)].map((m) => m.index)
    let badRender = 0
    for (const i of renderPositions) {
      const lineEnd = src.indexOf('\n', i)
      const chunk = src.slice(i, lineEnd === -1 ? src.length : lineEnd)
      const arrow = chunk.indexOf('=>')
      if (arrow === -1) continue // 多行写法，启发式放行
      if (!chunk.slice(arrow + 2).trimStart().startsWith('[')) badRender++
    }
    if (badRender > 0) {
      push(result, 'warn', 'render-array', `有 ${badRender} 处 render 可能没返回数组（必须 [{ type: 'text', ... }]）`)
    } else if (renderPositions.length > 0) {
      push(result, 'ok', 'render-array', `render ${renderPositions.length} 处，均返回数组`)
    }
  }

  // 5. 原生模块与版本豁免
  const nodeFiles = walkFiles(dir, []).filter((f) => f.endsWith('.node'))
  if (nodeFiles.length > 0) {
    push(
      result,
      'warn',
      'native-mod',
      `发现原生模块 ${nodeFiles.join(', ')}：DSH 主进程是 Electron（ABI 149），node 编译产物（ABI 137）会 ERR_DLOPEN_FAILED`,
    )
  }

  if (pkg.peerDependencies && Object.keys(pkg.peerDependencies).length > 0) {
    push(
      result,
      'warn',
      'peer-deps',
      `有 peerDependencies（${Object.keys(pkg.peerDependencies).join(', ')}）：版本不匹配会被静默跳过，确认 compatibility.json`,
    )
  }

  // 6. profile 侧状态
  const prof = findProfile()
  if (!prof.path) {
    push(result, 'warn', 'profile', '没探测到 profile 目录，跳过 profile 检查')
  } else {
    const profilePkgPath = join(prof.path, 'package.json')
    try {
      const profilePkg = JSON.parse(readText(profilePkgPath))
      const dep = profilePkg.dependencies?.[name]
      if (!dep) {
        push(result, 'warn', 'profile-dep', `profile 未声明依赖 ${name}（还没 install）`)
      } else if (String(dep).startsWith('link:')) {
        push(result, 'error', 'profile-link', `profile 用的是 link: 依赖，DSH 加载器会静默跳过，必须改 file:`)
      } else {
        push(result, 'ok', 'profile-dep', `profile 依赖：${name} = ${dep}`)
      }
      const nm = nodeModulesPath(prof.path, name)
      if (!existsSync(nm)) push(result, 'warn', 'profile-nm', `profile/node_modules 里没有 ${name}（还没装）`)
      else push(result, 'ok', 'profile-nm', `profile/node_modules/${name} 存在`)
    } catch (e) {
      push(result, 'warn', 'profile-read', `读 profile package.json 失败：${e.message}`)
    }
  }

  const dshVersion = findDshVersion(prof.path)
  if (dshVersion) info(`DSH 版本（推测）：${dshVersion}`)

  const errs = result.checks.filter((x) => x.level === 'error').length
  const warns = result.checks.filter((x) => x.level === 'warn').length
  const oks = result.checks.filter((x) => x.level === 'ok').length
  result.ok = errs === 0

  console.log('')
  const color = errs > 0 ? c.red : warns > 0 ? c.yellow : c.green
  console.log(`  ${color(`结果：${oks} 通过 / ${warns} 警告 / ${errs} 错误`)}`)
  if (result.ok && warns === 0) console.log(`  ${c.dim('静态检查干净。别忘了：装进 profile 重启后才算真正验证。')}`)
  return emitReport(result)
}

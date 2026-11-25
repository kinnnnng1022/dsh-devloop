/**
 * util.mjs — 输出、哈希、文件遍历、子进程，无第三方依赖。
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative } from 'node:path'

const useColor = !process.argv.includes('--no-color') && !process.env.NO_COLOR
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s))
export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  cyan: wrap('36'),
}

export function heading(text) {
  console.log(`\n${c.bold(c.cyan(text))}`)
}

export function ok(msg) {
  console.log(`  ${c.green('✓')} ${msg}`)
}
export function warn(msg) {
  console.log(`  ${c.yellow('!')} ${msg}`)
}
export function fail(msg) {
  console.log(`  ${c.red('✗')} ${msg}`)
}
export function info(msg) {
  console.log(`  ${c.dim('·')} ${msg}`)
}

/** 递归列出文件（相对路径，正斜杠），可选跳过目录名 */
export function walkFiles(root, skipDirs = ['node_modules', '.git', '_test']) {
  const out = []
  const visit = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory()) {
        if (skipDirs.includes(d.name)) continue
        visit(join(dir, d.name))
      } else if (d.isFile()) {
        out.push(relative(root, join(dir, d.name)).replaceAll('\\', '/'))
      }
    }
  }
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) visit(root)
  return out.sort()
}

export function sha256(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

/**
 * 对比两个目录，返回 { added, changed, removed, same }。
 * 任意一侧不存在时返回 exists 标记。
 */
export function diffDirs(src, dst, skipDirs) {
  const a = walkFiles(src, skipDirs)
  const b = walkFiles(dst, skipDirs)
  const setA = new Set(a)
  const setB = new Set(b)
  const added = b.filter((f) => !setA.has(f))
  const removed = a.filter((f) => !setB.has(f))
  const changed = []
  let same = 0
  for (const f of a) {
    if (!setB.has(f)) continue
    if (sha256(join(src, f)) === sha256(join(dst, f))) same++
    else changed.push(f)
  }
  return { added, changed, removed, same }
}

/** 同步调用子进程，返回 { code, stdout, stderr } */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    ...opts,
  })
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

/** 编码体检：返回 'utf8' | 'utf8-bom' | 'not-utf8' | 'missing' */
export function encodingOf(file) {
  try {
    const buf = readFileSync(file)
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8-bom'
    const text = buf.toString('utf8')
    // 无法还原即存在替换字符，说明不是合法 UTF-8
    if (Buffer.from(text, 'utf8').equals(buf) && !text.includes('\uFFFD')) return 'utf8'
    return 'not-utf8'
  } catch {
    return 'missing'
  }
}

/** 统一报告承接 --json */
export function emitReport(report) {
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  }
  return report
}

export function shortDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** 终端显示宽度：中日韩全角字符算 2 */
export function displayWidth(s) {
  let w = 0
  for (const ch of String(s)) {
    w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
  }
  return w
}

export function padDisplay(s, width) {
  const cur = displayWidth(s)
  return cur >= width ? String(s) : String(s) + ' '.repeat(width - cur)
}

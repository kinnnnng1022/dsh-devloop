/**
 * paths.mjs — 路径与环境探测（发布版）。
 *
 * 原则：
 *  - 不写死本机路径：工作区默认当前目录，其余可用环境变量覆盖
 *  - 探测失败返回 null + 原因，不抛异常
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url)) // lib/
export const TOOL_DIR = dirname(HERE) // 包根

/** 工作区根目录：环境变量 → 当前工作目录 */
export const WORKSPACE = process.env.DEVLOOP_WORKSPACE
  ? resolve(process.env.DEVLOOP_WORKSPACE)
  : process.cwd()

/** 找 Node 可执行文件：环境变量 → 当前进程（本身就是 node） */
export function findNode() {
  if (process.env.DEVLOOP_NODE && existsSync(process.env.DEVLOOP_NODE)) {
    return { path: process.env.DEVLOOP_NODE, source: 'env' }
  }
  return { path: process.execPath, source: 'current-process' }
}

/** 找 DSH 主程序（仅用于提示，不执行） */
export function findDshExe() {
  const candidates = [process.env.DSH_EXE].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

/** 探测 profile 目录：desktop 优先，否则取 ~/.dsh/profiles 下第一个有 package.json 的 */
export function findProfile() {
  if (process.env.DEVLOOP_PROFILE) {
    if (existsSync(join(process.env.DEVLOOP_PROFILE, 'package.json'))) {
      return { path: process.env.DEVLOOP_PROFILE, source: 'env' }
    }
    return { path: null, source: 'env-missing' }
  }
  const base = join(homedir(), '.dsh', 'profiles')
  const preferred = join(base, 'desktop')
  if (existsSync(join(preferred, 'package.json'))) return { path: preferred, source: 'default' }
  if (existsSync(base)) {
    const found = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(base, d.name))
      .find((p) => existsSync(join(p, 'package.json')))
    if (found) return { path: found, source: 'scan' }
  }
  return { path: null, source: 'not-found' }
}

/** 读 profile 里声明的 DSH 版本（尽力而为，拿不到返回 null） */
export function findDshVersion(profilePath) {
  if (!profilePath) return null
  const candidates = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  for (const pkg of candidates) {
    const p = join(profilePath, 'node_modules', ...pkg.split('/'), 'package.json')
    if (!existsSync(p)) continue
    try {
      const json = JSON.parse(readFileSync(p, 'utf8'))
      if (json.version) return json.version
    } catch {
      /* ignore */
    }
  }
  return null
}

export function profileDepsPath(profilePath) {
  return join(profilePath, 'package.json')
}

export function nodeModulesPath(profilePath, name) {
  return join(profilePath, 'node_modules', name)
}

/** 找 pnpm.cjs：环境变量 → DSH 自带（node 同级 dependencies/pnpm/bin/pnpm.cjs） */
export function findPnpm(nodePath) {
  if (process.env.DEVLOOP_PNPM && existsSync(process.env.DEVLOOP_PNPM)) {
    return process.env.DEVLOOP_PNPM
  }
  const depsDir = dirname(dirname(dirname(nodePath))) // .../dependencies
  const candidate = join(depsDir, 'pnpm', 'bin', 'pnpm.cjs')
  if (existsSync(candidate)) return candidate
  return null
}

/** 插件名合法性：防路径穿越 */
export function isValidPluginName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(name) && !name.includes('..')
}

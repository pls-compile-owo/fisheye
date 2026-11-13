// 路径与依赖解析：不写死绝对路径，解析顺序：环境变量 → ~/.config/fisheye/config.json → 项目内 bin/ → PATH
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

export const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const WS = process.env.FISHEYE_HOME || PKG_DIR
export const CACHE = path.join(WS, 'cache')
export const OUT = path.join(WS, 'out')
export const CFG_FILE = path.join(os.homedir(), '.config', 'fisheye', 'config.json')
export let LOCAL_CFG = {}
try {
  LOCAL_CFG = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8').replace(/^\uFEFF/, '')) || {}
} catch { LOCAL_CFG = {} }

export function onPath(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore', timeout: 5000 })
    return true
  } catch { return false }
}

/** 按 环境变量 → 配置文件 → 项目内 bin → PATH 的顺序找工具；找不到返回 null */

export function resolveTool(envVar, cfgKey, localCandidates, cmdName) {
  if (process.env[envVar]) return { cmd: process.env[envVar], from: `环境变量 ${envVar}` }
  if (LOCAL_CFG[cfgKey] && fs.existsSync(LOCAL_CFG[cfgKey])) return { cmd: LOCAL_CFG[cfgKey], from: CFG_FILE }
  for (const c of localCandidates) if (fs.existsSync(c)) return { cmd: c, from: '项目内 bin/' }
  if (onPath(cmdName)) return { cmd: cmdName, from: 'PATH' }
  return null
}

export const FFMPEG_RES = resolveTool('FFMPEG', 'ffmpeg', [
  path.join(PKG_DIR, 'bin', 'ffmpeg.exe'), path.join(PKG_DIR, 'bin', 'ffmpeg'),
], 'ffmpeg')

export const PYTHON_RES = resolveTool('PYTHON', 'python', [
  path.join(PKG_DIR, '.venv', 'Scripts', 'python.exe'), path.join(PKG_DIR, '.venv', 'bin', 'python'),
], process.platform === 'win32' ? 'python' : 'python3')

export const FFMPEG = FFMPEG_RES?.cmd ?? null

export const PYTHON = PYTHON_RES?.cmd ?? null

/** B站登录态：环境变量 → config.json → 数据目录 → ~/.config/fisheye/ */

export function resolveCred() {
  if (process.env.BILI_CRED) return process.env.BILI_CRED
  if (LOCAL_CFG.credentials && fs.existsSync(LOCAL_CFG.credentials)) return LOCAL_CFG.credentials
  for (const c of [
    path.join(WS, 'credentials.json'),
    path.join(os.homedir(), '.config', 'fisheye', 'credentials.json'),
  ]) if (fs.existsSync(c)) return c
  return null
}

export const CRED = resolveCred()

// 自检要能诊断「依赖缺失」本身，所以 selftest 时不在下面硬退出

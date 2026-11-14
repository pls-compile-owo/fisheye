// fisheye 的 MCP（Model Context Protocol）server —— 可选组件，不是 fisheye 内核依赖。
//
// 作用：把 fisheye 的能力包装成 MCP 工具（stdio），让 AI agent（DSH / Claude Code /
// Cursor 等支持 MCP 的环境）不必自己拼命令行，就能在 token 预算内「看」一条 B站 视频。
//
// 工具：
//   vwatch_scan —— 快速扫一眼：单段九宫格拼图，直接返回画面
//   vwatch_deep —— 深入看懂：自动规划抽帧 + 官方字幕 → 交给独立 headless 会话读完 →
//                  只返回「它自己看完能写出的」完整复述（不占当前对话上下文）
//
// 工具名沿用 vwatch_*（fisheye 的旧名），以免破坏已有的 MCP 配置；想看 fisheye 本体
// 请直接用 `node fisheye.mjs <命令>`。
//
// ── 可选依赖：fisheye 核心保持零依赖，本文件的两个包请自行安装 ────────────────
//
//   npm i @modelcontextprotocol/sdk zod
//
// 没装这两个包时不要启动本 server —— node 会在 import 阶段直接报 MODULE_NOT_FOUND，
// 这是预期行为（MCP 是可选组件，CLI 本身完全不需要它们）。
//
// 除 npm 包外还需要：
//   · node 18+（与 fisheye 一致）
//   · 同目录的 fisheye.mjs 与 lib/（本仓库）
//   · ffmpeg（FFMPEG 环境变量、~/.config/fisheye/config.json，或 PATH）
//   · B站 登录态（BILI_CRED 或 credentials.json）：两个工具都走 B站 接口
//   · vwatch_deep 的「独立会话复述」需要本机装有 DeepSeek Harness 桌面版；
//     没有时会自动降级，直接返回抽帧规划 + 官方字幕原文
//
// 安全：只认 BV 号（正则提取），execFile 参数数组，不拼命令行、不接受任意路径。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FISHEYE = path.join(HERE, 'fisheye.mjs');
// 与 lib/env.mjs 保持一致：FISHEYE_HOME 可把数据目录挪到别处
const WS = process.env.FISHEYE_HOME || HERE;
const OUT = path.join(WS, 'out');

/** 只认 BV 号（或含 BV 号的链接），防止把任意字符串当参数递进子进程。 */
function normalizeBvid(input) {
  const m = /(BV[0-9A-Za-z]{10})/.exec(String(input ?? '').trim());
  return m ? m[1] : '';
}

function safeTime(v, label) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (!/^\d+(:\d{1,2}){0,2}$/.test(s)) throw new Error(`${label} 时间格式无效：${s}（支持 330 / 5:30 / 1:05:30）`);
  return s;
}

async function runFisheye(args, timeoutMs = 600_000) {
  const { stdout, stderr } = await execFileP(process.execPath, [FISHEYE, ...args], {
    cwd: HERE, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env }
  });
  return `${stdout ?? ''}\n${stderr ?? ''}`;
}

function readManifest(id) {
  try {
    const mf = JSON.parse(fs.readFileSync(path.join(OUT, `${id}-manifest.json`), 'utf8'));
    return Array.isArray(mf?.chunks) ? mf : null;
  } catch { return null; }
}

function readSubs(id) {
  const candidates = [path.join(OUT, `${id}-official-subs.txt`), path.join(OUT, `${id}-official-subs-plain.txt`)];
  for (const f of candidates) {
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t; } catch {}
  }
  return '';
}

// ── 独立 headless 会话（自清洁：临时工作区，跑完即删，会话文件不残留）────────────
function findDesktopExe() {
  const candidates = [
    process.env.DSH_DESKTOP_EXE,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe') : '',
    path.join('C:\\Program Files', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    path.join('C:\\Program Files (x86)', 'DeepSeek Harness', 'DeepSeek Harness.exe')
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || '';
}

function dshHome() { return process.env.DSH_HOME || path.join(os.homedir(), '.dsh'); }

// ── 视频独立会话工作记录（state/video-jobs.jsonl，每行一条）────────────────────
const VIDEO_JOB_FILE = path.join(HERE, 'state', 'video-jobs.jsonl');

function videoJobCount() {
  try {
    const text = fs.readFileSync(VIDEO_JOB_FILE, 'utf8').trim();
    return text ? text.split('\n').filter(Boolean).length : 0;
  } catch { return 0; }
}

function appendVideoJob(job) {
  try {
    fs.mkdirSync(path.dirname(VIDEO_JOB_FILE), { recursive: true });
    fs.appendFileSync(VIDEO_JOB_FILE, JSON.stringify({ seq: videoJobCount() + 1, at: new Date().toISOString(), ...job }) + '\n', 'utf8');
  } catch {}
}

// 清理「僵尸」视频会话：只删 mtime 超过 2 小时的 dsh-video-* 目录。
// 旧实现按前缀全删，两个 vwatch_deep 并发时先完成的会删掉另一个正在用的会话（评审 P2）。
function cleanupVideoSessions({ staleMs = 2 * 60 * 60 * 1000 } = {}) {
  const root = path.join(dshHome(), 'sessions');
  const now = Date.now();
  let removed = 0;
  try {
    for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ws.isDirectory() || !ws.name.includes('dsh-video-')) continue;
      const full = path.join(root, ws.name);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs < staleMs) continue; // 可能是别的进程正在用的会话
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
      } catch { /* 单个失败忽略 */ }
    }
  } catch { /* sessions 目录不存在时忽略 */ }
  return removed;
}

async function runHeadless(prompt, timeoutMs = 600_000) {
  const exe = findDesktopExe();
  if (!exe) throw new Error('找不到 DeepSeek Harness.exe（独立会话模式需要桌面版；可用环境变量 DSH_DESKTOP_EXE 指定）');
  const bin = path.join(path.dirname(exe), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const tmpDir = path.join(os.tmpdir(), `dsh-video-${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshHome() };
  try {
    const { stdout, stderr } = await execFileP(
      exe,
      ['--expose-internals', bin, '--profile', 'headless', prompt],
      { cwd: tmpDir, env, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
    );
    const answer = String(stdout ?? '').trim();
    if (!answer) throw new Error(`headless 没有输出（stderr 末段：${String(stderr ?? '').slice(-500)}）`);
    return answer;
  } finally {
    cleanupVideoSessions();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function buildDeepPrompt(id, fisheyeText, subs, sheets) {
  const sheetList = sheets.length ? sheets.map((s, i) => `${i + 1}. ${s}`).join('\n') : '（本次没有抽帧拼图，只有字幕文本）';
  return [
    '你是独立视频处理会话。请深入看懂下面这条 B站 视频，然后写出完整的视频内容复述，要求达到「你自己逐帧看过画面、也读过字幕」之后的转述水平。',
    '',
    '══ 素材 ══',
    '【fisheye 规划与信息】',
    fisheyeText || '（空）',
    '',
    '【官方字幕全文】',
    subs || '（无官方字幕）',
    '',
    `【抽帧拼图文件（按时间顺序，共 ${sheets.length} 张）】`,
    sheetList,
    '',
    '══ 任务 ══',
    '1. 用 read_image 依次读取上面每一张拼图文件（拼图内部按从左到右、从上到下的时间顺序）。',
    '2. 结合字幕与画面，写出一份完整复述：视频主线；关键桥段按时间顺序，字幕和画面互相印证，画面里有但字幕没说的补上，字幕与画面不一致处指出；出现过的名字、数字、梗、结尾画面。',
    '3. 输出要求：完整、准确、第一人称口吻（「我看下来……」），像自己真的看完后在转述；不要提「拼图/素材/任务/read_image」这些词；只有画面确实糊到无法辨认时才说看不清。',
    '直接输出复述正文，不要标题，不要分点编号。'
  ].join('\n');
}

const server = new McpServer({ name: 'fisheye', version: '0.3.0' });

server.tool(
  'vwatch_scan',
  '快速扫一眼一条 B站 视频：对开头一段抽帧拼成九宫格截图，直接返回画面（不含文字总结）。适合"这是什么视频"这种扫一眼需求；要完整内容请用 vwatch_deep。只读公开视频；约 20~60 秒。',
  {
    bvid: z.string().describe('B站 视频的 BV 号（如 BV1iLYm6VET3）或含 BV 号的视频链接'),
    grid: z.string().optional().describe('抽帧格数：3x3（9帧，默认）、4x4（16帧）、5x5（25帧）')
  },
  async ({ bvid, grid }) => {
    const id = normalizeBvid(bvid);
    if (!id) return { content: [{ type: 'text', text: '没有识别出 BV 号，请传 BV 号或含 BV 号的视频链接。' }] };
    const g = ['3x3', '4x4', '5x5'].includes(String(grid ?? '').trim()) ? String(grid).trim() : '3x3';
    try {
      const out = await runFisheye(['grid', id, '--chunk', '60', '--grid', g]);
      const mf = readManifest(id);
      const sheet = (mf?.chunks ?? []).map((c) => c.sheet).find((s) => s && fs.existsSync(s));
      if (!sheet) {
        return { content: [{ type: 'text', text: `没有生成拼图（BV=${id}）。输出末段：${out.slice(-600)}` }] };
      }
      const bytes = fs.readFileSync(sheet);
      if (bytes.length > 4 * 1024 * 1024) return { content: [{ type: 'text', text: '截图过大，已跳过。' }] };
      return {
        content: [
          { type: 'text', text: `视频开头一段的 ${g} 抽帧画面（BV=${id}，仅第一段；看全片内容请用 vwatch_deep）。` },
          { type: 'image', data: bytes.toString('base64'), mimeType: 'image/jpeg' }
        ]
      };
    } catch (error) {
      const message = String(error?.message ?? error);
      const hint = /timeout|timed out/i.test(message) ? '（超时：视频大或网络慢，稍后再试）' : '';
      return { content: [{ type: 'text', text: `扫一眼失败（BV=${id}）：${message}${hint}` }] };
    }
  }
);

server.tool(
  'vwatch_deep',
  '深入看懂一条 B站 视频：自动按 token 预算决定采样密度、优先读取官方字幕（省 token 且比 OCR 准）、长视频分成多张拼图；然后全部交给独立的视频处理会话读完，只返回「它自己读完能写出的」完整复述（主线+桥段+字幕画面互证+细节），不占当前对话上下文。参数 bvid 传 BV 号或链接；from/to 可只看一段；page 选分P；budget 控制采样密度（默认 20000）。整个流程 1~4 分钟；同一个视频不要重复看。',
  {
    bvid: z.string().describe('B站 视频的 BV 号（如 BV1iLYm6VET3）或含 BV 号的视频链接'),
    from: z.string().optional().describe('只看这一段：起始时间，如 330 / 5:30 / 1:05:30'),
    to: z.string().optional().describe('只看这一段：结束时间，写法同 from'),
    page: z.string().optional().describe('分P 序号（1~200），默认 1'),
    budget: z.string().optional().describe('token 预算（2000~200000），默认 20000；越小采样越稀')
  },
  async ({ bvid, from, to, page, budget }) => {
    const id = normalizeBvid(bvid);
    if (!id) return { content: [{ type: 'text', text: '没有识别出 BV 号，请传 BV 号或含 BV 号的视频链接。' }] };
    let args;
    try {
      args = ['auto', id];
      const b = Number(budget ?? 20000);
      if (Number.isFinite(b)) args.push('--budget', String(Math.min(200000, Math.max(2000, Math.round(b)))));
      const f = safeTime(from, 'from');
      const t = safeTime(to, 'to');
      if (f) args.push('--from', f);
      if (t) args.push('--to', t);
      const p = Number(page ?? 1);
      if (Number.isInteger(p) && p >= 1 && p <= 200) args.push('--p', String(p));
    } catch (error) {
      return { content: [{ type: 'text', text: String(error?.message ?? error) }] };
    }
    const t0 = Date.now();
    try {
      const fisheyeText = (await runFisheye(args)).trim();
      const subs = readSubs(id);
      const mf = readManifest(id);
      const sheets = (mf?.chunks ?? []).map((c) => c.sheet).filter((s) => s && fs.existsSync(s));
      const secs = ((Date.now() - t0) / 1000).toFixed(1);

      let summary = null;
      try {
        summary = await runHeadless(buildDeepPrompt(id, fisheyeText, subs, sheets));
      } catch {}

      const header = `视频：${id}（抽帧+字幕耗时 ${secs}s${summary ? '，独立会话已读完并复述' : '；独立会话不可用，以下为原始素材'}）\n`;
      if (summary) {
        appendVideoJob({ tool: 'vwatch_deep', bvid: id, args: { from: String(from ?? ''), to: String(to ?? ''), page: String(page ?? 1), budget: String(budget ?? 20000) }, chars: summary.length, output: summary });
        return { content: [{ type: 'text', text: `${header}—— 独立会话的完整复述 ——\n${summary}` }] };
      }
      const fallback = [`${header}`, '', fisheyeText, '', subs ? `══ 官方字幕 ══\n${subs}` : ''].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text: fallback }] };
    } catch (error) {
      const message = String(error?.message ?? error);
      const hint = /timeout|timed out/i.test(message) ? '（超时：视频太大/网络慢/预算算出的张数太多，可调小 budget 或加 from/to 缩小范围再试）' : '';
      return { content: [{ type: 'text', text: `深度看视频失败（BV=${id}）：${message}${hint}` }] };
    }
  }
);

await server.connect(new StdioServerTransport());

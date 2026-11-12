/**
 * dsh-agent-reach — 把 Agent Reach CLI 接成 DSH 原生工具。
 *
 * 為什麼要有這一層，而不是讓 agent 直接跑 shell：
 *   1. CLI 的輸出是 15–30 KB 的 JSON（`channels` 一份就 15 KB），直接塞進對話等於每問一次
 *      就把整個能力表重讀一遍。這裡把它壓成結構化摘要（title/url/author/text 前 N 字）。
 *   2. CLI 的 `params` 是依 schema 定的（必填的放位置、其餘是 --flag）。讓模型自己拼
 *      `--subreddit python` 這種字串遲早會錯；這裡用 `agent-reach channels` 的 schema 反推 argv，
 *      參數名寫錯時**回一份合法清單**而不是猜。
 *   3. 監控誠實性：`meta.attempts` 記錄每個後端的結果（bili-cli=NEED_LOGIN、bilibili-api=ok…）。
 *      這條鏈是「哪條路真的回答了」的唯一證據，必須原樣往上報，不能只留最終結果。
 *
 * 只讀：發帖、評論、點讚、私信一律不做（上游紅線，這一層不繞過）。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const pExecFile = promisify(execFile)
const INSTALL_HINT =
  'uv tool install https://github.com/Panniantong/Agent-Reach/releases/latest/download/agent-reach.zip'
const MAX_BUFFER = 32 * 1024 * 1024

function resolveExe() {
  const cands = []
  if (process.env.DSH_AGENT_REACH_EXE) cands.push(process.env.DSH_AGENT_REACH_EXE)
  const home = homedir()
  cands.push(join(home, '.local', 'bin', 'agent-reach.exe'))
  cands.push(join(home, '.local', 'bin', 'agent-reach'))
  for (const c of cands) if (existsSync(c)) return c
  return null
}

/** 跑 CLI，回傳解析後的單一 JSON 物件。上游 1.6+ 每個動作都印一個 JSON。 */
async function callCli(argv, timeoutMs) {
  const exe = resolveExe()
  if (!exe) {
    const err = new Error('REACH_NOT_INSTALLED: 找不到 agent-reach。安裝指令：' + INSTALL_HINT)
    err.code = 'REACH_NOT_INSTALLED'
    throw err
  }
  let stdout = ''
  let stderr = ''
  try {
    const r = await pExecFile(exe, argv, {
      timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8',
    })
    stdout = r.stdout
    stderr = r.stderr
  } catch (e) {
    // 非零離開不代表沒有可解析的 JSON：上游會把錯誤包在 JSON 裡一起印出來。
    stdout = e.stdout || ''
    stderr = e.stderr || ''
    if (!String(stdout).trim()) {
      const err = new Error('REACH_EXEC_FAILED: ' + String(e.message).slice(0, 400) +
        (stderr ? '  stderr: ' + String(stderr).slice(0, 400) : ''))
      err.code = 'REACH_EXEC_FAILED'
      throw err
    }
  }
  const text = String(stdout).trim()
  try {
    return JSON.parse(text)
  } catch {
    const err = new Error('REACH_BAD_OUTPUT: CLI 沒有印出可解析的 JSON（前 300 字）：' + text.slice(0, 300))
    err.code = 'REACH_BAD_OUTPUT'
    throw err
  }
}

// ── channels 能力表（schema 的來源，同時也是 reach_channels 的回應）─────────
let chanCache = null
let chanAt = 0
const CHAN_TTL = 10 * 60 * 1000

async function channelsRaw() {
  if (chanCache && Date.now() - chanAt < CHAN_TTL) return chanCache
  const v = await callCli(['channels'], 60000)
  if (!v || v.ok === false || !Array.isArray(v.channels)) {
    const err = new Error('REACH_CHANNELS_FAILED: ' + JSON.stringify(v && v.error ? v.error : v).slice(0, 300))
    err.code = 'REACH_CHANNELS_FAILED'
    throw err
  }
  chanCache = v.channels
  chanAt = Date.now()
  return chanCache
}

function channelSummary(ch) {
  return {
    channel: ch.name,
    level: ch.level,
    // login 是「這個平台有沒有認證入口」，不是「取公開內容的前提」——分開講，
    // 免得呼叫端把 login 存在讀成「必須登入」。
    has_login: Boolean(ch.login),
    logged_in: ch.login && ch.login.logged_in !== undefined ? ch.login.logged_in : null,
    actions: (ch.actions || []).map((a) => ({
      action: a.name,
      usage: a.usage,
      backends: a.backends,
      params: (a.params || []).map((p) => ({
        name: p.name, required: Boolean(p.required), type: p.type,
        ...(p.default === null || p.default === undefined ? {} : { default: p.default }),
      })),
    })),
  }
}

/**
 * 用 schema 反推 argv：必填的第一個參數放位置，其餘（含選填）一律 --flag。
 * 這樣呼叫端寫 {channel:'bilibili', action:'search', query:'大模型', limit:3}
 * 就會變成 `bilibili search 大模型 --limit 3`。
 */
function buildArgv(channels, input) {
  const channel = String(input.channel || '')
  const action = String(input.action || '')
  const spec = channels.find((c) => c.name === channel)
  if (!spec) {
    throw badInput('channel 不認識：' + JSON.stringify(channel),
      '可用：' + channels.map((c) => c.name).join(', '))
  }
  const act = (spec.actions || []).find((a) => a.name === action)
  if (!act) {
    throw badInput('這個 channel 沒有這個 action：' + channel + ' ' + JSON.stringify(action),
      '可用：' + (spec.actions || []).map((a) => a.name).join(', '))
  }
  const declared = new Map((act.params || []).map((p) => [p.name, p]))
  const unknown = Object.keys(input).filter(
    (k) => !['channel', 'action', 'timeout_ms', 'text_chars', 'include_raw', 'backend'].includes(k) && !declared.has(k),
  )
  if (unknown.length) {
    throw badInput('這個 action 沒有這些參數：' + unknown.join(', '),
      '可用：' + [...declared.keys()].join(', '))
  }
  const argv = [channel, action]
  let positionalUsed = false
  for (const p of act.params || []) {
    const raw = input[p.name]
    if (raw === undefined || raw === null || raw === '') {
      if (p.required) throw badInput('缺少必填參數：' + p.name, '用法：' + act.usage)
      continue
    }
    const value = String(raw)
    const positional = !positionalUsed && Boolean(p.required)
    if (positional) { argv.push(value); positionalUsed = true }
    else argv.push('--' + p.name.replace(/_/g, '-'), value)
  }
  if (input.backend) argv.push('--backend', String(input.backend))
  return { argv, usage: act.usage }
}

function badInput(message, hint) {
  const err = new Error('REACH_BAD_INPUT: ' + message + (hint ? '  → ' + hint : ''))
  err.code = 'REACH_BAD_INPUT'
  return err
}

/** 壓縮上游結果：去掉 raw、截斷 text、保留 attempts 證據鏈。 */
function shape(v, opts = {}) {
  const textChars = Math.max(50, Math.min(4000, Number(opts.text_chars) || 600))
  const attempts = ((v.meta && v.meta.attempts) || []).map((a) => ({
    backend: a.backend, result: a.result,
    ...(a.message ? { message: String(a.message).slice(0, 200) } : {}),
  }))
  const items = (v.items || []).map((it) => {
    const text = it.text == null ? null : String(it.text)
    const row = {
      title: it.title ?? null,
      url: it.url ?? null,
      author: it.author ?? null,
      published_at: it.published_at ?? null,
    }
    if (text !== null) {
      row.text = text.slice(0, textChars)
      if (text.length > textChars) row.text_truncated = true
      row.text_total = text.length
    }
    if (opts.include_raw && it.raw !== undefined) row.raw = it.raw
    return row
  })
  return {
    ok: v.ok === true,
    channel: v.channel ?? null,
    action: v.action ?? null,
    backend_used: v.backend ?? null,
    backends_tried: attempts,
    elapsed_ms: v.meta ? v.meta.elapsed_ms ?? null : null,
    count: items.length,
    error: v.error ? { code: v.error.code, message: v.error.message, hint: v.error.hint ?? null } : null,
    items,
  }
}

const num = (a, k, d) => (a && Number.isFinite(a[k]) ? a[k] : d)

const channelsTool = {
  name: 'reach_channels',
  description:
    '列出 Agent Reach 現在能用的平台與動作（B站/小紅書/X/Reddit/YouTube/GitHub/V2EX/雪球/LinkedIn/Boss/網頁搜尋）。' +
    '回傳每個動作的 params 與後端順序。不確定某平台能做什麼、或呼叫 reach 前不知道參數名時先跑這個。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: '只看這一個平台（省略則全部）' },
    },
  },
  output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
  timeoutMs: 90000,
  isConcurrencySafe: () => true,
  async execute(args) {
    const all = await channelsRaw()
    const want = args && typeof args.channel === 'string' ? args.channel : null
    const list = (want ? all.filter((c) => c.name === want) : all).map(channelSummary)
    if (want && list.length === 0) {
      throw badInput('channel 不認識：' + JSON.stringify(want), '可用：' + all.map((c) => c.name).join(', '))
    }
    return { channels: list }
  },
}

const reachTool = {
  name: 'reach',
  description:
    '用 Agent Reach 讀取登入後才看得到、或自帶搜尋涵蓋不到的平台內容（只讀，不發帖/不留言/不點讚）。' +
    '呼叫形式：{channel, action, ...該動作的參數}，參數名用 reach_channels 查。' +
    '回傳含 backends_tried（每條後端各自成功/失敗）——失敗時 error.code 是 NEED_LOGIN / NEED_SETUP / ' +
    'UPSTREAM_BROKEN / RATE_LIMITED / PLATFORM_BLOCKED / BUSY / NOT_FOUND / TIMEOUT 之一，照 hint 做，' +
    '不要換帳號或重複硬試。**NEED_LOGIN 不等於沒有內容**。',
  parameters: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: '平台名，例：bilibili / xiaohongshu / web / github' },
      action: { type: 'string', description: '動作名，例：search / read / hot / subtitle' },
      limit: { type: 'number', description: '常見參數：回傳幾筆' },
      text_chars: { type: 'number', description: '每筆正文截斷長度，預設 600（上限 4000）' },
      include_raw: { type: 'boolean', description: '連原始 raw 一起回（大，預設不要）' },
      timeout_ms: { type: 'number', description: '逾時毫秒，預設 90000' },
    },
    required: ['channel', 'action'],
    additionalProperties: true,
  },
  output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
  timeoutMs: 190000,
  isConcurrencySafe: () => true,
  async execute(args) {
    const channels = await channelsRaw()
    const { argv } = buildArgv(channels, args || {})
    const timeout = Math.max(5000, Math.min(180000, num(args, 'timeout_ms', 90000)))
    const v = await callCli(argv, timeout)
    return shape(v, args || {})
  },
}

const readTool = {
  name: 'reach_read',
  description:
    '給一個網址，讓 Agent Reach 自動照網域選平台並讀出正文（B站/小紅書/Reddit/V2EX/YouTube/GitHub…；網頁用 Jina，失敗換 Exa）。' +
    '比 reach 少一個「選平台」的步驟。只讀。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要讀的網址' },
      text_chars: { type: 'number', description: '正文截斷長度，預設 1500' },
      timeout_ms: { type: 'number', description: '逾時毫秒，預設 90000' },
    },
    required: ['url'],
  },
  output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
  timeoutMs: 190000,
  isConcurrencySafe: () => true,
  async execute(args) {
    const url = args && typeof args.url === 'string' ? args.url.trim() : ''
    if (!url) throw badInput('url 是必填', '例：https://www.bilibili.com/video/BV1xx411c7mD')
    const timeout = Math.max(5000, Math.min(180000, num(args, 'timeout_ms', 90000)))
    const v = await callCli(['read', url], timeout)
    return shape(v, { text_chars: num(args, 'text_chars', 1500) })
  },
}

export function buildArgvTestable(channels, input) { return buildArgv(channels, input) }
export { buildArgv, shape }

export function apply(ctx) {
  for (const tool of [reachTool, readTool, channelsTool]) {
    try {
      ctx.tools.register(tool)
    } catch (err) {
      console.error('[dsh-agent-reach] ' + tool.name + ' registration skipped: ' + err)
    }
  }
}

export const name = 'agent-reach'
export const inject = ['tools']

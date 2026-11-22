/**
 * 会话成本守卫 / Session cost guard（v0.3 · 自动交接 + 急停/落盘熔断）
 *
 * 触发点：每次工具执行后（tools/post-execute），按「每个 Agent 的累计工具调用数」计数。
 *
 * 命中阈值时做两件事：
 *   1) 往下一步模型上下文注入一条 notice（原有行为，始终保留）；
 *   2) autoHandoff 开启时，**插件自己**建一个新会话：写交接单骨架 → create →
 *      rename 成「【组id】交接：…」→ followup 投一条开始提示 → flush。
 *      组名写进标题；任何按标题归组的客户端（例如会话分组 UI）都能据此把新会话挂到父会话下。
 *
 * 为什么不用模型转手：模型可以不照做。这里走的是调度器投递用的同一套 host API
 * （sessionController.create/rename/resolveAgent + agent.followup + sessions.flush）。
 *
 * 安全约束（缺一不可）：
 *   - 任何一步失败都只 `console.warn`，**绝不 throw 进工具流水线**，notice 照发；
 *   - 只**新建**会话，从不删除/改写任何已有会话；
 *   - 每个 Agent 只自动交接一次；磁盘上已有同 session id 的交接单就不再建；
 *   - 认不出所属分组时**跳过**（宁可让模型按规则手工处理，也不把会话扔进错误的分组）；
 *   - 整段交接带超时（默认 10s），超时按失败处理，notice 退回「请模型手工执行」口径。
 *
 * 配置（cordis.patch.yml 的 config）：
 *   thresholds: number[]     命中即提醒的调用数，默认 [40, 90, 180]
 *   text: string             自定义提醒文案，可用 {count} 占位
 *   autoHandoff: boolean     默认 true；设 false 退回「只提醒」
 *   group: string            强制指定组 id（默认按会话标题前缀 / 关键词推断）
 *   groupsConfig: string     groups.config.json 路径（默认 <cwd>/tools/session-groups/groups.config.json）
 *   handoffDir: string       交接单目录（默认 <cwd>/.team/handoff）
 *   timeoutMs: number        自动交接超时，默认 10000
 *   maxHandoffs: number      日内最多自动交接次数，默认 4（计数落盘，重启不清零）
 *   minGapMs: number         两次交接最小间隔，默认 900000（15 分钟）
 *   stateDir: string         急停/状态/自证目录（默认 <cwd>/.team/session-guard）
 *   __allowAutoHandoff: bool 仅测试用：绕过 autoHandoff:false 跑通交接路径（不设于生产配置）
 *
 * v0.4（R6：故障第一手证据）：GUI 版 Host 不落 stdout，出事时「插件到底加载没加载、加载的是
 * 哪一版」在磁盘上查不到。v0.4 起 apply 一开始就写两份证据，**都不依赖任何一次工具调用**：
 *   - runtime.json：stage=apply、version、loadedAt、pluginSha256/pluginMtime（版本判定）、
 *     thresholds/autoHandoff/熔断参数、pid、profile、证据来源；
 *   - guard.log：append 式日志（2 MB 轮转成 .1），记录每次 apply、阈值命中、交接结果、告警。
 *
 * v0.5（2026-11-21，用户反馈「新老会话切换太烦」）：修一个语义 bug —— 成本闸门判定
 * 「未到拐点、不该交接」时，原实现仍然发「做三件事、开新会话」的全文提醒，等于闸门说不用
 * 交接、文案却逼模型交接。现在闸门否决时改发 makeSoftNotice：只告知「已 N 次、别交接、
 * 继续干活」。阈值同时放宽到 [80,160,320]、闸门 18 万 / ¥4（见 cordis.patch.yml）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'session-guard'

/**
 * 声明依赖的 host 服务：cordis 会等它们就绪再 apply。
 * 少声明会在调用时拿到 undefined —— 那是「插件半残」而不是「插件没装」，更难查。
 */
export const inject = ['sessions', 'sessionController']

/** 本模块绝对路径：既是「加载的是哪一版」的指纹来源，也是从插件位置反推工作区的依据。 */
const MODULE_FILE = fileURLToPath(import.meta.url)
const VERSION = 'v0.5'
const LOG_FILE = 'guard.log'
const LOG_MAX_BYTES = 2 * 1024 * 1024

/**
 * 用 node 跑一个脚本。
 *
 * 坑（2026-11-20 查出）：插件跑在 Electron Host 里，`process.execPath` 指向的是
 * 「DeepSeek Harness.exe」而不是 node.exe；直接 spawn 它 + 一个 .mjs 参数，
 * Electron 会当成「再开一个应用实例」，脚本根本不会执行、也拿不到退出码。
 * 加 ELECTRON_RUN_AS_NODE=1 让它按 node 跑；纯 node 环境下这个变量无副作用。
 */
function spawnNode(args, opts = {}) {
  return spawn(process.execPath, args, {
    ...opts,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
}

/**
 * 本地构造 UserMessage，不 import '@deepseek-ai/dsh-llm'。
 * 原因：本地目录安装的 bundle 解析不到 dsh 安装目录里的包（实测 ERR_MODULE_NOT_FOUND）。
 * 形状与 dsh-llm 的 createUserMessage 一致：{ id, role:'user', content, source }，并深冻结。
 */
function createUserMessage({ content, source }) {
  const message = { id: randomUUID(), role: 'user', content, source }
  const deepFreeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value)
      for (const key of Object.keys(value)) deepFreeze(value[key])
    }
    return value
  }
  return deepFreeze(message)
}

const SUMMARY_MAX = 120
const boundSummary = (text) => (text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX - 1)}…`)

const DEFAULT_THRESHOLDS = [40, 90, 180]

// 2026-11-17 15:4x 级联止血闸。事故根因不是阈值小，而是止损链太长：
//   ① `cordis.patch.yml` 不随热重载重读 → 配置改错要重启才生效，止损慢；
//   ② 熔断计数在内存里 → 重启即清零，重启既能止血也能「复活」连环。
// 2026-11-17 17:xx 恢复自动交接（用户同意「不要再出错」），前提是这两条都已被机制堵住：
//   ③ 急停文件 `.team/session-guard/PAUSE`：存在即只提醒，不重启就生效；
//   ④ 计数落盘 `.team/session-guard/state.json`：重启读回，不再清零。
// 这个常量仍保留：置 true 就是代码层总闸（改完热重载即刻生效，不需要重启）。
export const AUTO_HANDOFF_DISABLED = false

/** 急停/状态目录里的固定文件名。 */
const PAUSE_FILE = 'PAUSE'
const STATE_FILE = 'state.json'
const RUNTIME_FILE = 'runtime.json'

/** 文件指纹（读不到返回空串，绝不让证据采集把 apply 弄挂）。 */
export function sha256Of(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return ''
  }
}

/** 这里像不像本守卫的宿主工作区（有 .team 或分组配置就算）。 */
function looksLikeWorkspace(dir) {
  try {
    if (!dir) return false
    return fs.existsSync(path.join(dir, '.team')) || fs.existsSync(path.join(dir, 'tools', 'session-groups'))
  } catch {
    return false
  }
}

/**
 * apply 阶段还没有任何会话，「目录」只能靠推断。顺序：显式 stateDir > 插件位置反推 > 进程 cwd。
 * 都不像工作区就返回空目录：宁可不写，也不往安装目录 / C 盘乱丢文件。
 * @returns {{dir:string, source:string, workspace:string}}
 */
export function resolveGuardDir({ stateDir, pluginFile = MODULE_FILE, cwd = process.cwd() } = {}) {
  if (stateDir) return { dir: String(stateDir), source: 'config.stateDir', workspace: '' }
  // 本地安装形态：<工作区>\plugins\session-guard\index.js，上两级就是工作区。
  const fromPlugin = pluginFile ? path.resolve(path.dirname(pluginFile), '..', '..') : ''
  if (fromPlugin && looksLikeWorkspace(fromPlugin)) {
    return { dir: path.join(fromPlugin, '.team', 'session-guard'), source: 'plugin-dir', workspace: fromPlugin }
  }
  if (looksLikeWorkspace(cwd)) {
    return { dir: path.join(cwd, '.team', 'session-guard'), source: 'process-cwd', workspace: cwd }
  }
  return { dir: '', source: 'none', workspace: '' }
}

/**
 * 追加一行日志（2 MB 轮转为 .1）。**任何失败都静默吞掉**：证据不能反过来搞坏守卫。
 */
export function appendLogLine(file, line) {
  if (!file) return false
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) {
        const rotated = `${file}.1`
        try { fs.rmSync(rotated, { force: true }) } catch { /* 旧 .1 删不掉就覆盖 */ }
        fs.renameSync(file, rotated)
      }
    } catch { /* 文件还不存在 / 拿不到大小：直接 append */ }
    fs.appendFileSync(file, line, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 本地日键（YYYY-MM-DD），熔断按自然日归零。 */
export function todayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** 读回来的状态一律过一遍：跨天归零、坏值当 0，绝不因为一个坏 JSON 就放行。 */
export function normalizeGuardState(raw, day = todayKey()) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const sameDay = s.day === day
  return {
    day,
    count: sameDay && Number.isInteger(s.count) && s.count >= 0 ? s.count : 0,
    lastAt: sameDay && Number.isFinite(s.lastAt) ? s.lastAt : 0,
    lastSessionId: sameDay ? String(s.lastSessionId || '') : '',
  }
}
/** 级联防护 1：本会话就是一份自动交接出来的子会话（标题由本插件写成「【x】交接：…」）。 */
export function isHandoffChild(title) {
  return /交接：/.test(String(title || ''))
}
/** 级联防护 2：全局熔断（进程内次数 + 最小间隔）。 */
export function breakerTripped(state, maxHandoffs, minGapMs, now = Date.now()) {
  return state.count >= maxHandoffs || now - state.lastAt < minGapMs
}
/** 预算提醒文案（纯函数：单测直接断言，不必真造一次超支）。 */
export function formatBudgetLine(alert) {
  if (!alert || !alert.over) return ''
  const spent = Number(alert.todayCost) || 0
  const budget = Number(alert.budget) || 0
  return `【预算提醒】今日已花 ¥${spent.toFixed(2)}，已超日预算 ¥${budget.toFixed(2)}；继续之前先问用户。`
}
const DEFAULT_TIMEOUT_MS = 10_000
// 熔断默认值（恢复自动交接时收紧：日内最多 4 次、两次至少隔 15 分钟）。
// 注意：这些计数**落盘**，重启不会清零（事故里重启等于把熔断重置）。
const DEFAULT_MAX_HANDOFFS = 3
const DEFAULT_MIN_GAP_MS = 30 * 60 * 1000

const DEFAULT_TEXT = [
  '【session-guard】This session has made {count} tool calls.',
  'A long context makes every additional call more expensive, so the cost gate — not the call count — decides whether a handoff is worth it.',
  'If this session should hand off, do these two things in order:',
  '1) write one handoff note under the configured handoff directory covering: goal, what is done, what is not, next steps, key files, and verification commands;',
  '2) start exactly ONE follow-up session and point it at that note. Do not start more than one, and do not silently drop the note.',
  'Then tell the user, in one line, where the note is and which session continues.',
].join('\n')

/** 校验并规范化 thresholds；非法值直接抛错（宁可加载失败，不要静默失效）。 */
function normalizeThresholds(value) {
  const raw = Array.isArray(value) ? value : DEFAULT_THRESHOLDS
  if (raw.length === 0) throw new Error('session-guard: thresholds 不能为空')
  const out = raw.map((n) => {
    if (!Number.isInteger(n) || n < 1) throw new Error(`session-guard: 非法阈值 ${n}，必须是 >= 1 的整数`)
    return n
  })
  if (new Set(out).size !== out.length) throw new Error('session-guard: thresholds 不能重复')
  return out.sort((a, b) => a - b)
}

function makeReminder(count, template, extra = '') {
  const text = String(template).replaceAll('{count}', String(count)) + (extra ? `\n${extra}` : '')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'session-guard', form: 'notice', summary: boundSummary(`工具调用 × ${count}`) },
  })
}

/** ask 模式的 notice：插件不自己开，交给模型问用户，用户同意才开。 */
function makeAskNotice({ count, gid }) {
  const text = [
    `【会话成本守卫】本会话已累计 ${count} 次工具调用，成本闸门判定**该考虑交接了**，但当前是「询问模式」，插件不会自己开新会话。`,
    '现在只做一件事：用 ask_user_question 问用户，三选一——',
    '① 马上交接：你按 AGENTS.md 第十节写交接单并 schedule_create 开新会话（已验证可投递）；',
    '② 继续本次：什么都不做，接着干，下一个阈值再问一次；',
    '③ 今天别再问：提示用户可建 .team/session-guard/PAUSE 急停文件（不重启即生效）。',
    `若用户选①，交接单与提示词都用【${gid}】开头，新会话标题决定分组。`,
    '不要在这个会话里自行开工新会话以外的收尾动作；用户没选之前什么都别开。',
  ].join('\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'session-guard', form: 'notice', summary: boundSummary(`待确认交接 · 调用 × ${count}`) },
  })
}

/** 闸门否决时的 notice：**只提醒，不催交接**。原实现的 bug 就是这里退回了全文交接指令。 */
function makeSoftNotice({ count, minContext, maxCost, extra = '' }) {
  const wan = Math.max(1, Math.round(Number(minContext || 0) / 10000))
  const text = [
    `【会话成本守卫】本会话已累计 ${count} 次工具调用。`,
    `成本闸门判定：**未到拐点**（上下文 <${wan} 万、累计成本 <¥${maxCost}），不属于该交接的长会话。`,
    '所以：**不要生成交接单，不要 schedule_create 开新会话**，继续在当前会话里干活即可。',
    '下次提醒在下一个阈值；真到拐点了会明确说「可以交接」。',
  ].join('\n') + (extra ? `\n${extra}` : '')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'session-guard', form: 'notice', summary: boundSummary(`未到拐点 · 调用 × ${count}`) },
  })
}

/** 交接成功后的 notice：明确告诉模型「别再建一个」。 */
function makeHandoffNotice({ count, gid, file, newSessionId }) {
  const text = [
    `【会话成本守卫】本会话已累计 ${count} 次工具调用，插件已自动完成交接。`,
    `交接单：${file}`,
    `新会话：${newSessionId}（标题以【${gid}】开头，已归入对应分组）。`,
    '不要再调用 schedule_create 开新会话（会重复）。',
    '现在只做一件事：用一句话告诉用户「交接单在哪、新会话已开好」，然后收尾。',
  ].join('\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'session-guard', form: 'notice', summary: boundSummary(`已自动交接 · 调用 × ${count}`) },
  })
}

/** 交接超时后的 notice：后台可能还在跑，先让模型查一眼，避免重复建会话。 */
function makeTimeoutNotice(count) {
  const text = [
    `【会话成本守卫】本会话已累计 ${count} 次工具调用，自动交接**超时**（可能仍在后台进行）。`,
    '先看会话列表里有没有标题以「【组id】交接：」开头的新会话：',
    '- 有 → 别再建，告诉用户路径即可；',
    '- 没有 → 再按 AGENTS.md 第十节手工走一遍（生成交接单 + schedule_create）。',
  ].join('\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'session-guard', form: 'notice', summary: boundSummary(`交接超时 · 调用 × ${count}`) },
  })
}

const status = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

function safeReadGroups(file) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(cfg.groups) ? cfg.groups : []
  } catch {
    return []
  }
}

/**
 * 最硬的定组信号：工作区已有的分组报告（reports/session-groups.json）。
 * 它就是 client.js 静态映射的来源，覆盖所有已分过组的会话。
 * @returns 组 id，查不到返回空串。
 */
function reportGroupOf(file, sid) {
  try {
    const rep = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const g of rep.groups || []) {
      if ((g.sessions || []).some((s) => String(s.id) === String(sid))) return String(g.id || '')
    }
  } catch {
    /* 报告缺失/损坏都不影响流程 */
  }
  return ''
}

function prefixOf(title) {
  const m = /^\s*【([^】]{1,40})】/.exec(String(title || ''))
  return m ? m[1].trim() : ''
}

/** 组名/组 id 归一：`【DSH·验证流水线（NEXT.md）】` 也能对到 dsh-verify。 */
function matchGroup(name, groups) {
  const key = String(name || '').trim().toLowerCase()
  if (!key) return ''
  const bare = key.split(/[（(]/)[0].trim()
  for (const g of groups) {
    const id = String(g.id || '').toLowerCase()
    const nm = String(g.name || '').toLowerCase()
    if (id === key || id === bare || nm === key || nm === bare) return g.id
  }
  return ''
}

function keywordGroup(title, groups) {
  const t = String(title || '').toLowerCase()
  if (!t) return ''
  let best = ''
  let bestLen = 0
  for (const g of groups) {
    for (const kw of g.keywords || []) {
      const k = String(kw).toLowerCase()
      if (k && t.includes(k) && k.length > bestLen) { best = g.id; bestLen = k.length }
    }
  }
  return best
}

/**
 * 定组（纯函数，便于单测）。
 *
 * 顺序：标题前缀 > 标题关键词 > 分组报告 > defaultGroup(配置) > 兜底组。
 * 2026-11-20 修：早前版本把「defaultGroup / 第一个组」放在标题匹配**之前**，
 * 于是 groups.config.json 一有内容就恒等于 groups[0]（game），
 * 标题里的「【tools】」和关键词全被短路 —— 所有交接都会归错组。
 * 兜底只剩最后一步，并且优先落 meta（元任务·会话管理）而不是第一个组。
 *
 * @returns {{gid:string, reason:string}} gid 为空串表示确实认不出
 */
export function resolveHandoffGroup({ groups = [], title = '', defaultGroup = '', reportGid = '', fallbackGroup = 'meta' } = {}) {
  const prefixGid = matchGroup(prefixOf(title), groups)
  if (prefixGid) return { gid: prefixGid, reason: 'title-prefix' }
  const kwGid = keywordGroup(title, groups)
  if (kwGid) return { gid: kwGid, reason: 'keyword' }
  const rep = String(reportGid || '').trim()
  if (rep) return { gid: rep, reason: 'report' }
  if (defaultGroup) {
    const dg = groups.length ? matchGroup(defaultGroup, groups) : defaultGroup
    if (dg) return { gid: dg, reason: 'default-group' }
  }
  if (groups.length) {
    const g0 = groups.some((g) => String(g.id) === String(fallbackGroup))
      ? fallbackGroup
      : String(groups[0]?.id || '')
    if (g0) return { gid: g0, reason: 'fallback-group' }
  }
  return { gid: '', reason: 'no-group' }
}

const SKELETON = ({ sid, gid, count, when, cwd }) => `# 交接单 · ${gid}

- 生成：${when}（会话成本守卫自动生成）
- 来源会话：${sid}
- 触发：累计 ${count} 次工具调用
- 工作区：${cwd}

> 这份骨架由插件自动创建，**内容需要新会话自己补**：先读来源会话的记录，
> 再把下面几节写实。写不下去的写「未验证」，不要写「应该没问题」。

## 1. 目标（一句话）
<TODO>

## 2. 已完成
<TODO>

## 3. 未完成
<TODO>

## 4. 下一步（按顺序）
1. <TODO>

## 5. 关键文件
- <TODO>

## 6. 验证命令
\`\`\`powershell
# TODO
\`\`\`

## 7. 未验证项 / 已知边界
- <TODO>
`

const PROMPT = ({ gid, sid, file }) => [
  `【${gid}】继续上一个会话的未完成工作。`,
  `来源会话 ${sid}；交接单 ${file}（目标/已完成/未完成/下一步/关键文件/验证命令）。`,
  '先把交接单第 1–7 节补实，再按「未完成」「下一步」接着做；不清楚就问，不要重头调研。',
].join('')

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config = {}) {
  const thresholds = normalizeThresholds(config.thresholds)
  const template = typeof config.text === 'string' && config.text.trim() ? config.text : DEFAULT_TEXT
  // 交接模式：auto=插件自己开；ask=只提醒并让模型问用户；off=只提醒。
  // 兼容旧配置：没写 handoffMode 时，autoHandoff:false 视为 off，否则 auto。
  const handoffMode = (() => {
    const m = typeof config.handoffMode === 'string' ? config.handoffMode.trim().toLowerCase() : ''
    if (m === 'auto' || m === 'ask' || m === 'off') return m
    return config.autoHandoff === false ? 'off' : 'auto'
  })()
  const autoHandoff = !AUTO_HANDOFF_DISABLED && (config.__allowAutoHandoff === true || handoffMode !== 'off')
  const forcedGroup = typeof config.group === 'string' ? config.group.trim() : ''
  const timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS
  const counts = new WeakMap()
  const handedOff = new WeakSet()

  // 全局熔断参数：按**自然日**计次，状态落盘（`.team/session-guard/state.json`），重启读回。
  const maxHandoffs = Number.isInteger(config.maxHandoffs) && config.maxHandoffs > 0 ? config.maxHandoffs : DEFAULT_MAX_HANDOFFS
  const minGapMs = Number.isInteger(config.minGapMs) && config.minGapMs >= 0 ? config.minGapMs : DEFAULT_MIN_GAP_MS

  // —— 成本闸门（2026-11-20 立）——
  // 调用次数只是「用户在干活」的信号，不是成本信号：成本 ≈ 上下文 × 请求数。
  // 因此命中阈值后还要问一次 tools/session-gate：上下文/成本到拐点了吗？
  // 只答不回是**失败关闭**（脚本缺失、超时、非 3 退出码都算「不该交接」）——
  // 宁可退回只提醒，也绝不因为闸门本身出错而多开一个会话。
  const gateEnabled = config.gateEnabled !== false
  const gateScript = typeof config.gateScript === 'string' && config.gateScript.trim()
    ? config.gateScript.trim() : path.join('tools', 'session-gate', 'gate.mjs')
  const gateTimeoutMs = Number.isInteger(config.gateTimeoutMs) && config.gateTimeoutMs > 0 ? config.gateTimeoutMs : 8000
  const gateMinContext = Number.isInteger(config.gateMinContext) && config.gateMinContext > 0 ? config.gateMinContext : 120000
  // 成本阈值必须一并透传：gate 是「上下文 OR 成本」双判据，只调一个等于没调。
  const gateMaxCost = Number.isFinite(config.gateMaxCost) && config.gateMaxCost > 0 ? config.gateMaxCost : 3
  // 认不出分组时的兜底组：不给的话，空标题会话永远走 no-group 跳过。
  const defaultGroup = typeof config.defaultGroup === 'string' ? config.defaultGroup.trim() : ''
  let handoffInFlight = false // 单飞锁：同一时刻只允许一个交接在跑

  // —— 急停 / 状态 / 自证（都在 <cwd>/.team/session-guard/，可用 stateDir 覆盖）——
  const guardDirFor = (cwd) => (config.stateDir ? String(config.stateDir) : path.join(cwd, '.team', 'session-guard'))
  const stateFileFor = (cwd) => path.join(guardDirFor(cwd), STATE_FILE)
  const pauseFileFor = (cwd) => path.join(guardDirFor(cwd), PAUSE_FILE)
  /** 急停开关：文件存在即只提醒。不读配置、不需要重启 —— 事故里最缺的就是这条。 */
  const isPaused = (cwd) => { try { return fs.existsSync(pauseFileFor(cwd)) } catch { return false } }
  const readGuardState = (cwd) => {
    try { return normalizeGuardState(JSON.parse(fs.readFileSync(stateFileFor(cwd), 'utf8'))) } catch { return normalizeGuardState(null) }
  }
  const writeGuardState = (cwd, state) => {
    try {
      fs.mkdirSync(guardDirFor(cwd), { recursive: true })
      fs.writeFileSync(stateFileFor(cwd), JSON.stringify(state, null, 2), 'utf8')
    } catch (err) {
      warn('写熔断状态失败（本次仍按内存计数走）', err?.message || err)
    }
  }
  // —— R6：apply 阶段自证 + 落盘日志（**不等任何一次工具调用**）——
  // apply 时还没有会话，目录只能推断；后续每次事件仍按各自会话的 cwd 落盘。
  const loadedAt = new Date().toISOString()
  const boot = resolveGuardDir({ stateDir: config.stateDir, pluginFile: MODULE_FILE })
  const logLineAt = (dir, level, msg) => appendLogLine(dir ? path.join(dir, LOG_FILE) : '', `${new Date().toISOString()} [${level}] ${msg}\n`)
  const bootLog = (level, msg) => {
    logLineAt(boot.dir, level, msg)
    if (level === 'warn' || level === 'error') console.warn('[session-guard]', msg)
    else console.log('[session-guard]', msg)
  }
  const logFor = (cwd, level, msg) => logLineAt(guardDirFor(cwd), level, msg)

  let runtimeSessionStageAt = ''
  /** 写自证文件：apply 时写 stage=apply；本进程首次工具调用再补写 stage=session（不覆盖成同一份含义）。 */
  const writeRuntime = (cwd, stage = 'session') => {
    const dir = cwd ? guardDirFor(cwd) : boot.dir
    if (!dir) return
    try {
      fs.mkdirSync(dir, { recursive: true })
      let pluginMtime = ''
      try { pluginMtime = fs.statSync(MODULE_FILE).mtime.toISOString() } catch { /* 拿不到 mtime 不影响 */ }
      fs.writeFileSync(path.join(dir, RUNTIME_FILE), JSON.stringify({
        version: VERSION,
        stage,
        loadedAt,
        writtenAt: new Date().toISOString(),
        pid: process.pid,
        node: process.version,
        profile: process.env.DSH_PROFILE || '',
        profileDir: process.env.DSH_PROFILE_DIR || '',
        autoHandoff,
        thresholds,
        maxHandoffs,
        minGapMs,
        timeoutMs,
        inject,
        pluginFile: MODULE_FILE,
        pluginMtime,
        pluginSha256: sha256Of(MODULE_FILE),
        evidenceSource: boot.source,
        guardDir: dir,
        logFile: path.join(dir, LOG_FILE),
        cwd: cwd || boot.workspace || process.cwd(),
        pauseFile: pauseFileFor(cwd || boot.workspace || process.cwd()),
      }, null, 2), 'utf8')
    } catch { /* 自证失败不影响守卫 */ }
  }

  // —— 日预算信号（读 reports/cost-alert.json，必要时后台刷新）——
  // 刷新用的就是 tools/dsh-cost/cost.mjs，最多每 30 分钟一次；失败一律忽略，不影响守卫。
  const dailyBudget = Number(config.dailyBudgetCNY) > 0 ? Number(config.dailyBudgetCNY) : 10
  let budgetAlert = null
  let budgetRefreshing = false
  let budgetLastTry = 0
  const readBudgetAlert = (cwd) => {
    try { return JSON.parse(fs.readFileSync(path.join(cwd, 'reports', 'cost-alert.json'), 'utf8')) } catch { return null }
  }
  const refreshBudget = (cwd) => {
    const now = Date.now()
    if (budgetRefreshing || now - budgetLastTry < 30 * 60 * 1000) return
    const script = config.costScript || path.join(cwd, 'tools', 'dsh-cost', 'cost.mjs')
    if (!fs.existsSync(script)) return
    budgetLastTry = now
    budgetRefreshing = true
    try {
      const child = spawnNode([script, '--days', '1', '--budget', String(dailyBudget), '--out', path.join(cwd, 'reports', 'cost-today')], { cwd, stdio: 'ignore', windowsHide: true })
      child.on('exit', () => { budgetRefreshing = false; budgetAlert = readBudgetAlert(cwd) })
      child.on('error', () => { budgetRefreshing = false })
    } catch { budgetRefreshing = false }
  }
  const budgetLine = () => formatBudgetLine(budgetAlert)

  const warn = (...args) => {
    const msg = args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')
    console.warn('[session-guard]', ...args)
    logLineAt(boot.dir, 'warn', msg)
  }

  // R6 第一件事：**一加载就落盘**，不等任何一次工具调用。
  // GUI 版 Host 不落 stdout，这两份文件就是「插件到底加载没加载、加载的是哪一版」的第一手证据。
  writeRuntime('', 'apply')
  bootLog('info', `apply ${VERSION} pid=${process.pid} autoHandoff=${autoHandoff} thresholds=${thresholds.join('/')} 熔断=${maxHandoffs}次/日·间隔${minGapMs}ms sha256=${sha256Of(MODULE_FILE).slice(0, 12)} 证据来源=${boot.source}`)
  bootLog('info', `模块=${MODULE_FILE}${boot.dir ? '' : '（没有可用证据目录：只写 stdout，不往安装目录/C 盘乱丢）'}`)

  const withTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`自动交接超时（${ms}ms）`)), ms)
      if (typeof timer.unref === 'function') timer.unref()
    }),
  ])

  /** 读取来源会话的标题（用于推断分组）。读不到就返回空串，不阻塞交接。 */
  async function titleOf(sid) {
    try {
      const ac = new AbortController()
      const list = await ctx.sessionController.list({}, ac.signal)
      const hit = (list?.items || []).find((it) => String(it.id) === String(sid))
      return hit?.title || hit?.displayTitle || ''
    } catch (err) {
      warn('读取会话标题失败（不影响后续步骤）', err?.message || err)
      return ''
    }
  }

  /**
   * 自动交接。**任何失败都返回 {ok:false}，绝不抛出。**
   * @returns {Promise<{ok:boolean, gid?:string, file?:string, newSessionId?:string, reason?:string}>}
   */
  /**
   * 问一次成本闸门：只有它判定 LONG（退出码 3）才允许交接。
   * stdio 用 ignore：走管道在受限沙箱里会 EPERM；这里也不需要读它的 stdout。
   */
  function gateAllows(cwd, sid, count) {
    if (!gateEnabled) return Promise.resolve({ ok: true, why: 'gate-disabled' })
    const script = path.isAbsolute(gateScript) ? gateScript : path.join(cwd, gateScript)
    if (!fs.existsSync(script)) {
      logFor(cwd, 'info', `handoff 跳过 reason=gate-missing script=${script}`)
      return Promise.resolve({ ok: false, why: 'gate-missing' })
    }
    return new Promise((resolve) => {
      let settled = false
      const done = (v) => { if (!settled) { settled = true; resolve(v) } }
      let child
      try {
        child = spawnNode([script, '--session', sid, '--max-context', String(gateMinContext), '--max-cost', String(gateMaxCost), '--json'], {
          cwd, stdio: 'ignore', windowsHide: true,
        })
      } catch (err) {
        logFor(cwd, 'warn', `gate 启动失败 ${err?.message || err}`)
        return done({ ok: false, why: 'gate-error' })
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* 已经退出 */ }
        logFor(cwd, 'warn', `gate 超时 ${gateTimeoutMs}ms count=${count}`)
        done({ ok: false, why: 'gate-timeout' })
      }, gateTimeoutMs)
      child.on('exit', (code) => {
        clearTimeout(timer)
        logFor(cwd, 'info', `gate 判定 count=${count} sid=${String(sid).slice(0, 12)} exit=${code}`)
        done({ ok: code === 3, why: code === 3 ? 'gate-long' : `gate-short:${code}` })
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        logFor(cwd, 'warn', `gate 执行失败 ${err?.message || err}`)
        done({ ok: false, why: 'gate-error' })
      })
    })
  }

  async function handoff(agent, count) {
    try {
      const session = agent?.session
      const sid = String(session?.id || '')
      if (!sid) return { ok: false, reason: 'no-session-id' }
      const cwd = session?.header?.cwd || process.cwd()
      // 本次交接所有判断都落进该工作区的 guard.log：出事后不用猜「为什么没交接」。
      const lg = (level, msg) => logFor(cwd, level, msg)

      const groupsPath = config.groupsConfig || path.join(cwd, 'tools', 'session-groups', 'groups.config.json')
      const dir = config.handoffDir || path.join(cwd, '.team', 'handoff')
      const groups = safeReadGroups(groupsPath)

      // 0) 级联防护（2026-11-17 事故后加：交接会话自己到阈值又开一个，无限链）。
      //    a. 急停文件优先：存在就只提醒，连标题都不用读。
      if (isPaused(cwd)) {
        lg('info', `handoff 跳过 reason=paused 急停文件=${pauseFileFor(cwd)}`)
        console.log('[session-guard] 急停文件存在，跳过自动交接（只提醒）')
        return { ok: false, reason: 'paused' }
      }
      //    b. 本会话自己就是一份交接会话（标题由本插件 rename 成「【x】交接：…」）→ 永不再交接；
      const title = await titleOf(sid)
      if (isHandoffChild(title)) {
        lg('info', `handoff 跳过 reason=child-session 标题=${title}`)
        console.log('[session-guard] 本会话是自动交接出来的子会话，跳过自动交接')
        return { ok: false, reason: 'child-session' }
      }
      //    c. 全局熔断：按自然日计次（默认 4 次 / 间隔 15 分钟），状态落盘，重启不清零。
      const state = readGuardState(cwd)
      if (breakerTripped(state, maxHandoffs, minGapMs)) {
        lg('info', `handoff 跳过 reason=breaker 今日已建 ${state.count}/${maxHandoffs} 上次=${state.lastAt ? new Date(state.lastAt).toISOString() : '-'}`)
        console.log(`[session-guard] 熔断中（今日已建 ${state.count}/${maxHandoffs}，间隔 ${minGapMs}ms），跳过自动交接`)
        return { ok: false, reason: 'breaker' }
      }

      // 1) 定组：显式配置 > 会话标题前缀 > 标题关键词 > 工作区分组报告。认不出就跳过，不瞎归类。
      let gid = forcedGroup
      if (gid && groups.length) {
        const matched = matchGroup(gid, groups)
        if (!matched) return { ok: false, reason: `unknown-group:${gid}` }
        gid = matched
      }
      // 兜底组：空标题会话最常见的结局就是 no-group 静默跳过，交接直接消失。
      // 顺序：defaultGroup（配置） → 配置里的第一个组。宁可归错组，也别让交接无声消失。
      if (!gid) {
        if (defaultGroup) {
          gid = (groups.length ? matchGroup(defaultGroup, groups) : defaultGroup) || defaultGroup
          lg('info', `定组 reason=default-group gid=${gid}`)
        } else if (groups.length && groups[0] && groups[0].id) {
          gid = groups[0].id
          lg('warn', `定组 reason=fallback-first-group gid=${gid}（标题无可识别分组，按兜底处理）`)
        }
      }
      if (!gid) {
        gid = matchGroup(prefixOf(title), groups) || keywordGroup(title, groups)
        // 标题是英文/不命中关键词时，退回工作区分组报告（静态映射的权威来源）
        if (!gid) {
          const reportFile = config.reportFile || path.join(cwd, 'reports', 'session-groups.json')
          gid = reportGroupOf(reportFile, sid)
        }
      }
      if (!gid) {
        lg('info', `handoff 跳过 reason=no-group 标题=${title || '(空)'}`)
        console.log('[session-guard] 该会话没有可识别的分组，跳过自动交接（退回只提醒）')
        return { ok: false, reason: 'no-group' }
      }

      // 2) 幂等：磁盘上已有这份 session 的交接单就不再建（重启后也不会重复）。
      fs.mkdirSync(dir, { recursive: true })
      const existing = fs.readdirSync(dir).find((f) => f.endsWith('.md') && f.includes(sid))
      if (existing) {
        lg('info', `handoff 跳过 reason=already-exists 交接单=${existing}`)
        return { ok: false, reason: `already-exists:${existing}` }
      }

      // 3) 先落盘交接单骨架，再建会话；落盘失败即中止。
      const when = new Date().toISOString()
      const file = path.join(dir, `${status()}-${gid}-${sid}.md`)
      try {
        fs.writeFileSync(file, SKELETON({ sid, gid, count, when, cwd }), 'utf8')
      } catch (err) {
        lg('warn', `handoff 中止 reason=write-failed 交接单=${file}`)
        warn('写交接单失败，放弃自动交接', err?.message || err)
        return { ok: false, reason: 'write-failed' }
      }

      // 4) 建会话（idempotent adopt）+ 改名；改名失败不中止，只是可能落进「未归类」。
      //    显式给一个全新 sessionId：不带 id 时 create 可能「收养」本工作区已有的空白会话
      //    （用户正在里面打草稿的那个），那样等于动了别人的东西。给新 id 就是纯新建。
      const created = await ctx.sessionController.create({ cwd, sessionId: `session-${randomUUID()}` })
      const newSessionId = String(created?.sessionId || created?.id || '')
      if (!newSessionId) return { ok: false, reason: 'create-returned-empty' }
      try {
        // 标题里的 8 位必须是**裸 uuid** 前缀：session-groups-ui 靠它把新会话实时挂到父会话下面
        // （/交接：\\s*([0-9a-f]{6,})/）。早先直接 sid.slice(0,8) 会取到 "session-"，等于没写。
        const parentShort = String(sid).replace(/^session-/, '').slice(0, 8)
        await ctx.sessionController.rename({ sessionId: newSessionId, title: `【${gid}】交接：${parentShort}` })
      } catch (err) {
        warn('新会话改名失败（会落进未归类，不影响内容）', err?.message || err)
      }

      // 5) 投开始提示并落盘会话；flush 不确认视为失败（但不能删会话，留着让用户看到）。
      const resolved = await ctx.sessionController.resolveAgent(newSessionId)
      if (!resolved || 'error' in resolved) {
        lg('warn', `handoff 失败 reason=resolve-failed 新会话=${newSessionId} 交接单=${file}`)
        return { ok: false, reason: 'resolve-failed', newSessionId, file }
      }
      resolved.agent.followup(createUserMessage({
        content: [{ type: 'text', text: PROMPT({ gid, sid, file }) }],
        source: { kind: 'session-guard', form: 'notice', summary: boundSummary(`自动交接 → ${newSessionId}`) },
      }))
      const flushed = await ctx.sessions.flush(resolved.agent.session)
      if (!flushed) {
        lg('warn', `handoff 失败 reason=flush-unconfirmed 新会话=${newSessionId}（会话保留，不计次）`)
        return { ok: false, reason: 'flush-unconfirmed', newSessionId, file }
      }

      // 成功才计次（且落盘）：失败/超时不算，避免熔断被无效尝试提前耗尽。
      // 先落盘再返回：万一紧接着崩溃，重启后读回的是「已经建过一个」，不会重来。
      writeGuardState(cwd, {
        day: state.day,
        count: state.count + 1,
        lastAt: Date.now(),
        lastSessionId: newSessionId,
      })
      lg('info', `handoff 成功 gid=${gid} 新会话=${newSessionId} 交接单=${file} 今日计数=${state.count + 1}/${maxHandoffs}`)
      return { ok: true, gid, file, newSessionId }
    } catch (err) {
      warn('自动交接失败（已降级为只提醒）', err?.message || err)
      return { ok: false, reason: 'exception' }
    }
  }

  ctx.on('tools/post-execute', async (exec, _result, next) => {
    let reminder
    if (exec.agent) {
      const count = (counts.get(exec.agent) ?? 0) + 1
      counts.set(exec.agent, count)
      const cwd = exec.agent?.session?.header?.cwd || process.cwd()
      // 首次工具调用补写一次 stage=session：用来区分「加载了但从没用过」和「加载并在用」。
      if (!runtimeSessionStageAt) {
        runtimeSessionStageAt = new Date().toISOString()
        writeRuntime(cwd, 'session')
      }
      if (thresholds.includes(count)) {
        logFor(cwd, 'info', `阈值命中 count=${count} sid=${String(exec.agent?.session?.id || '')}`)
        // 顺手刷新一次日预算（内部有 30 分钟节流，不会每次调用都跑）
        try { refreshBudget(cwd) } catch { /* 预算检查失败不影响守卫 */ }
        // 单飞锁：同一时刻只允许一个交接；失败后本会话不再重试（宁可退回只提醒，也不连撞熔断）。
        if (autoHandoff && !handedOff.has(exec.agent) && !handoffInFlight) {
          // 先过成本闸门：上下文/成本没到拐点就只提醒，绝不因为「调用了 40 次」就开新会话。
          const gate = await gateAllows(cwd, String(exec.agent?.session?.id || ''), count)
          if (!gate.ok) {
            logFor(cwd, 'info', `handoff 跳过 reason=${gate.why} count=${count}`)
            // v0.5：闸门说不交接，就**别催交接**，只发一句软提醒（预算行顺带带上）。
            reminder = makeSoftNotice({ count, minContext: gateMinContext, maxCost: gateMaxCost, extra: budgetLine() })
            const downstream = await next()
            return { ...downstream, additionalContexts: [reminder, ...(downstream.additionalContexts ?? [])] }
          }
          if (handoffMode === 'ask') {
            // 询问模式：插件只发一条「要不要交接」的指令，由模型问用户，用户同意才开。
            logFor(cwd, 'info', `handoff 模式=ask 等待用户确认 count=${count}`)
            reminder = makeAskNotice({ count, gid: defaultGroup || 'tools' })
            const downstream = await next()
            return { ...downstream, additionalContexts: [reminder, ...(downstream.additionalContexts ?? [])] }
          }
          handedOff.add(exec.agent)
          handoffInFlight = true
          let result
          try {
            result = await withTimeout(handoff(exec.agent, count), timeoutMs)
              .catch((err) => ({ ok: false, reason: String(err?.message || err) }))
          } finally {
            handoffInFlight = false
          }
          if (result.ok) {
            console.log(`[session-guard] 已自动交接：${result.file} → ${result.newSessionId}`)
            reminder = makeHandoffNotice({ count, gid: result.gid, file: result.file, newSessionId: result.newSessionId })
          } else {
            warn(`自动交接未完成：${result.reason}；改由模型按规则处理`)
            // 超时是「可能已经建成」的唯一歧义情形，单独提示，避免重复建会话。
            if (/超时/.test(String(result.reason || ''))) reminder = makeTimeoutNotice(count)
          }
        }
        reminder = reminder ?? makeReminder(count, template, budgetLine())
      }
    }
    const downstream = await next()
    if (!reminder) return downstream
    return { ...downstream, additionalContexts: [reminder, ...(downstream.additionalContexts ?? [])] }
  })
}

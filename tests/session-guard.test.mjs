// Offline unit tests for session-guard. No Host, no real sessions: apply() gets
// a stub ctx and a throwaway state directory, so every branch can be exercised.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const W = ROOT
const PLUGIN = pathToFileURL(path.join(ROOT, 'index.js')).href
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'session-guard-test-'))
// A minimal groups fixture: the plugin's default lookup is workspace-specific,
// so tests supply their own table instead of reading one from disk.
const GROUPS = path.join(OUT, 'groups.config.json')
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(GROUPS, JSON.stringify({ groups: [
  { id: 'meta', name: 'Meta', keywords: ['meta'] },
  { id: 'tools', name: 'Tools', keywords: ['tools'] },
  { id: 'ai-image', name: 'AI image', keywords: ['image'] },
] }))
const NO_COST = path.join(OUT, 'no-such-cost.mjs') // makes refreshBudget bail out early: never spawns

const mod = await import(PLUGIN)

let pass = 0
let failed = 0
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) pass++
  else { failed++; console.log(`  FAIL ${name}: 实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`) }
}
const ok = (name, cond) => eq(name, Boolean(cond), true)

function makeCtx({ sid = 'session-abc-12345678', title = '【meta】某个会话', createFails = false, flushOk = true, createDelayMs = 0 } = {}) {
  const calls = { create: 0, rename: [], followup: [], flush: 0, createReq: null }
  const listeners = {}
  const ctx = {
    on: (evt, fn) => { listeners[evt] = fn },
    sessions: { flush: async () => { calls.flush++; return flushOk } },
    sessionController: {
      list: async () => ({ items: [{ id: sid, title, displayTitle: title }] }),
      create: async (req) => {
        calls.create++
        calls.createReq = req
        if (createDelayMs) await new Promise((r) => setTimeout(r, createDelayMs))
        if (createFails) throw new Error('boom-create')
        return { sessionId: req?.sessionId || 'session-new-999' }
      },
      rename: async (req) => { calls.rename.push(req); return { title: req.title, seq: 1 } },
      resolveAgent: async (req) => ({ agent: { session: { id: req?.sessionId || 'session-new-999' }, followup: (m) => calls.followup.push(m) } }),
    },
  }
  return { ctx, calls, listeners }
}

const agentOf = (sid, cwd = W) => ({ session: { id: sid, header: { cwd } } })
const run = async (listeners, n, agent) => {
  let last
  for (let i = 0; i < n; i++) last = await listeners['tools/post-execute']({ agent }, {}, async () => ({}))
  return last
}
const dirOf = (name) => {
  const d = path.join(OUT, name)
  fs.rmSync(d, { recursive: true, force: true })
  return d
}
const stateOf = (d) => {
  try { return JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8')) } catch { return { count: 0 } }
}
const cfg = (stateDir, extra = {}) => ({
  __allowAutoHandoff: true,
  stateDir,
  groupsConfig: GROUPS,
  costScript: NO_COST,
  // 默认关闸门：这些用例测的是交接流程本身；闸门另有专门用例（见「闸门否决」段）。
  gateEnabled: false,
  // 2026-11-20 起「认不出分组」会兜底到 defaultGroup/首组；固定成 meta，老用例的
  // 【meta】 前缀断言才仍然成立（否则会按 groups.config.json 的顺序落到别的组）。
  defaultGroup: 'meta',
  ...extra,
})

console.log('== 纯函数 ==')
eq('子会话识别：交接标题', mod.isHandoffChild('【meta】交接：57cc8eed'), true)
eq('子会话识别：普通标题', mod.isHandoffChild('【meta】继续分组'), false)
eq('子会话识别：空', mod.isHandoffChild(''), false)
eq('熔断：次数到上限', mod.breakerTripped({ count: 4, lastAt: 0 }, 4, 0), true)
eq('熔断：间隔不足', mod.breakerTripped({ count: 0, lastAt: Date.now() }, 4, 900000), true)
eq('熔断：放行', mod.breakerTripped({ count: 1, lastAt: Date.now() - 1000000 }, 4, 900000), false)
eq('预算文案：超支带金额', mod.formatBudgetLine({ over: true, todayCost: 12.5, budget: 10 }), '【预算提醒】今日已花 ¥12.50，已超日预算 ¥10.00；继续之前先问用户。')
eq('预算文案：未超支为空', mod.formatBudgetLine({ over: false, todayCost: 6.53, budget: 10 }), '')
eq('预算文案：无数据为空', mod.formatBudgetLine(null), '')
ok('日键格式', /^\d{4}-\d{2}-\d{2}$/.test(mod.todayKey()))
eq('状态：跨天归零', mod.normalizeGuardState({ day: '2000-01-01', count: 9, lastAt: 1 }, '2026-11-17'), { day: '2026-11-17', count: 0, lastAt: 0, lastSessionId: '' })
eq('状态：坏数据归零', mod.normalizeGuardState({ day: '2026-11-17', count: -3, lastAt: 'x' }, '2026-11-17'), { day: '2026-11-17', count: 0, lastAt: 0, lastSessionId: '' })

console.log('== 未到阈值：不建会话 ==')
{
  const d = dirOf('below')
  const { ctx, calls, listeners } = makeCtx()
  mod.apply(ctx, cfg(d, { thresholds: [2] }))
  await run(listeners, 1, agentOf('session-abc-12345678'))
  eq('未到阈值不建会话', calls.create, 0)
}

console.log('== 正常路径：建 / 改名 / 投递 / flush / 落盘 ==')
{
  const d = dirOf('normal')
  const { ctx, calls, listeners } = makeCtx()
  mod.apply(ctx, cfg(d, { thresholds: [2], handoffDir: path.join(d, 'handoff'), minGapMs: 0 }))
  const agent = agentOf('session-abc-12345678')
  await run(listeners, 1, agent)
  eq('未到阈值不建会话', calls.create, 0)
  const out = await run(listeners, 1, agent)
  eq('到阈值建了 1 个', calls.create, 1)
  eq('create 带 cwd', calls.createReq.cwd, W)
  ok('create 显式新 id', /^session-[0-9a-f-]{36}$/.test(String(calls.createReq.sessionId)))
  ok('改名带前缀', calls.rename[0].title.startsWith('【meta】交接：'))
  eq('改名目标 = 新建 id', calls.rename[0].sessionId, calls.createReq.sessionId)
  eq('投递 1 条提示', calls.followup.length, 1)
  ok('提示以【meta】开头', calls.followup[0].content[0].text.startsWith('【meta】'))
  eq('flush 确认', calls.flush, 1)
  ok('notice 改成自动口径', /已自动完成交接/.test(out.additionalContexts[0].content[0].text))
  ok('交接单含 session id', fs.readdirSync(path.join(d, 'handoff')).some((f) => f.includes('session-abc-12345678')))
  eq('状态：计次 1', stateOf(d).count, 1)
  eq('状态：记下新会话', stateOf(d).lastSessionId, calls.createReq.sessionId)
  const rt = JSON.parse(fs.readFileSync(path.join(d, 'runtime.json'), 'utf8'))
  eq('自证：autoHandoff', rt.autoHandoff, true)
  eq('自证：阈值', rt.thresholds, [2])
}

console.log('== 幂等：同一 Agent 只交接一次 ==')
{
  const d = dirOf('idem')
  const { ctx, calls, listeners } = makeCtx()
  mod.apply(ctx, cfg(d, { thresholds: [1, 2], handoffDir: path.join(d, 'handoff'), minGapMs: 0 }))
  const agent = agentOf('session-abc-12345678')
  await run(listeners, 2, agent)
  eq('两个阈值只建 1 个', calls.create, 1)
}

console.log('== 降级：create 抛错 → 只提醒，且本会话不再重试 ==')
{
  const d = dirOf('fail')
  const { ctx, calls, listeners } = makeCtx({ createFails: true })
  mod.apply(ctx, cfg(d, { thresholds: [1, 2], handoffDir: path.join(d, 'handoff'), minGapMs: 0 }))
  const agent = agentOf('session-abc-12345678')
  const out = await run(listeners, 1, agent)
  ok('降级后仍有 notice', /【session-guard】/.test(out.additionalContexts[0].content[0].text))
  eq('没有 followup', calls.followup.length, 0)
  await run(listeners, 1, agent)
  eq('失败后不重试（create 只试过 1 次）', calls.create, 1)
  eq('失败不计次', stateOf(d).count, 0)
}

console.log('== 降级：无分组 → 跳过 ==')
{
  const d = dirOf('nogroup')
  // 真正测「认不出分组」：分组表为空 + 不配 defaultGroup，兜底也拿不到组。
  const emptyGroups = path.join(d, 'empty-groups.json')
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(emptyGroups, JSON.stringify({ groups: [] }))
  const { ctx, calls, listeners } = makeCtx({ title: '一个没有任何关键词的标题 zzz' })
  mod.apply(ctx, cfg(d, { thresholds: [1], handoffDir: path.join(d, 'handoff'), reportFile: path.join(d, 'none.json'), minGapMs: 0,
    defaultGroup: '', groupsConfig: emptyGroups }))
  const out = await run(listeners, 1, agentOf('session-abc-12345678'))
  eq('无分组不建会话', calls.create, 0)
  ok('仍然提醒', /【session-guard】/.test(out.additionalContexts[0].content[0].text))
}

console.log('== 降级：flush 未确认 → 不算成功 ==')
{
  const d = dirOf('flush')
  const { ctx, listeners } = makeCtx({ flushOk: false })
  mod.apply(ctx, cfg(d, { thresholds: [1], handoffDir: path.join(d, 'handoff'), minGapMs: 0 }))
  await run(listeners, 1, agentOf('session-abc-12345678'))
  eq('flush 不确认不计次', stateOf(d).count, 0)
}

console.log('== 降级：超时 → 单独提示 ==')
{
  const d = dirOf('timeout')
  const { ctx, listeners } = makeCtx({ createDelayMs: 300 })
  mod.apply(ctx, cfg(d, { thresholds: [1], handoffDir: path.join(d, 'handoff'), timeoutMs: 50, minGapMs: 0 }))
  const out = await run(listeners, 1, agentOf('session-abc-12345678'))
  ok('超时给的是超时提示', /超时/.test(out.additionalContexts[0].content[0].text))
}

console.log('== 防级联：子会话跳过 ==')
{
  const d = dirOf('child')
  const { ctx, calls, listeners } = makeCtx({ title: '【meta】交接：57cc8eed' })
  mod.apply(ctx, cfg(d, { thresholds: [1], handoffDir: path.join(d, 'handoff'), minGapMs: 0 }))
  await run(listeners, 1, agentOf('session-abc-12345678'))
  eq('子会话不建新会话', calls.create, 0)
}

console.log('== 防级联：熔断（当日封顶 / 跨天归零）==')
{
  const d = dirOf('breaker')
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ day: mod.todayKey(), count: 4, lastAt: Date.now() }))
  const { ctx, calls, listeners } = makeCtx()
  mod.apply(ctx, cfg(d, { thresholds: [1], handoffDir: path.join(d, 'handoff'), minGapMs: 0 }))
  await run(listeners, 1, agentOf('session-abc-12345678'))
  eq('当日满 4 次不再建', calls.create, 0)
}
{
  const d = dirOf('breaker-yesterday')
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ day: '2000-01-01', count: 4, lastAt: Date.now() }))
  const { ctx, calls, listeners } = makeCtx()
  mod.apply(ctx, cfg(d, { thresholds: [1], handoffDir: path.join(d, 'handoff'), minGapMs: 0 }))
  await run(listeners, 1, agentOf('session-abc-12345678'))
  eq('昨天的计数不拦今天', calls.create, 1)
}

console.log('== 急停文件：PAUSE 存在即只提醒 ==')
{
  const d = dirOf('pause')
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'PAUSE'), '')
  const { ctx, calls, listeners } = makeCtx()
  mod.apply(ctx, cfg(d, { thresholds: [1], handoffDir: path.join(d, 'handoff'), minGapMs: 0 }))
  const out = await run(listeners, 1, agentOf('session-abc-12345678'))
  eq('急停时不建会话', calls.create, 0)
  ok('仍提醒', /【session-guard】/.test(out.additionalContexts[0].content[0].text))
}

console.log('== 持久化熔断：重启不清零 ==')
{
  const d = dirOf('persist')
  const a = makeCtx({ sid: 'session-aaa-11111111' })
  mod.apply(a.ctx, cfg(d, { thresholds: [1], handoffDir: path.join(d, 'handoff'), maxHandoffs: 1, minGapMs: 0 }))
  await run(a.listeners, 1, agentOf('session-aaa-11111111'))
  eq('第一个实例建了 1 个', a.calls.create, 1)
  // 模拟 Host 重启：新的 apply、新的 ctx、内存计数全丢，只有 state.json 留着
  const b = makeCtx({ sid: 'session-bbb-22222222' })
  mod.apply(b.ctx, cfg(d, { thresholds: [1], handoffDir: path.join(d, 'handoff'), maxHandoffs: 1, minGapMs: 0 }))
  await run(b.listeners, 1, agentOf('session-bbb-22222222'))
  eq('新实例读到旧计数，拒绝再建', b.calls.create, 0)
}

console.log('== 闸门否决：只软提醒，不催交接（v0.5）==')
{
  const d = dirOf('gate-no')
  const { ctx, calls, listeners } = makeCtx()
  // gateScript 指向不存在的脚本 → gate-missing → 否决路径
  mod.apply(ctx, cfg(d, { thresholds: [1], handoffDir: path.join(d, 'handoff'), minGapMs: 0,
    gateEnabled: true, gateScript: path.join(d, 'missing-gate.mjs') }))
  const out = await run(listeners, 1, agentOf('session-abc-12345678'))
  eq('闸门否决时不建会话', calls.create, 0)
  const text = out.additionalContexts[0].content[0].text
  ok('文案含「未到拐点」', /未到拐点/.test(text))
  ok('文案明说不要交接', /不要生成交接单/.test(text))
  ok('文案不再叫模型做三件事', !/按顺序做三件事/.test(text))
}

console.log(`\n通过 ${pass}，失败 ${failed}，跳过 0`)
process.exit(failed ? 1 : 0)

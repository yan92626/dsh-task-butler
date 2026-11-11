#!/usr/bin/env node
/**
 * Host-half unit tests for the v0.7 work journal (`host/reports.js`).
 *
 * The journal must read real session content (first ask + last answer), write
 * concrete output instead of status counts, and degrade to a readable local
 * summary when the model or the structure fails.
 *
 * Contract: docs/v0.7-contract.md §2 and §6.3.
 * Run: node --test tests/logs-unit.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_SESSION_DIGESTS,
  REPORT_SECTIONS,
  buildAiSummaryPrompt,
  buildDailySummary,
  collectSessionDigests,
  createReports,
  extractReportBody,
  extractSessionDigest,
  normalizeAiSummary,
} from '../host/reports.js'
import { TaskStore } from '../host/store.js'

const ROOT = '/repo'
const FAKE_CTX = { get: () => undefined, effect: () => () => {}, logger: { warn() {} }, on: () => () => {} }

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ps-logs-'))
  const store = new TaskStore({ dir })
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

async function settleReport(store, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (store.settings.dailyReport.lastStatus === 'running' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return store.settings.dailyReport
}

const NEW_HEADINGS = ['## 一、今日要点', '## 二、逐项记录', '## 三、待跟进', '## 四、明天建议']
const INJECTED_LESSONS = '## 任务管家 · 过往复盘经验（执行任务时必须遵守，避免重犯）'

function at(dateText, hours, minutes) {
  const [year, month, day] = dateText.split('-').map(Number)
  return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime()
}

function transcript(messages) {
  return { messages }
}

function journalData(overrides = {}) {
  return {
    date: '2026-11-11',
    queueTasks: [
      {
        id: 'q1',
        title: '修复登录页',
        status: 'done',
        priority: 'high',
        result: { finalAnswer: '清理了缓存并补充 3 个回归测试，登录页恢复。' },
      },
      { id: 'q2', title: '迁移设置页', status: 'running', lastMessage: '正在重构表单组件，卡在回滚逻辑' },
    ],
    sessionTasks: [{ id: 's1', title: '调试构建脚本', status: 'done' }],
    sessionDigests: [
      {
        id: 's1',
        title: '调试构建脚本',
        ask: '为什么 CI 的缓存一直失效？',
        answer: '发现 lockfile 变更没有提交，补上后缓存命中正常。',
      },
    ],
    ideas: [{ id: 'i1', title: '研究通知中心', status: 'idea' }],
    unfinished: [{ id: 'q2', title: '迁移设置页', status: 'running' }],
    ...overrides,
  }
}

// ---------------------------------------------------------------- constants

test('work journal constants expose the new four sections', () => {
  assert.deepEqual(REPORT_SECTIONS, NEW_HEADINGS)
  assert.equal(MAX_SESSION_DIGESTS, 8)
})

// ---------------------------------------------------------------- session digest

test('extractSessionDigest: first ask, last answer and injected lessons stripped', () => {
  const digest = extractSessionDigest(transcript([
    {
      role: 'user',
      text: `${INJECTED_LESSONS}\n- 旧规则一：先跑测试\n- 旧规则二：别动锁文件\n\n---\n\n# 任务：修复登录页\n\n请排查缓存过期问题`,
    },
    { role: 'assistant', text: '先看一下缓存层。' },
    { role: 'user', text: '补充：Safari 上也能复现。' },
    { role: 'assistant', text: '结论：清理缓存后恢复，已补 3 个回归测试。' },
    { role: 'system', text: 'ignored system note' },
  ]))
  assert.ok(!digest.ask.includes('过往复盘经验'), digest.ask)
  assert.ok(!digest.ask.includes('旧规则一'), digest.ask)
  assert.ok(digest.ask.includes('修复登录页'), digest.ask)
  assert.equal(digest.answer, '结论：清理缓存后恢复，已补 3 个回归测试。')
})

test('extractSessionDigest: ask/answer truncation and empty transcripts', () => {
  const longAsk = 'A'.repeat(600)
  const longAnswer = 'B'.repeat(2000)
  const digest = extractSessionDigest(transcript([
    { role: 'user', text: longAsk },
    { role: 'assistant', text: longAnswer },
  ]))
  assert.equal(digest.ask.length, 400)
  assert.equal(digest.answer.length, 1500)

  const custom = extractSessionDigest(
    transcript([{ role: 'user', text: longAsk }, { role: 'assistant', text: longAnswer }]),
    { askLimit: 10, answerLimit: 20 },
  )
  assert.equal(custom.ask.length, 10)
  assert.equal(custom.answer.length, 20)

  assert.deepEqual(extractSessionDigest({ messages: [] }), { ask: '', answer: '' })
  assert.deepEqual(extractSessionDigest([]), { ask: '', answer: '' })
  assert.deepEqual(extractSessionDigest(null), { ask: '', answer: '' })
  // Messages without text never become the digest.
  assert.deepEqual(extractSessionDigest(transcript([{ role: 'assistant' }])), { ask: '', answer: '' })
})

test("collectSessionDigests: today's sessions only, newest first, capped, failures skipped", async () => {
  const date = '2026-11-11'
  const tasks = [
    {
      id: 't1', title: '会话甲', status: 'done', source: 'session', sessionId: 's1',
      createdAt: at(date, 9, 0), updatedAt: at(date, 10, 0), endedAt: at(date, 10, 0),
    },
    {
      id: 't2', title: '会话乙', status: 'running', source: 'session', sessionId: 's2',
      createdAt: at('2026-11-10', 20, 0), updatedAt: at(date, 12, 0), startedAt: at(date, 11, 0),
    },
    {
      id: 't3', title: '昨天的会话', status: 'done', source: 'session', sessionId: 's3',
      createdAt: at('2026-11-10', 9, 0), updatedAt: at('2026-11-10', 10, 0), endedAt: at('2026-11-10', 10, 0),
    },
    { id: 't4', title: '队列任务', status: 'pending', source: 'queue', createdAt: at(date, 12, 0) },
    {
      id: 't5', title: '会话丙', status: 'done', source: 'session', sessionId: 's4',
      createdAt: at(date, 8, 0), updatedAt: at(date, 8, 30), endedAt: at(date, 8, 30),
    },
    {
      // Newest activity, but its transcript cannot be read: it must be skipped.
      id: 't6', title: '已删除的会话', status: 'done', source: 'session', sessionId: 'sx',
      createdAt: at(date, 13, 0), updatedAt: at(date, 13, 0), endedAt: at(date, 13, 0),
    },
  ]
  const store = { tasks }
  const transcripts = {
    s1: { messages: [{ role: 'user', text: '问甲' }, { role: 'assistant', text: '答甲' }] },
    s2: { messages: [{ role: 'user', text: '问乙' }, { role: 'assistant', text: '答乙' }] },
    's4': { messages: [{ role: 'user', text: '问丙' }, { role: 'assistant', text: '答丙' }] },
    s3: { messages: [{ role: 'user', text: '问丁' }, { role: 'assistant', text: '答丁' }] },
  }
  const bridge = {
    transcript: async sessionId => {
      if (!transcripts[sessionId]) throw new Error('session gone')
      return transcripts[sessionId]
    },
  }

  const digests = await collectSessionDigests({ store, bridge, date })
  assert.deepEqual(digests.map(digest => digest.id), ['t2', 't1', 't5'])
  assert.ok(!digests.some(digest => digest.id === 't6'), 'broken transcript must be skipped')
  assert.equal(digests[0].ask, '问乙')
  assert.equal(digests[0].answer, '答乙')
  assert.equal(digests[0].title, '会话乙')
  assert.ok(digests.every(digest => typeof digest.cwd === 'string' || digest.cwd === undefined))

  // The cap counts the sessions actually returned; a broken newest session
  // must be skipped silently rather than eating the budget (see task-11 report).
  const withoutBroken = { tasks: tasks.filter(task => task.id !== 't6') }
  const limited = await collectSessionDigests({ store: withoutBroken, bridge, date, limit: 2 })
  assert.deepEqual(limited.map(digest => digest.id), ['t2', 't1'])

  // A broken transcript is skipped, never fatal (and did not hide the others).
  assert.equal(digests.length, 3)

  // Other dates only pick the sessions active on that day.
  const yesterday = await collectSessionDigests({ store, bridge, date: '2026-11-10' })
  assert.deepEqual(yesterday.map(digest => digest.id), ['t2', 't3'])

  // A date with nothing is still an empty array.
  assert.deepEqual(await collectSessionDigests({ store, bridge, date: '2026-01-01' }), [])
})

test('collectSessionDigests: default cap is MAX_SESSION_DIGESTS', async () => {
  const date = '2026-11-11'
  const tasks = Array.from({ length: 12 }, (_, index) => ({
    id: `t${index}`,
    title: `会话 ${index}`,
    status: 'done',
    source: 'session',
    sessionId: `s${index}`,
    createdAt: at(date, 8, index),
    updatedAt: at(date, 8, index),
    endedAt: at(date, 8, index),
  }))
  const bridge = {
    transcript: async sessionId => ({ messages: [{ role: 'user', text: `问 ${sessionId}` }, { role: 'assistant', text: '答' }] }),
  }
  const digests = await collectSessionDigests({ store: { tasks }, bridge, date })
  assert.equal(digests.length, MAX_SESSION_DIGESTS)
  assert.equal(digests[0].id, 't11')
})

// ---------------------------------------------------------------- prompt

test('buildAiSummaryPrompt: new structure, real content and specificity constraints', () => {
  const prompt = buildAiSummaryPrompt(journalData())
  assert.ok(prompt.includes('# 2026-11-11 工作日志'), prompt.slice(0, 120))
  for (const heading of NEW_HEADINGS) assert.ok(prompt.includes(heading), heading)
  assert.ok(prompt.includes('工作日志'))
  // Real session content and task results are in the request.
  assert.ok(prompt.includes('为什么 CI 的缓存一直失效？'))
  assert.ok(prompt.includes('lockfile 变更没有提交'))
  assert.ok(prompt.includes('清理了缓存并补充 3 个回归测试'))
  assert.ok(prompt.includes('研究通知中心'))
  assert.ok(prompt.includes('迁移设置页'))
  // Specificity / length / banned-filler constraints.
  assert.ok(/600\s*[–-]\s*900/.test(prompt), 'journal length window')
  assert.ok(/token/i.test(prompt), 'must forbid token/technical detail')
  assert.ok(/不要.*代码块|代码围栏/.test(prompt))
  assert.ok(prompt.includes('会话'))
})

// ---------------------------------------------------------------- fallback

test('buildDailySummary: fallback carries real results instead of status counts', () => {
  const content = buildDailySummary(journalData())
  assert.ok(content.startsWith('# 2026-11-11 工作日志'), content.slice(0, 120))
  for (const heading of NEW_HEADINGS) assert.ok(content.includes(heading), heading)
  // Per-task answer and per-session ask/answer end up in the journal.
  assert.ok(content.includes('清理了缓存并补充 3 个回归测试'), content)
  assert.ok(content.includes('为什么 CI 的缓存一直失效？') || content.includes('lockfile 变更没有提交'), content)
  assert.ok(!/undefined|NaN|\[object Object\]/.test(content))
  assert.ok(!content.includes('```'))
})

test('buildDailySummary: a day with no activity still produces a readable journal', () => {
  const content = buildDailySummary({
    date: '2026-11-11',
    queueTasks: [],
    sessionTasks: [],
    sessionDigests: [],
    ideas: [],
    unfinished: [],
  })
  assert.ok(content.startsWith('# 2026-11-11 工作日志'))
  for (const heading of NEW_HEADINGS) assert.ok(content.includes(heading), heading)
  assert.ok(/没有记录到工作活动|没有工作活动/.test(content), content)
  assert.ok(!/undefined|NaN|\[object Object\]/.test(content))
  assert.ok(content.trim().length > 30)
})

// ---------------------------------------------------------------- normalise

test('normalizeAiSummary: keeps concrete content and drops technical lines', () => {
  const data = journalData()
  const compliant = [
    '# 2026-11-11 工作日志',
    '',
    '## 一、今日要点',
    '',
    '- 登录页已恢复：清理缓存后补充 3 个回归测试（tests/login.spec.ts）。',
    '',
    '## 二、逐项记录',
    '',
    '- **修复登录页**：你交代排查登录失败；我定位到缓存过期；结论是已恢复并补齐测试。',
    '- **调试构建脚本**：你问 CI 缓存为何失效；我查了 lockfile；结论是补提交后命中正常。',
    '',
    '## 三、待跟进',
    '',
    '- 迁移设置页的表单回滚逻辑仍需明天验证。',
    '',
    '## 四、明天建议',
    '',
    '- 先跑全量回归测试，再发布补丁版本。',
    '- 耗时 62 秒，token 使用 12k，模型 deepseek-flash，路径 /repo/login。',
    '',
  ].join('\n')
  const kept = normalizeAiSummary(compliant, '2026-11-11', data)
  assert.equal(kept.fallback, false)
  assert.ok(kept.content.startsWith('# 2026-11-11 工作日志'))
  for (const heading of NEW_HEADINGS) assert.ok(kept.content.includes(heading), heading)
  assert.ok(kept.content.includes('tests/login.spec.ts'))
  assert.ok(kept.content.includes('lockfile'))
  // Technical detail lines are filtered out entirely.
  assert.ok(!kept.content.includes('deepseek-flash'), kept.content)
  assert.ok(!kept.content.includes('/repo/login'), kept.content)
  assert.ok(!kept.content.includes('token 使用'), kept.content)

  const broken = normalizeAiSummary('只有一段闲聊，没有固定结构。', '2026-11-11', data)
  assert.equal(broken.fallback, true)
  assert.ok(broken.content.startsWith('# 2026-11-11 工作日志'))
  for (const heading of NEW_HEADINGS) assert.ok(broken.content.includes(heading), heading)

  // A missing title is repaired while the structure is preserved.
  const untitled = compliant.split('\n').slice(2).join('\n')
  const repaired = normalizeAiSummary(untitled, '2026-11-11', data)
  assert.ok(repaired.content.startsWith('# 2026-11-11 工作日志'))
})

test('normalizeAiSummary: caps each section (6/12/8/4) and every bullet (≤300)', () => {
  const section = (heading, bullets) => [heading, '', ...bullets.flatMap(text => [text, ''])].join('\n')
  // Short bullets keep the whole journal under the total cap so the section
  // caps can be asserted without truncation kicking in.
  const bullet = index => `- 条目 ${index}`
  const oversized = [
    '# 2026-11-11 工作日志',
    '',
    section('## 一、今日要点', Array.from({ length: 10 }, (_, index) => bullet(`a${index}`))),
    section('## 二、逐项记录', Array.from({ length: 16 }, (_, index) => bullet(`b${index}`))),
    section('## 三、待跟进', Array.from({ length: 12 }, (_, index) => bullet(`c${index}`))),
    section('## 四、明天建议', Array.from({ length: 8 }, (_, index) => bullet(`d${index}`))),
  ].join('\n')
  const result = normalizeAiSummary(oversized, '2026-11-11', journalData())
  assert.equal(result.fallback, false)
  const sections = result.content.split(/\n(?=## )/).slice(1)
  const bulletCounts = sections.map(part => part.split('\n').filter(line => line.startsWith('- ')).length)
  assert.deepEqual(bulletCounts, [6, 12, 8, 4])

  // One over-long bullet is shortened to the 300-char contract target.
  const longBullet = `- ${'很长的具体结论'.repeat(80)}`
  const shortened = normalizeAiSummary([
    '# 2026-11-11 工作日志', '',
    '## 一、今日要点', '', longBullet, '',
    '## 二、逐项记录', '', '- 无', '',
    '## 三、待跟进', '', '- 无', '',
    '## 四、明天建议', '', '- 无',
  ].join('\n'), '2026-11-11', journalData())
  assert.equal(shortened.fallback, false)
  const longLine = shortened.content.split('\n').find(line => line.startsWith('- 很长'))
  assert.ok(longLine, shortened.content.slice(0, 200))
  assert.ok(longLine.length <= 303, String(longLine.length))
  assert.ok(longLine.endsWith('…'), longLine.slice(-10))
})

test('normalizeAiSummary: total length stays under the 3000-char cap', () => {
  const bullet = index => `- ${`结论 ${index} `.padEnd(500, '果')}`
  const section = (heading, count, prefix) => [
    heading, '',
    ...Array.from({ length: count }, (_, index) => bullet(`${prefix}${index}`)).flatMap(line => [line, '']),
  ].join('\n')
  const text = [
    '# 2026-11-11 工作日志', '',
    section('## 一、今日要点', 8, 'a'),
    section('## 二、逐项记录', 14, 'b'),
    section('## 三、待跟进', 10, 'c'),
    section('## 四、明天建议', 6, 'd'),
  ].join('\n')
  const result = normalizeAiSummary(text, '2026-11-11', journalData())
  assert.equal(result.fallback, false)
  assert.ok(result.content.length <= 3002, String(result.content.length))
  assert.ok(result.content.endsWith('\n'))
})

test('createReports: a no-activity day writes a short local journal without a model session', async () => {
  const { store, cleanup } = tempStore()
  let bridged = 0
  const bridge = {
    createSession: async () => { bridged += 1; return 'should-not-happen' },
    selectModel: async () => { bridged += 1 },
    prompt: async () => { bridged += 1 },
    lastTurnEnd: async () => undefined,
    summarize: async () => ({ finalAnswer: '' }),
    transcript: async () => { bridged += 1; return { messages: [] } },
  }
  const engine = createReports({ ctx: FAKE_CTX, store, bridge, notify: () => {} })
  try {
    engine.generate('2026-11-11')
    const status = await settleReport(store)
    assert.equal(status.lastStatus, 'ok')
    assert.equal(bridged, 0, 'an empty day must not create a model session')
    const content = engine.read('2026-11-11')
    assert.ok(content.startsWith('# 2026-11-11 工作日志'))
    assert.ok(content.includes('没有记录到工作活动'))
    assert.deepEqual(engine.list().map(file => file.date), ['2026-11-11'])
  } finally {
    engine.stop()
    cleanup()
  }
})

test('createReports: journal generation feeds real session content into the prompt', async () => {
  const { dir, store, cleanup } = tempStore()
  assert.ok(dir)
  const now = Date.now()
  const queueTask = store.add({ title: '修复登录页', prompt: '排查登录失败', cwd: ROOT, status: 'pending' })
  store.update(queueTask.id, task => {
    task.status = 'done'
    task.result = { finalAnswer: '清理缓存后恢复，补 3 个回归测试。' }
    task.endedAt = now
    task.updatedAt = now
  })
  store.importSessionTask({
    sessionId: 'sess-journal',
    title: '调试构建缓存',
    cwd: ROOT,
    status: 'done',
    createdAt: now - 3_600_000,
    updatedAt: now - 1_800_000,
  })

  const prompts = []
  const bridge = {
    createSession: async () => 'journal-session',
    selectModel: async () => {},
    prompt: async (_sessionId, text) => { prompts.push(text) },
    lastTurnEnd: async () => ({ time: Date.now() + 10, reason: { kind: 'completed' } }),
    summarize: async () => ({
      finalAnswer: [
        '# 2026-11-11 工作日志',
        '',
        '## 一、今日要点',
        '',
        '- 修复登录页：清理缓存后恢复，补 3 个回归测试。',
        '',
        '## 二、逐项记录',
        '',
        '- **修复登录页**：你交代排查登录失败；我定位到缓存过期；结论是已恢复并补测试。',
        '',
        '## 三、待跟进',
        '',
        '- 构建缓存问题仍需继续排查。',
        '',
        '## 四、明天建议',
        '',
        '- 跑全量回归测试后再发布。',
      ].join('\n'),
    }),
    transcript: async () => ({
      messages: [
        { role: 'user', text: 'CI 的缓存为什么一直失效？' },
        { role: 'assistant', text: '发现 lockfile 变更没有提交，补上后缓存命中正常。' },
      ],
    }),
  }
  const engine = createReports({ ctx: FAKE_CTX, store, bridge, notify: () => {} })
  try {
    engine.generate('2026-11-11')
    const status = await settleReport(store)
    assert.equal(status.lastStatus, 'ok')
    assert.equal(prompts.length, 1)
    assert.ok(prompts[0].includes('CI 的缓存为什么一直失效？'), prompts[0].slice(0, 500))
    assert.ok(prompts[0].includes('lockfile 变更没有提交'))
    assert.ok(prompts[0].includes('清理缓存后恢复'))
    const content = engine.read('2026-11-11')
    assert.ok(content.startsWith('# 2026-11-11 工作日志'))
    for (const heading of NEW_HEADINGS) assert.ok(content.includes(heading), heading)
    assert.ok(content.includes('回归测试'))
  } finally {
    engine.stop()
    cleanup()
  }
})

test('extractReportBody: forces the 工作日志 title', () => {
  assert.equal(extractReportBody('just text', '2026-11-11'), '# 2026-11-11 工作日志\n\njust text\n')
  const titled = extractReportBody('# 2026-11-11 工作日志\n\n## 一、今日要点\n\n无', '2026-11-11')
  assert.ok(titled.startsWith('# 2026-11-11 工作日志'))
  assert.ok(titled.endsWith('\n'))
  assert.ok(!titled.endsWith('\n\n'))
})

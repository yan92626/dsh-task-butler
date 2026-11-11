#!/usr/bin/env node
/**
 * Host-half unit tests for v0.6: the morning-brief engine and the scheduled
 * priority order.
 *
 * These tests run without a live Harness: they import the Host modules, drive
 * the pure helpers, and exercise TaskStore against a temporary state directory
 * (same pattern as tests/evolution-unit.mjs). The contract is
 * docs/v0.6-contract.md §2.1, §2.2, §3.1, §3.3 and §5.1.
 *
 * Run: node --test tests/briefs-unit.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as briefs from '../host/briefs.js'
import { localDateString } from '../host/reports.js'
import {
  HttpError,
  STATE_VERSION,
  TaskStore,
  WEBHOOK_EVENTS,
  defaultMorningBrief,
  normalizeMorningBrief,
  pendingInsertIndex,
} from '../host/store.js'
import { pendingInClaimOrder, selectSessionResultBackfill } from '../host/scheduler.js'
import { morningBriefMarkdown, renderMarkdown } from '../host/webhook.js'

const ROOT = '/repo'
const BRIEF_HEADINGS = ['## 一、昨日回顾', '## 二、今日焦点', '## 三、等你处理', '## 四、风险与提醒']

function at(dateText, hours, minutes) {
  const [year, month, day] = dateText.split('-').map(Number)
  return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime()
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ps-brief-store-'))
  const store = new TaskStore({ dir })
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function baseSettings(overrides = {}) {
  return { ...defaultMorningBrief(join(ROOT, 'state')), ...overrides }
}

function assertHeadings(content) {
  let cursor = -1
  for (const heading of BRIEF_HEADINGS) {
    const index = content.indexOf(heading)
    assert.ok(index > cursor, `missing or out-of-order heading ${heading}: ${String(content).slice(0, 240)}`)
    cursor = index
  }
}

function addPending(store, title, priority = 'normal') {
  return store.add({ title, prompt: 'p', cwd: ROOT, status: 'pending', priority })
}

// ---------------------------------------------------------------- due rules

test('isBriefDue: disabled, too early, already generated, generating, due', () => {
  const settings = baseSettings({ enabled: true, time: '08:30' })
  assert.equal(briefs.isBriefDue(settings, at('2026-11-11', 8, 29)), false)
  assert.equal(briefs.isBriefDue(settings, at('2026-11-11', 8, 30)), true)
  assert.equal(briefs.isBriefDue(settings, at('2026-11-11', 23, 0)), true)
  assert.equal(briefs.isBriefDue({ ...settings, enabled: false }, at('2026-11-11', 9, 0)), false)
  assert.equal(briefs.isBriefDue({ ...settings, lastDate: '2026-11-11' }, at('2026-11-11', 9, 0)), false)
  // Yesterday's brief does not block today's.
  assert.equal(briefs.isBriefDue({ ...settings, lastDate: '2026-11-10' }, at('2026-11-11', 9, 0)), true)
  assert.equal(briefs.isBriefDue({ ...settings, generatingDate: '2026-11-11' }, at('2026-11-11', 9, 0)), false)
  assert.equal(briefs.isBriefDue(baseSettings({ enabled: true }), at('2026-11-11', 8, 29)), false)
})

test('brief engine constants and date pattern are stable', () => {
  assert.equal(briefs.BRIEF_TICK_MS, 30_000)
  assert.equal(briefs.BRIEF_POLL_MS, 1_000)
  assert.equal(briefs.BRIEF_MAX_WAIT_MS, 10 * 60 * 1000)
  assert.ok(briefs.BRIEF_DATE_PATTERN instanceof RegExp)
  assert.ok(briefs.BRIEF_DATE_PATTERN.test('2026-11-11'))
  assert.ok(!briefs.BRIEF_DATE_PATTERN.test('2026-1-1'))
  assert.ok(!briefs.BRIEF_DATE_PATTERN.test('not-a-date'))
})

// ---------------------------------------------------------------- fallback / prompt

function sampleData(overrides = {}) {
  const now = Date.now()
  return {
    date: '2026-11-11',
    yesterday: [
      {
        id: 'y1',
        title: '修复登录流程',
        status: 'done',
        endedAt: at('2026-11-10', 15, 0),
        result: { finalAnswer: '已清理缓存并补充回归测试。' },
      },
      {
        id: 'y2',
        title: '部署预发环境',
        status: 'failed',
        endedAt: at('2026-11-10', 16, 0),
        error: '端口被占用',
      },
    ],
    running: [{ id: 'r1', title: '迁移设置页', status: 'running', startedAt: now - 3 * 60 * 60 * 1000 }],
    waiting: [
      { id: 'w1', title: '等你确认发布方案', status: 'blocked', updatedAt: now - 3 * 60 * 60 * 1000 },
      { id: 'w2', title: '暂停的迁移', status: 'paused', updatedAt: now - 60 * 1000 },
    ],
    candidates: [
      { id: 'p1', title: '补测试', status: 'pending', priority: 'high' },
      { id: 'p2', title: '写周报', status: 'pending', priority: 'normal' },
    ],
    ideas: [{ id: 'i1', title: '研究通知中心', status: 'idea', priority: 'normal' }],
    skills: 2,
    ...overrides,
  }
}

test('buildMorningBriefFallback: fixed four sections, order stable, empty data readable', () => {
  const content = briefs.buildMorningBriefFallback(sampleData())
  assert.ok(content.startsWith('# 2026-11-11 晨间简报'), content.slice(0, 120))
  assertHeadings(content)
  assert.ok(content.includes('修复登录流程'))
  assert.ok(content.includes('补测试'))
  assert.ok(content.includes('等你确认发布方案'))
  // A running task past two hours is a risk item, not a focus item.
  assert.ok(content.includes('迁移设置页'))
  assert.ok(!/undefined|NaN|\[object Object\]/.test(content))
  assert.ok(!content.includes('```'))

  const empty = briefs.buildMorningBriefFallback({
    date: '2026-11-11',
    yesterday: [],
    running: [],
    waiting: [],
    candidates: [],
    ideas: [],
    skills: 0,
  })
  assert.ok(empty.startsWith('# 2026-11-11 晨间简报'))
  assertHeadings(empty)
  assert.ok(empty.trim().split('\n').length >= 8, empty)
  assert.ok(!/undefined|NaN|\[object Object\]/.test(empty))
})

test('buildMorningBriefPrompt: four sections, data references, no technical detail', () => {
  const prompt = briefs.buildMorningBriefPrompt(sampleData())
  assert.ok(prompt.includes('# 2026-11-11 晨间简报'))
  assertHeadings(prompt)
  for (const text of ['修复登录流程', '补测试', '等你确认发布方案', '研究通知中心']) {
    assert.ok(prompt.includes(text), `prompt misses ${text}`)
  }
  assert.ok(/40\s*字/.test(prompt), 'prompt must cap each item at 40 characters')
  assert.ok(/token/i.test(prompt), 'prompt must forbid token/technical detail')
  assert.ok(/代码块/.test(prompt), 'prompt must forbid code fences')
})

// ---------------------------------------------------------------- data collection

function briefStoreLike(tasks, proposedSkillCount) {
  const skills = Array.from({ length: proposedSkillCount }, (_, index) => ({
    name: `candidate-skill-${index + 1}`,
    status: 'proposed',
  }))
  return {
    tasks,
    evolution: { lessons: [], skills, lastRunAt: null },
    settings: { evolution: {} },
    getEvolutionMeta: () => ({ proposedSkillCount, activeSkillCount: 0, lessonCount: 0 }),
  }
}

test('collectMorningBriefData: yesterday, running, waiting, candidates, ideas, skill count', () => {
  const now = at('2026-11-11', 9, 0)
  const yesterdayStart = at('2026-11-10', 10, 0)
  const baseTask = { cwd: ROOT, priority: 'normal' }
  const tasks = [
    {
      ...baseTask,
      id: 'y_done',
      title: '昨天完成的任务',
      status: 'done',
      source: 'queue',
      createdAt: yesterdayStart,
      updatedAt: at('2026-11-10', 15, 0),
      endedAt: at('2026-11-10', 15, 0),
      result: { finalAnswer: '做好了' },
    },
    {
      ...baseTask,
      id: 'y_failed',
      title: '昨天失败的任务',
      status: 'failed',
      source: 'queue',
      createdAt: yesterdayStart,
      updatedAt: at('2026-11-10', 16, 0),
      endedAt: at('2026-11-10', 16, 0),
      error: '失败了',
    },
    {
      ...baseTask,
      id: 'y_session',
      title: '昨天会话任务',
      status: 'done',
      source: 'session',
      sessionId: 'sess-1',
      createdAt: yesterdayStart,
      updatedAt: at('2026-11-10', 18, 0),
      endedAt: at('2026-11-10', 18, 0),
    },
    {
      ...baseTask,
      id: 'today_done',
      title: '今天完成的任务',
      status: 'done',
      source: 'queue',
      createdAt: now - 3_600_000,
      updatedAt: now - 3_600_000,
      endedAt: now - 3_600_000,
    },
    {
      ...baseTask,
      id: 'run',
      title: '正在运行的任务',
      status: 'running',
      source: 'queue',
      createdAt: now - 4_000_000,
      updatedAt: now - 3_600_000,
      startedAt: now - 3 * 60 * 60 * 1000,
    },
    {
      ...baseTask,
      id: 'p1',
      title: '排队甲',
      status: 'pending',
      source: 'queue',
      createdAt: now - 5_000,
      updatedAt: now - 5_000,
      priority: 'normal',
    },
    {
      ...baseTask,
      id: 'p2',
      title: '排队乙',
      status: 'pending',
      source: 'queue',
      createdAt: now - 4_000,
      updatedAt: now - 4_000,
      priority: 'urgent',
    },
    {
      ...baseTask,
      id: 'i1',
      title: '想法一',
      status: 'idea',
      source: 'queue',
      createdAt: now - 3_000,
      updatedAt: now - 3_000,
    },
    {
      ...baseTask,
      id: 'i2',
      title: '想法二',
      status: 'idea',
      source: 'queue',
      createdAt: now - 2_000,
      updatedAt: now - 2_000,
    },
    {
      ...baseTask,
      id: 'b1',
      title: '等你回复的任务',
      status: 'blocked',
      source: 'queue',
      createdAt: now - 4 * 60 * 60 * 1000,
      updatedAt: now - 3 * 60 * 60 * 1000,
    },
    {
      ...baseTask,
      id: 'pa1',
      title: '暂停的任务',
      status: 'paused',
      source: 'queue',
      createdAt: now - 2 * 60 * 60 * 1000,
      updatedAt: now - 60_000,
    },
    {
      ...baseTask,
      id: 'f1',
      title: '今天失败的任务',
      status: 'failed',
      source: 'queue',
      createdAt: now - 30 * 60 * 1000,
      updatedAt: now - 10 * 60 * 1000,
      endedAt: now - 10 * 60 * 1000,
    },
  ]

  const data = briefs.collectMorningBriefData(briefStoreLike(tasks, 2), now, '2026-11-11')
  assert.ok(data && typeof data === 'object')

  const yesterday = JSON.stringify(data.yesterday)
  assert.ok(yesterday.includes('昨天完成的任务'), yesterday)
  assert.ok(yesterday.includes('昨天失败的任务'), yesterday)
  assert.ok(!yesterday.includes('今天完成的任务'), 'today-ended task leaked into yesterday')
  // DSH session tasks only contribute to the session count.
  assert.ok(!yesterday.includes('昨天会话任务'), 'session task must not be listed as queue work')

  assert.ok(JSON.stringify(data.running).includes('正在运行的任务'))

  const waiting = JSON.stringify(data.waiting)
  for (const title of ['等你回复的任务', '暂停的任务', '今天失败的任务']) {
    assert.ok(waiting.includes(title), `waiting misses ${title}: ${waiting}`)
  }
  assert.ok(!waiting.includes('正在运行的任务'), 'running tasks must not appear under why-you-wait')

  const candidateIds = (data.candidates || []).map(task => task.id)
  assert.ok(candidateIds.includes('p1') && candidateIds.includes('p2'), candidateIds)
  assert.ok(candidateIds.indexOf('p1') < candidateIds.indexOf('p2'), 'pending queue order must survive')
  assert.ok(!candidateIds.includes('i1'), 'ideas are offered separately, not as queue candidates')

  const ideaIds = (data.ideas || []).map(task => task.id)
  assert.ok(ideaIds.includes('i1') && ideaIds.includes('i2'), ideaIds)

  const skills = data.skills
  let skillCount = null
  if (typeof skills === 'number') skillCount = skills
  else if (Array.isArray(skills)) skillCount = skills.length
  else if (skills && typeof skills === 'object') skillCount = skills.proposedSkillCount ?? skills.count ?? null
  assert.equal(skillCount, 2, `skill candidates must be counted: ${JSON.stringify(skills)}`)
})

// ---------------------------------------------------------------- normalisation

test('extractBriefBody: forces the title and exactly one trailing newline', () => {
  assert.equal(briefs.extractBriefBody('just text', '2026-11-11'), '# 2026-11-11 晨间简报\n\njust text\n')
  const titled = briefs.extractBriefBody('# 2026-11-11 晨间简报\n\n## 一、昨日回顾\n\n无', '2026-11-11')
  assert.ok(titled.startsWith('# 2026-11-11 晨间简报'))
  assert.ok(titled.endsWith('\n'))
  assert.ok(!titled.endsWith('\n\n'))
})

test('normalizeMorningBriefText: compliant output kept, narration stripped, broken structure falls back', () => {
  const data = {
    date: '2026-11-11',
    yesterday: [],
    running: [],
    waiting: [],
    candidates: [],
    ideas: [],
    skills: 0,
  }
  const compliant = [
    '# 2026-11-11 晨间简报',
    '',
    '## 一、昨日回顾',
    '',
    '- 昨天完成 1 项。',
    '',
    '## 二、今日焦点',
    '',
    '- 补测试。',
    '',
    '## 三、等你处理',
    '',
    '无',
    '',
    '## 四、风险与提醒',
    '',
    '无',
  ].join('\n')

  const kept = briefs.normalizeMorningBriefText(compliant, '2026-11-11', data)
  assert.equal(kept.fallback, false)
  assert.ok(kept.content.startsWith('# 2026-11-11 晨间简报'))
  assertHeadings(kept.content)

  const narrated = briefs.normalizeMorningBriefText(`好了，已生成如下：\n\n${compliant}`, '2026-11-11', data)
  assert.equal(narrated.fallback, false)
  assert.ok(narrated.content.startsWith('# 2026-11-11 晨间简报'))
  assert.ok(!narrated.content.includes('已生成如下'))

  const broken = briefs.normalizeMorningBriefText('没有结构的闲聊。', '2026-11-11', data)
  assert.equal(broken.fallback, true)
  assert.ok(broken.content.startsWith('# 2026-11-11 晨间简报'))
  assertHeadings(broken.content)
})

// ---------------------------------------------------------------- files

test('listBriefFiles/readBriefFile: YYYY-MM-DD.md only, newest first, limit honoured', () => {
  const dir = tempDir('dsh-ps-brief-files-')
  try {
    writeFileSync(join(dir, '2026-11-09.md'), '# 2026-11-09 晨间简报\n')
    writeFileSync(join(dir, '2026-11-11.md'), '# 2026-11-11 晨间简报\n')
    writeFileSync(join(dir, '2026-11-10.md'), '# 2026-11-10 晨间简报\n')
    writeFileSync(join(dir, 'notes.txt'), 'ignore me')
    writeFileSync(join(dir, '2026-1-1.md'), 'bad name')

    const files = briefs.listBriefFiles(dir)
    assert.deepEqual(files.map(file => file.date), ['2026-11-11', '2026-11-10', '2026-11-09'])
    for (const file of files) {
      assert.equal(typeof file.path, 'string')
      assert.ok(Number.isFinite(file.bytes))
      assert.ok(Number.isFinite(file.updatedAt))
    }
    assert.equal(briefs.listBriefFiles(dir, 2).length, 2)
    assert.equal(briefs.readBriefFile(dir, '2026-11-10'), '# 2026-11-10 晨间简报\n')
    assert.equal(briefs.readBriefFile(dir, '1999-01-01'), undefined)
    assert.throws(() => briefs.readBriefFile(dir, 'not-a-date'), error => error instanceof HttpError && error.status === 400)
    assert.deepEqual(briefs.listBriefFiles(join(dir, 'missing')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- priority scheduling

test('pendingInsertIndex: rank order inside the pending segment only', () => {
  const tasks = [
    { id: 'i1', status: 'idea', priority: 'normal' },
    { id: 'pn', status: 'pending', priority: 'normal' },
    { id: 'r1', status: 'running', priority: 'urgent' },
    { id: 'pl', status: 'pending', priority: 'low' },
  ]
  assert.equal(pendingInsertIndex(tasks, { id: 'new', status: 'pending', priority: 'urgent' }), 1)
  assert.equal(pendingInsertIndex(tasks, { id: 'new', status: 'pending', priority: 'high' }), 1)
  assert.equal(pendingInsertIndex(tasks, { id: 'new', status: 'pending', priority: 'normal' }), 3)
  assert.equal(pendingInsertIndex(tasks, { id: 'new', status: 'pending', priority: 'low' }), 4)
  // No pending rows at all: append to the array.
  assert.equal(pendingInsertIndex([{ id: 'i1', status: 'idea' }], { id: 'new', status: 'pending', priority: 'normal' }), 1)
  assert.equal(pendingInsertIndex([], { id: 'new', status: 'pending', priority: 'normal' }), 0)
  // Equal rank keeps FIFO relative order.
  const same = [
    { id: 'n1', status: 'pending', priority: 'normal' },
    { id: 'pl', status: 'pending', priority: 'low' },
  ]
  assert.equal(pendingInsertIndex(same, { id: 'new', status: 'pending', priority: 'normal' }), 1)
})

test('TaskStore: priority participates in queue insertion (add/addBatch/promote/reposition)', () => {
  const { store, cleanup } = tempStore()
  try {
    const low = addPending(store, 'low', 'low')
    addPending(store, 'high', 'high')
    assert.deepEqual(store.tasks.map(task => task.title), ['high', 'low'])
    addPending(store, 'normal', 'normal')
    assert.deepEqual(store.tasks.map(task => task.title), ['high', 'normal', 'low'])
    addPending(store, 'urgent', 'urgent')
    assert.deepEqual(store.tasks.map(task => task.title), ['urgent', 'high', 'normal', 'low'])
    addPending(store, 'normal2', 'normal')
    assert.deepEqual(store.tasks.map(task => task.title), ['urgent', 'high', 'normal', 'normal2', 'low'])

    // An idea column entry keeps the board order until it is promoted.
    const idea = store.add({ title: 'idea-task', prompt: 'p', cwd: ROOT, status: 'idea', priority: 'normal' })
    assert.equal(store.tasks[store.tasks.length - 1].id, idea.id)
    store.promote(idea.id)
    const promoted = store.tasks.map(task => task.title)
    assert.ok(promoted.indexOf('idea-task') < promoted.indexOf('low'), promoted.join(','))
    assert.ok(promoted.indexOf('normal2') < promoted.indexOf('idea-task'), promoted.join(','))

    // addBatch inserts each pending item by the same rule.
    store.addBatch({
      cwd: ROOT,
      status: 'pending',
      priority: 'high',
      items: [{ title: 'batch1', prompt: 'p' }, { title: 'batch2', prompt: 'p' }],
    })
    assert.deepEqual(store.tasks.slice(0, 4).map(task => task.title), ['urgent', 'high', 'batch1', 'batch2'])

    // Editing a pending task's priority then repositioning moves it. Equal
    // ranks keep FIFO order, so the new urgent lands after the existing urgent.
    store.update(low.id, task => { task.priority = 'urgent' })
    store.repositionPending(low.id)
    const rankOf = { urgent: 0, high: 1, normal: 2, low: 3 }
    const pendingRanks = store.tasks
      .filter(task => task.status === 'pending')
      .map(task => rankOf[task.priority])
    assert.deepEqual(pendingRanks, [...pendingRanks].sort((left, right) => left - right),
      store.tasks.map(task => task.title).join(','))
    assert.equal(store.tasks.findIndex(task => task.id === low.id), 1,
      store.tasks.map(task => task.title).join(','))
  } finally {
    cleanup()
  }
})

test('selectSessionResultBackfill: done session rows without a result, bounded and de-duplicated', () => {
  const now = Date.now()
  const tasks = [
    { id: 'queue-done', title: '队列任务', status: 'done', source: 'queue', endedAt: now },
    { id: 'running', title: '运行中会话', status: 'running', source: 'session', sessionId: 's0' },
    { id: 'has-result', title: '已有结果', status: 'done', source: 'session', sessionId: 's1', result: { finalAnswer: 'x' } },
    { id: 'retried', title: '已尝试回填', status: 'done', source: 'session', sessionId: 's2', resultBackfillAt: 1 },
    { id: 'missing-session', title: '没有会话', status: 'done', source: 'session' },
    { id: 'a', title: '待回填甲', status: 'done', source: 'session', sessionId: 's3', endedAt: now - 1000 },
    { id: 'b', title: '待回填乙', status: 'done', source: 'session', sessionId: 's4', endedAt: now - 5000 },
  ]
  assert.deepEqual(selectSessionResultBackfill(tasks).map(task => task.id), ['a', 'b'])
  assert.equal(selectSessionResultBackfill(tasks, 1).length, 1)
  assert.deepEqual(selectSessionResultBackfill(tasks, 0), [])
  assert.deepEqual(selectSessionResultBackfill([]), [])
})

test('pendingInClaimOrder: pending rows keep the board order the claimer walks', () => {
  const tasks = [
    { id: 'i', status: 'idea' },
    { id: 'b', status: 'pending' },
    { id: 'r', status: 'running' },
    { id: 'a', status: 'pending' },
  ]
  assert.deepEqual(pendingInClaimOrder(tasks).map(task => task.id), ['b', 'a'])
  assert.deepEqual(pendingInClaimOrder([]), [])
})

// ---------------------------------------------------------------- settings.morningBrief

test('TaskStore: morningBrief defaults, strict user patch, engine-owned run state', () => {
  const { dir, store, cleanup } = tempStore()
  try {
    assert.equal(store.state.version, STATE_VERSION)
    assert.equal(STATE_VERSION, 4)
    assert.deepEqual(WEBHOOK_EVENTS, ['claimed', 'succeeded', 'blocked', 'failed', 'dailyReport', 'morningBrief', 'retrospective'])

    const settings = store.settings.morningBrief
    assert.deepEqual(settings, defaultMorningBrief(dir))
    assert.equal(settings.enabled, true)
    assert.equal(settings.time, '08:30')
    assert.equal(settings.dir, join(dir, 'briefs'))
    assert.equal(settings.lastStatus, 'idle')
    assert.equal(settings.lastDate, null)
    assert.equal(settings.generatingDate, null)

    // User patch: enabled/time/dir are the only writable fields.
    const outDir = join(dir, 'custom-briefs')
    store.updateSettings({ morningBrief: { enabled: false, time: '09:15', dir: outDir } })
    assert.equal(store.settings.morningBrief.enabled, false)
    assert.equal(store.settings.morningBrief.time, '09:15')
    assert.equal(store.settings.morningBrief.dir, outDir)

    // Strict validation.
    assert.throws(() => store.updateSettings({ morningBrief: { time: '9:00' } }),
      error => error instanceof HttpError && error.status === 400)
    assert.throws(() => store.updateSettings({ morningBrief: { dir: 123 } }),
      error => error instanceof HttpError && error.status === 400)
    assert.throws(() => store.updateSettings({ morningBrief: 'bad' }),
      error => error instanceof HttpError && error.status === 400)

    // Run state only changes through updateMorningBrief.
    store.updateMorningBrief({
      lastDate: '2026-11-11',
      lastStatus: 'ok',
      lastError: null,
      lastGeneratedAt: 1234,
      generatingDate: null,
    })
    store.updateSettings({ morningBrief: { lastStatus: 'failed', lastDate: '1999-01-01', generatingDate: '1999-01-01' } })
    assert.equal(store.settings.morningBrief.lastStatus, 'ok')
    assert.equal(store.settings.morningBrief.lastDate, '2026-11-11')
    assert.equal(store.settings.morningBrief.generatingDate, null)
    assert.equal(store.settings.morningBrief.lastGeneratedAt, 1234)
    // updateMorningBrief must not rewrite user preferences.
    store.updateMorningBrief({ enabled: true, time: '23:59' })
    assert.equal(store.settings.morningBrief.enabled, false)
    assert.equal(store.settings.morningBrief.time, '09:15')

    // Persistence round-trip (a loaded document also carries the webhook events,
    // which a brand-new in-memory default intentionally leaves to normalizeSettings).
    const reloaded = new TaskStore({ dir })
    assert.equal(reloaded.settings.webhook.events.morningBrief, true)
    assert.equal(reloaded.settings.morningBrief.time, '09:15')
    assert.equal(reloaded.settings.morningBrief.dir, outDir)
    assert.equal(reloaded.settings.morningBrief.lastStatus, 'ok')
    assert.equal(reloaded.settings.morningBrief.lastDate, '2026-11-11')

    // Lenient normalisation for a corrupt / partial document.
    const normalized = normalizeMorningBrief(
      { enabled: true, time: '99:99', dir: '', lastStatus: 'bogus', lastGeneratedAt: 'nope' },
      dir,
    )
    assert.equal(normalized.time, '08:30')
    assert.equal(normalized.dir, join(dir, 'briefs'))
    assert.equal(normalized.lastStatus, 'idle')
    assert.equal(normalized.lastGeneratedAt, null)
    assert.equal(normalized.enabled, true)
    assert.equal(normalizeMorningBrief(null, dir).enabled, true)
  } finally {
    cleanup()
  }
})

test('TaskStore: a legacy document gains morningBrief defaults, version stays 4', () => {
  const dir = tempDir('dsh-ps-brief-legacy-')
  try {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      version: 4,
      rev: 9,
      settings: {
        concurrency: 2,
        autoStart: false,
        group: '秘书台',
        dailyReport: { enabled: false, time: '08:15' },
        webhook: { enabled: false },
      },
      tasks: [],
      syncSince: 1,
      ownedSessions: [],
      removedSessions: [],
    }))
    const store = new TaskStore({ dir })
    assert.equal(store.state.version, 4)
    assert.equal(store.rev, 9)
    assert.equal(store.settings.morningBrief.enabled, true)
    assert.equal(store.settings.morningBrief.time, '08:30')
    assert.equal(store.settings.morningBrief.dir, join(dir, 'briefs'))
    assert.equal(store.settings.webhook.events.morningBrief, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- session result backfill

test('normalizeTask: numeric resultBackfillAt survives a reload, junk is dropped', () => {
  const dir = tempDir('dsh-ps-brief-backfill-')
  try {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      version: 4,
      rev: 2,
      settings: {},
      tasks: [
        {
          id: 's1', title: '回填过的会话任务', status: 'done', source: 'session',
          sessionId: 'sess-1', resultBackfillAt: 1234567, createdAt: 1, updatedAt: 2,
        },
        {
          id: 's2', title: '待回填的会话任务', status: 'done', source: 'session',
          sessionId: 'sess-2', createdAt: 1, updatedAt: 2,
        },
        {
          id: 's3', title: '坏标记的会话任务', status: 'done', source: 'session',
          sessionId: 'sess-3', resultBackfillAt: 'oops', createdAt: 1, updatedAt: 2,
        },
      ],
      syncSince: null,
      ownedSessions: [],
      removedSessions: [],
    }))
    const store = new TaskStore({ dir })
    assert.equal(store.find('s1').resultBackfillAt, 1234567)
    assert.equal(store.find('s2').resultBackfillAt, undefined)
    assert.equal(store.find('s3').resultBackfillAt, undefined)
    const fresh = store.add({ title: '新队列任务', prompt: 'p', cwd: ROOT, status: 'pending' })
    assert.equal(fresh.resultBackfillAt, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- webhook template

test('morningBriefMarkdown: date, excerpt, file path and the renderMarkdown branch', () => {
  const payload = {
    date: '2026-11-11',
    content: '# 2026-11-11 晨间简报\n\n## 一、昨日回顾\n\n昨天完成 2 项。',
    path: '/tmp/briefs/2026-11-11.md',
  }
  const markdown = morningBriefMarkdown(payload)
  assert.ok(markdown.includes('晨间简报'))
  assert.ok(markdown.includes('2026-11-11'))
  assert.ok(markdown.includes('昨天完成 2 项'))
  assert.ok(markdown.includes('/tmp/briefs/2026-11-11.md'))
  assert.ok(renderMarkdown('morningBrief', payload).includes('晨间简报'))
})

// ---------------------------------------------------------------- engine surface

test('createBriefs: documented surface, meta, read validation and the 409 guard', async () => {
  const { dir, store, cleanup } = tempStore()
  try {
    const briefDir = join(dir, 'briefs')
    store.updateSettings({ morningBrief: { dir: briefDir } })
    mkdirSync(briefDir, { recursive: true })
    writeFileSync(join(briefDir, '2026-11-10.md'), '# 2026-11-10 晨间简报\n')

    const engine = briefs.createBriefs({
      ctx: { get: () => undefined, effect: () => () => {}, logger: { warn() {} }, on: () => () => {} },
      store,
      bridge: {},
      notify: () => {},
    })
    try {
      for (const name of ['start', 'stop', 'kick', 'list', 'read', 'meta', 'today', 'generate', 'checkDue', 'recoverStale', 'isGenerating']) {
        assert.equal(typeof engine[name], 'function', `createBriefs must expose ${name}`)
      }
      assert.equal(engine.isGenerating(), false)
      assert.deepEqual(engine.list().map(file => file.date), ['2026-11-10'])
      assert.ok(engine.read('2026-11-10').startsWith('# 2026-11-10 晨间简报'))
      assert.throws(() => engine.read('bad-date'), error => error instanceof HttpError && error.status === 400)
      assert.equal(engine.today(), localDateString())
      const meta = engine.meta()
      assert.ok(Array.isArray(meta.briefs))
      assert.equal(meta.settings.time, '08:30')
      assert.equal(meta.settings.dir, briefDir)

      // The settings kick and the 30s tick both end up in checkDue.
      await engine.checkDue(at('2026-11-11', 7, 0))
      assert.equal(engine.isGenerating(), false)

      // A generation already in flight must conflict, not start a second run.
      store.updateMorningBrief({ generatingDate: '2026-11-11' })
      assert.throws(() => engine.generate('2026-11-11'), error => error instanceof HttpError && error.status === 409)
      store.updateMorningBrief({ generatingDate: null })

      // A stale 'running' state left by a restart is repaired.
      store.updateMorningBrief({ lastStatus: 'running', generatingDate: '2026-11-11' })
      engine.recoverStale()
      assert.equal(store.settings.morningBrief.lastStatus, 'failed')
      assert.equal(store.settings.morningBrief.generatingDate, null)
    } finally {
      engine.stop()
    }
  } finally {
    cleanup()
  }
})

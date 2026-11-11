#!/usr/bin/env node
/**
 * Host-half unit tests for the v9 self-evolution feature.
 *
 * These tests run without a live Harness: they import the Host modules, drive
 * the pure helpers, and exercise TaskStore against a temporary state directory.
 * The contract is evolution-contract.md (§1–§4).
 *
 * Run: node --test tests/evolution-unit.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as evo from '../host/evolution.js'
import { HttpError, TaskStore, WEBHOOK_EVENTS, defaultEvolution } from '../host/store.js'
import { retrospectiveMarkdown } from '../host/webhook.js'

const ROOT = '/repo'
const PROJECT = '/repo/proj'

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ps-evo-'))
  const store = new TaskStore({ dir })
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function at(dateText, hours, minutes) {
  const [year, month, day] = dateText.split('-').map(Number)
  return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime()
}

function baseSettings(overrides = {}) {
  return { ...defaultEvolution(ROOT + '/state'), ...overrides }
}

// ---------------------------------------------------------------- due rules

test('isRetrospectiveDue: daily window, lastDate and running guards', () => {
  const settings = baseSettings({ enabled: true, interval: 'daily', time: '22:00' })
  assert.equal(evo.isRetrospectiveDue(settings, at('2026-11-06', 21, 59)), false)
  assert.equal(evo.isRetrospectiveDue(settings, at('2026-11-06', 22, 0)), true)
  assert.equal(evo.isRetrospectiveDue({ ...settings, lastDate: '2026-11-06' }, at('2026-11-06', 22, 30)), false)
  assert.equal(evo.isRetrospectiveDue({ ...settings, generatingDate: '2026-11-06' }, at('2026-11-06', 22, 30)), false)
  assert.equal(evo.isRetrospectiveDue({ ...settings, enabled: false }, at('2026-11-06', 23, 0)), false)
})

test('isRetrospectiveDue: weekly only fires on the configured weekday', () => {
  const now = at('2026-11-06', 23, 0)
  const weekday = new Date(now).getDay()
  const weekly = baseSettings({ enabled: true, interval: 'weekly', time: '22:00', weekday })
  assert.equal(evo.isRetrospectiveDue(weekly, now), true)
  const otherDay = (weekday + 1) % 7
  assert.equal(evo.isRetrospectiveDue({ ...weekly, weekday: otherDay }, now), false)
})

test('periodWindow: falls back to one day / one week', () => {
  const now = at('2026-11-06', 23, 0)
  const daily = evo.periodWindow(baseSettings({ interval: 'daily' }), null, now)
  assert.equal(daily.since, now - 24 * 60 * 60 * 1000)
  assert.equal(daily.until, now)
  const weekly = evo.periodWindow(baseSettings({ interval: 'weekly' }), null, now)
  assert.equal(weekly.since, now - 7 * 24 * 60 * 60 * 1000)
  const pinned = evo.periodWindow(baseSettings(), 12345, now)
  assert.equal(pinned.since, 12345)
})

// ---------------------------------------------------------------- lessons

function lesson(overrides = {}) {
  return {
    id: 'l_000000000001',
    text: 'Always run node tests/static-check.mjs before claiming done',
    category: 'process',
    scope: 'global',
    project: null,
    evidence: 'previous tasks',
    source: 'retrospective',
    active: true,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

test('selectLessonsForTask: project lessons first, matching scope only, capped', () => {
  const lessons = [
    lesson({ id: 'l_1', text: 'global rule', scope: 'global' }),
    lesson({ id: 'l_2', text: 'project rule', scope: 'project', project: PROJECT }),
    lesson({ id: 'l_3', text: 'other project', scope: 'project', project: '/repo/other' }),
    lesson({ id: 'l_4', text: 'inactive rule', scope: 'global', active: false }),
  ]
  const task = { cwd: PROJECT + '/src' }
  const picked = evo.selectLessonsForTask(lessons, task)
  assert.deepEqual(picked.map(item => item.id), ['l_2', 'l_1'])
  assert.equal(evo.selectLessonsForTask(lessons, task, 1).length, 1)
  assert.deepEqual(evo.selectLessonsForTask(lessons, { cwd: '/elsewhere' }).map(item => item.id), ['l_1'])
  assert.deepEqual(evo.selectLessonsForTask(lessons, { cwd: PROJECT }).map(item => item.id), ['l_2', 'l_1'])
})

test('buildTaskPromptWithLessons: injects a rule block before the base prompt', () => {
  const base = '# 任务：demo\n\nDo the thing.'
  assert.equal(evo.buildTaskPromptWithLessons(base, []), base)
  assert.equal(evo.buildLessonsPromptBlock([]), '')
  const prompt = evo.buildTaskPromptWithLessons(base, [lesson({ text: 'Never use npm test' })])
  assert.ok(prompt.includes('Never use npm test'))
  assert.ok(prompt.includes(base))
  assert.ok(prompt.indexOf('Never use npm test') < prompt.indexOf(base))
  assert.ok(/复盘经验/.test(prompt))
})

test('mergeSuggestedLessons: adds new rules and updates existing by text', () => {
  const existing = [lesson({ id: 'l_keep', text: 'Keep the board small', evidence: 'old', updatedAt: 1 })]
  const now = 5000
  const suggested = [
    { text: '  keep the board SMALL ', category: 'process', scope: 'global', evidence: 'task A' },
    { text: 'Prefer pnpm over npm in this repo', category: 'process', scope: 'project', project: PROJECT, evidence: 'task B' },
    { text: '', category: 'process' },
    { text: 'bad scope', category: 'process', scope: 'project', project: '' },
  ]
  const merged = evo.mergeSuggestedLessons(existing, suggested, now)
  assert.equal(merged.lessons.length, 2)
  assert.equal(merged.lessons.find(item => item.id === 'l_keep').updatedAt, now)
  assert.equal(merged.lessons.find(item => item.id === 'l_keep').evidence, 'task A')
  const added = merged.lessons.find(item => item.text.includes('Prefer pnpm'))
  assert.ok(added)
  assert.equal(added.source, 'retrospective')
  assert.equal(added.scope, 'project')
})

test('mergeSuggestedLessons: caps at MAX_LESSONS by updatedAt', () => {
  const many = Array.from({ length: evo.MAX_LESSONS + 5 }, (_, index) => ({
    text: 'rule number ' + index,
    category: 'process',
    scope: 'global',
  }))
  const merged = evo.mergeSuggestedLessons([], many, 9000)
  assert.equal(merged.lessons.length, evo.MAX_LESSONS)
})

// ---------------------------------------------------------------- skills

function skill(overrides = {}) {
  return {
    name: 'run-project-tests',
    description: 'How to run this project test suite',
    whenToUse: 'Whenever a code change must be verified',
    content: '# Run project tests\n\nUse node tests/static-check.mjs.',
    scope: 'global',
    project: null,
    status: 'active',
    source: 'retrospective',
    evidence: 'tasks A, B',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

test('mergeSuggestedSkills: validates names, skips duplicates, applies status', () => {
  const existing = [skill({ name: 'existing-skill', status: 'active' })]
  const suggested = [
    { name: 'new-skill', description: 'new flow', whenToUse: 'when X', content: '# New skill\nRule.' },
    { name: 'existing-skill', description: 'dup', content: '# dup' },
    { name: 'Bad Name', description: 'bad', content: '# bad' },
    { name: 'missing-content', description: 'no body' },
    { name: 'new-skill', description: 'duplicate in batch', content: '# second' },
  ]
  const merged = evo.mergeSuggestedSkills(existing, suggested, 'proposed', 7000)
  assert.equal(merged.skills.length, 2)
  assert.equal(merged.added.length, 1)
  const created = merged.skills.find(item => item.name === 'new-skill')
  assert.equal(created.status, 'proposed')
  assert.equal(created.updatedAt, 7000)
})

test('mergeSuggestedSkills: caps at MAX_SKILLS', () => {
  const many = Array.from({ length: evo.MAX_SKILLS + 3 }, (_, index) => ({
    name: 'skill-' + index,
    description: 'skill ' + index,
    content: '# Skill ' + index,
  }))
  const merged = evo.mergeSuggestedSkills([], many, 'active', 9000)
  assert.equal(merged.skills.length, evo.MAX_SKILLS)
})

test('selectApplicableSkills + buildSkillDefinition: active and scope-matched only', () => {
  const skills = [
    skill({ name: 'global-active' }),
    skill({ name: 'project-active', scope: 'project', project: PROJECT }),
    skill({ name: 'project-other', scope: 'project', project: '/repo/other' }),
    skill({ name: 'proposed-skill', status: 'proposed' }),
    skill({ name: 'disabled-skill', status: 'disabled' }),
  ]
  assert.deepEqual(evo.selectApplicableSkills(skills, PROJECT).map(item => item.name), ['global-active', 'project-active'])
  assert.deepEqual(evo.selectApplicableSkills(skills, undefined).map(item => item.name), ['global-active'])
  const definition = evo.buildSkillDefinition(skill({ name: 'global-active' }))
  assert.equal(definition.name, 'global-active')
  assert.equal(definition.description, 'How to run this project test suite')
  assert.equal(definition.content, '# Run project tests\n\nUse node tests/static-check.mjs.')
  assert.equal(definition.provider, 'secretary-evolution')
  assert.equal(definition.source, 'personal-secretary')
  assert.equal(definition.invocation.modelInvocable, true)
})

// ---------------------------------------------------------------- retrospective prompt/parse

function retrospectiveInput(overrides = {}) {
  return {
    date: '2026-11-06',
    since: at('2026-11-05', 22, 0),
    until: at('2026-11-06', 22, 0),
    tasks: [
      { id: 't1', title: 'Vendor the chart library', status: 'failed', error: 'npm install blocked', cwd: PROJECT, priority: 'normal' },
      { id: 't2', title: 'Fix login flow', status: 'done', cwd: PROJECT, priority: 'high', result: { finalAnswer: 'Fixed by clearing token cache.' } },
    ],
    corrections: [{ taskTitle: 'Fix login flow', cwd: PROJECT, messages: [{ text: '别用 pnpm，仓库锁文件是 npm 的。', time: 1 }] }],
    errors: [{ title: 'Vendor the chart library', error: 'npm install blocked' }],
    activeTasks: [{ id: 't3', title: 'Migrate settings page', status: 'running', cwd: PROJECT }],
    lessons: [lesson({ text: 'Use npm lockfile, not pnpm' })],
    skills: [{ name: 'existing-skill', description: 'already covered' }],
    skillMode: 'ask',
    ...overrides,
  }
}

test('buildRetrospectivePrompt: carries data, existing state and the output markers', () => {
  const prompt = evo.buildRetrospectivePrompt(retrospectiveInput())
  assert.ok(prompt.includes('<<<RETROSPECTIVE>>>'))
  assert.ok(prompt.includes('<<<LESSONS_JSON>>>'))
  assert.ok(prompt.includes('<<<SKILLS_JSON>>>'))
  assert.ok(prompt.includes('<<<END>>>'))
  assert.ok(prompt.includes('Vendor the chart library'))
  assert.ok(prompt.includes('npm install blocked'))
  assert.ok(prompt.includes('别用 pnpm'))
  assert.ok(prompt.includes('existing-skill'))
  assert.ok(prompt.includes('Use npm lockfile, not pnpm'))
  const off = evo.buildRetrospectivePrompt(retrospectiveInput({ skillMode: 'off' }))
  assert.ok(!off.includes('<<<SKILLS_JSON>>>'))
})

test('extractEvolutionSections: markers, fenced JSON and missing markers', () => {
  const text = [
    'narration before',
    '<<<RETROSPECTIVE>>>',
    '# 2026-11-06 复盘',
    '',
    '## 一、本期概览',
    '- 完成 1 项',
    '<<<LESSONS_JSON>>>',
    '```json',
    '[{"text":"Use npm","category":"process","scope":"global","evidence":"task A"}]',
    '```',
    '<<<SKILLS_JSON>>>',
    '[{"name":"run-tests","description":"Run tests","content":"# Run tests"}]',
    '<<<END>>>',
  ].join('\n')
  const sections = evo.extractEvolutionSections(text)
  assert.ok(sections.report.includes('本期概览'))
  assert.ok(String(sections.lessonsRaw).includes('Use npm'))
  assert.ok(String(sections.skillsRaw).includes('run-tests'))
  const plain = evo.extractEvolutionSections('# 2026-11-06 复盘\n\nall free text')
  assert.ok(plain.report.includes('free text'))
  assert.equal(plain.lessonsRaw, null)
  assert.equal(plain.skillsRaw, null)
})

test('extractRetrospectiveBody: always yields the fixed title and one trailing newline', () => {
  assert.equal(evo.extractRetrospectiveBody('just text', '2026-11-06'), '# 2026-11-06 复盘\n\njust text\n')
  const withTitle = evo.extractRetrospectiveBody('# 2026-11-06 复盘\n\n## 一、本期概览\n\n无', '2026-11-06')
  assert.ok(withTitle.startsWith('# 2026-11-06 复盘'))
  assert.ok(withTitle.endsWith('\n'))
  assert.ok(!withTitle.endsWith('\n\n'))
})

test('buildRetrospectiveFallback: deterministic report with the standard sections', () => {
  const report = evo.buildRetrospectiveFallback(retrospectiveInput())
  assert.ok(report.startsWith('# 2026-11-06 复盘'))
  assert.ok(report.includes('本期概览'))
  assert.ok(report.includes('错误与用户纠正'))
})

test('retrospective file list/read round-trip and validation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ps-retro-'))
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-11-05.md'), '# 2026-11-05 复盘\n')
    writeFileSync(join(dir, '2026-11-06.md'), '# 2026-11-06 复盘\n')
    writeFileSync(join(dir, 'notes.txt'), 'ignore me')
    const files = evo.listRetrospectiveFiles(dir)
    assert.deepEqual(files.map(file => file.date), ['2026-11-06', '2026-11-05'])
    assert.equal(evo.readRetrospectiveFile(dir, '2026-11-06'), '# 2026-11-06 复盘\n')
    assert.equal(evo.readRetrospectiveFile(dir, '2026-11-07'), undefined)
    assert.throws(() => evo.readRetrospectiveFile(dir, 'nope'), error => error instanceof HttpError && error.status === 400)
    assert.deepEqual(evo.listRetrospectiveFiles(join(dir, 'missing')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- engine + provider

test('registerSkillProvider: publishes active skills through a DSH-valid provider', async () => {
  const { store, cleanup } = tempStore()
  try {
    store.replaceSkills([
      skill({ name: 'global-active' }),
      skill({ name: 'project-active', scope: 'project', project: PROJECT }),
      skill({ name: 'proposed-skill', status: 'proposed' }),
    ])
    let captured
    let invalidated = 0
    const skillsService = {
      registerProvider(create) {
        const control = { signal: new AbortController().signal, invalidate: () => { invalidated += 1 } }
        captured = create(control)
        return () => {}
      },
    }
    const ctx = {
      get: name => (name === 'skills' ? skillsService : undefined),
      effect: fn => {
        const dispose = fn()
        return () => { if (typeof dispose === 'function') dispose() }
      },
      logger: { warn() {} },
      on: () => () => {},
    }
    const evolution = evo.createEvolution({ ctx, store, bridge: {}, notify: () => {} })
    const dispose = evolution.registerSkillProvider()
    assert.equal(typeof dispose, 'function')
    assert.equal(captured.name, evo.EVOLUTION_PROVIDER_NAME)
    const candidates = await captured.list({ cwd: PROJECT })
    assert.deepEqual(candidates.map(item => item.name).sort(), ['global-active', 'project-active'])
    for (const candidate of candidates) {
      assert.equal(candidate.provider, evo.EVOLUTION_PROVIDER_NAME)
      assert.equal(candidate.rank, evo.EVOLUTION_SKILL_RANK)
      assert.ok(candidate.description.length > 0)
      assert.ok(candidate.source.length > 0)
    }
    const definition = await captured.get(candidates[0], { cwd: PROJECT })
    assert.ok(definition.content.includes('Run project tests'))
    assert.equal(definition.provider, evo.EVOLUTION_PROVIDER_NAME)
    // Adopting a proposal must invalidate the skill catalog.
    store.setSkillStatus('proposed-skill', 'active')
    evolution.refreshSkills()
    assert.ok(invalidated >= 1)
  } finally {
    cleanup()
  }
})

test('createEvolution: generate guard and state transitions without a live session', async () => {
  const { store, cleanup } = tempStore()
  try {
    let prompts = []
    const bridge = {
      createSession: async () => 'session-1',
      selectModel: async () => {},
      prompt: async (_sessionId, text) => { prompts.push(text) },
      lastTurnEnd: async () => ({ seq: 1, time: Date.now(), reason: { kind: 'completed' } }),
      summarize: async () => ({ finalAnswer: [
        '<<<RETROSPECTIVE>>>',
        '# 2026-11-06 复盘',
        '## 一、本期概览',
        '完成 1 项。',
        '<<<LESSONS_JSON>>>',
        '[]',
        '<<<SKILLS_JSON>>>',
        '[]',
        '<<<END>>>',
      ].join('\n') }),
    }
    const ctx = { get: () => undefined, effect: fn => { fn(); return () => {} }, logger: { warn() {} }, on: () => () => {} }
    const evolution = evo.createEvolution({ ctx, store, bridge, notify: () => {} })
    store.add({ title: 'done task', prompt: 'do it', cwd: PROJECT, status: 'pending' })
    store.update(store.tasks[0].id, task => {
      task.status = 'done'
      task.endedAt = Date.now()
      task.updatedAt = Date.now()
    })
    const result = evolution.generate('2026-11-06')
    assert.equal(result.ok, true)
    assert.equal(result.date, '2026-11-06')
    assert.throws(() => evolution.generate('2026-11-06'), error => error instanceof HttpError && error.status === 409)
    // Let the background generation settle.
    const deadline = Date.now() + 10_000
    while (evolution.isGenerating() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(evolution.isGenerating(), false)
    assert.ok(prompts.length >= 1)
    assert.equal(store.settings.evolution.lastStatus, 'ok')
    assert.equal(store.settings.evolution.lastDate, '2026-11-06')
    assert.ok(store.evolution.lastRunAt)
    const files = evolution.listRetrospectives()
    assert.equal(files.length, 1)
    assert.ok(evolution.readRetrospective('2026-11-06').startsWith('# 2026-11-06 复盘'))
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------- store API

test('TaskStore: evolution defaults, settings validation and persistence', () => {
  const first = tempStore()
  try {
    const { store } = first
    assert.equal(store.settings.evolution.enabled, true)
    assert.equal(store.settings.evolution.interval, 'daily')
    assert.equal(store.settings.evolution.time, '22:00')
    assert.equal(store.settings.evolution.skillMode, 'ask')
    assert.equal(store.state.version, 4)
    assert.deepEqual(store.evolution, { lessons: [], skills: [], lastRunAt: null })

    // validation
    assert.throws(() => store.updateSettings({ evolution: { interval: 'hourly' } }), e => e instanceof HttpError && e.status === 400)
    assert.throws(() => store.updateSettings({ evolution: { time: '9:00' } }), e => e instanceof HttpError && e.status === 400)
    assert.throws(() => store.updateSettings({ evolution: { skillMode: 'sometimes' } }), e => e instanceof HttpError && e.status === 400)
    assert.throws(() => store.updateSettings({ evolution: { weekday: 7 } }), e => e instanceof HttpError && e.status === 400)

    store.updateSettings({
      evolution: { interval: 'weekly', time: '23:30', weekday: 3, skillMode: 'auto' },
    })
    assert.equal(store.settings.evolution.interval, 'weekly')
    assert.equal(store.settings.evolution.time, '23:30')
    assert.equal(store.settings.evolution.weekday, 3)
    assert.equal(store.settings.evolution.skillMode, 'auto')

    const lessonA = store.addLesson({ text: 'Use npm, not pnpm', category: 'process' })
    assert.equal(lessonA.source, 'manual')
    assert.equal(lessonA.active, true)
    assert.match(lessonA.id, /^l_/)
    const projectLesson = store.addLesson({ text: 'Run static check', category: 'process', scope: 'project', project: PROJECT })
    assert.equal(projectLesson.scope, 'project')
    assert.throws(() => store.addLesson({ text: 'missing project', scope: 'project' }), e => e instanceof HttpError && e.status === 400)

    const paused = store.updateLesson(lessonA.id, { active: false })
    assert.equal(paused.active, false)
    assert.throws(() => store.updateLesson('nope', { active: true }), e => e instanceof HttpError && e.status === 404)
    assert.equal(store.deleteLesson(lessonA.id), true)
    assert.equal(store.deleteLesson(lessonA.id), false)

    store.replaceLessons(Array.from({ length: 45 }, (_, index) => ({
      text: 'rule ' + index, category: 'process', scope: 'global', updatedAt: index,
    })))
    assert.equal(store.evolution.lessons.length, 40)

    store.replaceSkills([
      skill({ name: 'alpha-skill', status: 'active' }),
      skill({ name: 'beta-skill', status: 'proposed' }),
      skill({ name: 'alpha-skill', status: 'proposed', description: 'duplicate should be dropped' }),
    ])
    assert.equal(store.evolution.skills.length, 2)
    assert.equal(store.evolution.skills.find(item => item.name === 'alpha-skill').status, 'active')
    const adopted = store.setSkillStatus('beta-skill', 'active')
    assert.equal(adopted.status, 'active')
    assert.throws(() => store.setSkillStatus('missing-skill', 'active'), e => e instanceof HttpError && e.status === 404)
    assert.equal(store.deleteSkill('beta-skill'), true)

    store.setEvolutionLastRun(123456)
    store.updateEvolutionStatus({ lastDate: '2026-11-06', lastStatus: 'ok', lastCoveredSince: 1, generatingDate: null })

    // persistence
    const reloaded = new TaskStore({ dir: first.dir })
    assert.equal(reloaded.settings.evolution.interval, 'weekly')
    assert.equal(reloaded.evolution.lessons.length, 40)
    assert.equal(reloaded.evolution.skills.length, 1)
    assert.equal(reloaded.evolution.lastRunAt, 123456)
    assert.equal(reloaded.settings.evolution.lastStatus, 'ok')
    const meta = reloaded.getEvolutionMeta()
    assert.equal(meta.enabled, true)
    assert.equal(meta.lessonCount, 40)
    assert.equal(meta.activeSkillCount, 1)
    assert.equal(meta.proposedSkillCount, 0)
  } finally {
    first.cleanup()
  }
})

test('TaskStore: v8 state without evolution data loads with defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ps-legacy-'))
  try {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      version: 4,
      rev: 7,
      settings: { concurrency: 3, autoStart: false, group: '秘书台', dailyReport: { enabled: false, time: '08:15' } },
      tasks: [],
      syncSince: 1,
      ownedSessions: [],
      removedSessions: [],
    }))
    const store = new TaskStore({ dir })
    assert.equal(store.rev, 7)
    assert.equal(store.settings.concurrency, 3)
    assert.equal(store.settings.autoStart, false)
    assert.equal(store.settings.evolution.enabled, true)
    assert.equal(store.settings.evolution.time, '22:00')
    assert.equal(store.settings.webhook.events.retrospective, true)
    // v0.6 additive settings: an old document also gets the morning brief.
    assert.equal(store.settings.webhook.events.morningBrief, true)
    assert.equal(store.settings.morningBrief.enabled, true)
    assert.equal(store.settings.morningBrief.time, '08:30')
    assert.deepEqual(store.evolution.lessons, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TaskStore: v0.6 morningBrief is additive and webhook events grow to seven', () => {
  const first = tempStore()
  try {
    assert.deepEqual(WEBHOOK_EVENTS,
      ['claimed', 'succeeded', 'blocked', 'failed', 'dailyReport', 'morningBrief', 'retrospective'])
    assert.equal(first.store.settings.morningBrief.enabled, true)
    assert.equal(first.store.settings.morningBrief.time, '08:30')
    assert.equal(first.store.state.version, 4)
    // Runtime bookkeeping has its own setter and survives a reload.
    first.store.updateMorningBrief({ lastDate: '2026-11-11', lastStatus: 'ok', lastGeneratedAt: 42, generatingDate: null })
    assert.throws(() => first.store.updateSettings({ morningBrief: { time: '8:30' } }),
      error => error instanceof HttpError && error.status === 400)
    const reloaded = new TaskStore({ dir: first.dir })
    assert.equal(reloaded.settings.webhook.events.morningBrief, true)
    assert.equal(reloaded.settings.morningBrief.lastStatus, 'ok')
    assert.equal(reloaded.settings.morningBrief.lastDate, '2026-11-11')
    assert.equal(reloaded.settings.morningBrief.lastGeneratedAt, 42)
  } finally {
    first.cleanup()
  }
})

// ---------------------------------------------------------------- webhook template

test('retrospectiveMarkdown: carries the report summary and counters', () => {
  const markdown = retrospectiveMarkdown({
    date: '2026-11-06',
    content: '# 2026-11-06 复盘\n\n## 一、本期概览\n\n完成 2 项。',
    path: '/tmp/evolution/2026-11-06.md',
    lessonsAdded: 2,
    skillsSuggested: 1,
    skillsActivated: 0,
  })
  assert.ok(markdown.includes('复盘'))
  assert.ok(markdown.includes('完成 2 项'))
  assert.ok(markdown.includes('2'))
  assert.ok(markdown.includes('/tmp/evolution/2026-11-06.md'))
})

/**
 * Self-evolution engine (v9).
 *
 * A retrospective is a scheduled review of a time window of secretary work:
 * the Host aggregates the window's tasks, failures and the user's follow-up
 * corrections, a model turns them into a report plus actionable lesson rules
 * (and, optionally, reusable skills), and everything is persisted under the
 * secretary state directory. Lessons are archived for review only: task
 * prompts are never prefixed with them (the conversation must contain exactly
 * what the user wrote); active skills are exposed to DSH sessions through a
 * runtime skill provider.
 *
 * The pure functions in this module are the contract other modules and the
 * unit tests rely on; `createEvolution` owns the timer, the Session, and the
 * provider registration.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import {
  DEFAULT_RETRO_TIME,
  HttpError,
  LESSON_CATEGORIES,
  MAX_LESSONS,
  MAX_SKILLS,
  MAX_LESSON_TEXT,
  REPORT_DATE_PATTERN,
  REPORT_TIME_PATTERN,
  SKILL_STATUSES,
  normalizeLesson,
  normalizeSkill,
} from './store.js'

// ---------------------------------------------------------------------------
// Timing / limits (kept in one place so tests and the engine agree).
// ---------------------------------------------------------------------------
export const EVOLUTION_TICK_MS = 30_000
export const RETROSPECTIVE_POLL_MS = 1_000
export const RETROSPECTIVE_MAX_WAIT_MS = 600_000
export const MAX_INJECTED_LESSONS = 8
export const MAX_CORRECTION_TASKS = 10
export const MAX_CORRECTION_MESSAGES = 3
export const EVOLUTION_PROVIDER_NAME = 'secretary-evolution'
// Same rank as other DSH runtime providers: below project scoped providers
// (100/200), above user level providers (400+).
export const EVOLUTION_SKILL_RANK = 250

const RETROSPECTIVE_LIST_LIMIT = 200
const RETROSPECTIVE_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/
const MAX_REPORT_CHARS = 20_000
const MAX_PROMPT_TASKS = 40
const MAX_PROMPT_ACTIVE_TASKS = 20
const MAX_PROMPT_CORRECTIONS = 15
const MAX_RETRO_PROMPT_CHARS = 19_000

const LESSON_PROMPT_HEADING = '## 任务管家 · 过往复盘经验（执行任务时必须遵守，避免重犯）'

const STATUS_LABELS = {
  idea: '待开始',
  pending: '排队中',
  running: '执行中',
  paused: '已暂停',
  blocked: '阻塞',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const ACTIVE_TASK_STATUSES = ['pending', 'running', 'paused', 'blocked']

const REPORT_SECTIONS = [
  '## 一、本期概览',
  '## 二、做得好',
  '## 三、错误与用户纠正',
  '## 四、经验规则',
  '## 五、可沉淀为 Skill 的重复模式',
]

// ---------------------------------------------------------------------------
// Small local helpers (the Host half duplicates these instead of importing a
// sibling module, so host/evolution.js never depends on the scheduler/api).
// ---------------------------------------------------------------------------
function pad(value) {
  return String(value).padStart(2, '0')
}

/** Local calendar date, `YYYY-MM-DD`. */
function localDateString(time = Date.now()) {
  const date = new Date(time)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Local wall-clock time, `HH:mm`. */
function localTimeString(time = Date.now()) {
  const date = new Date(time)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function localDateTimeString(time) {
  const date = new Date(time)
  return `${localDateString(time)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `YYYY-MM-DD` that also names a real calendar day. */
function isRealDate(value) {
  const text = String(value || '')
  if (!REPORT_DATE_PATTERN.test(text)) return false
  const [year, month, day] = text.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

function errorMessage(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function trimError(message, limit = 500) {
  const text = String(message || '未知错误')
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function sleep(ms) {
  return new Promise(resolvePromise => {
    const handle = setTimeout(resolvePromise, ms)
    if (handle && typeof handle.unref === 'function') handle.unref()
  })
}

function compactText(text, limit) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean
}

function formatDuration(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  const seconds = Math.round(value / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes} 分 ${rest} 秒`
}

function normalizeProject(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? resolve(text) : ''
}

/** A project-scoped item applies to its own directory and everything below it. */
function isWithinProject(cwd, project) {
  const root = normalizeProject(project)
  const directory = typeof cwd === 'string' ? cwd.trim() : ''
  if (!root || !directory) return false
  const resolved = resolve(directory)
  if (resolved === root) return true
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return resolved.startsWith(prefix)
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status
}

// ---------------------------------------------------------------------------
// Pure schedule helpers.
// ---------------------------------------------------------------------------

/**
 * The retrospective timer's due rule: enabled, the local clock has passed the
 * configured time, today has no successful retrospective yet, no generation is
 * in flight, and (weekly) today is the configured weekday.
 */
export function isRetrospectiveDue(settings, now = Date.now()) {
  if (!settings || settings.enabled !== true) return false
  const time = REPORT_TIME_PATTERN.test(String(settings.time || ''))
    ? settings.time
    : DEFAULT_RETRO_TIME
  if (localTimeString(now) < time) return false
  if (settings.lastDate === localDateString(now)) return false
  if (settings.generatingDate) return false
  if (settings.interval === 'weekly') {
    const weekday = Number.isInteger(settings.weekday) ? settings.weekday : 1
    if (new Date(now).getDay() !== weekday) return false
  }
  return true
}

/**
 * The window a retrospective covers: from the previous successful run's start
 * instant up to now. Without a previous run the window falls back to one day
 * (daily) or seven days (weekly).
 */
export function periodWindow(settings, lastRunAt, now = Date.now()) {
  const until = Number.isFinite(now) ? now : Date.now()
  const interval = settings && settings.interval === 'weekly' ? 'weekly' : 'daily'
  const span = interval === 'weekly' ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000
  const since = Number.isFinite(lastRunAt) && lastRunAt <= until ? lastRunAt : until - span
  return { since, until }
}

// ---------------------------------------------------------------------------
// Lesson selection / prompt injection.
// ---------------------------------------------------------------------------

/**
 * Legacy selector kept for the evolution API/tests. Task prompts no longer
 * receive these blocks — lessons are review material only.
 *
 * Active entries whose scope
 * matches the task directory. Project matches come first (most recent first),
 * then globals; capped at `limit`.
 */
export function selectLessonsForTask(lessons, task, limit = MAX_INJECTED_LESSONS) {
  const list = Array.isArray(lessons) ? lessons : []
  const max = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : MAX_INJECTED_LESSONS
  if (max === 0) return []
  const cwd = task && typeof task.cwd === 'string' ? task.cwd : ''
  const projectLessons = []
  const globalLessons = []
  for (const lesson of list) {
    if (!lesson || typeof lesson !== 'object' || lesson.active === false) continue
    if (typeof lesson.text !== 'string' || !lesson.text.trim()) continue
    if (lesson.scope === 'project') {
      if (isWithinProject(cwd, lesson.project)) projectLessons.push(lesson)
    } else {
      globalLessons.push(lesson)
    }
  }
  const byUpdatedAt = (left, right) =>
    (Number.isFinite(right.updatedAt) ? right.updatedAt : 0) -
    (Number.isFinite(left.updatedAt) ? left.updatedAt : 0)
  projectLessons.sort(byUpdatedAt)
  globalLessons.sort(byUpdatedAt)
  return [...projectLessons, ...globalLessons].slice(0, max)
}

/** The Markdown block injected in front of a task prompt (empty list -> ''). */
export function buildLessonsPromptBlock(lessons) {
  const list = Array.isArray(lessons) ? lessons : []
  const lines = []
  for (const lesson of list) {
    const text = lesson && typeof lesson.text === 'string' ? lesson.text.trim() : ''
    if (text) lines.push(`- ${text}`)
  }
  if (lines.length === 0) return ''
  return [LESSON_PROMPT_HEADING, ...lines].join('\n')
}

/**
 * Legacy helper: prefix a task prompt with lesson rules. The scheduler no
 * longer calls this (the user's task message must stay untouched).
 *
 * With no lessons the
 * base prompt is returned byte-for-byte unchanged.
 */
export function buildTaskPromptWithLessons(basePrompt, lessons) {
  const base = basePrompt === undefined || basePrompt === null ? '' : String(basePrompt)
  const block = buildLessonsPromptBlock(lessons)
  if (!block) return base
  return `${block}\n\n---\n\n${base}`
}

// ---------------------------------------------------------------------------
// Retrospective data collection.
// ---------------------------------------------------------------------------

function taskStamps(task) {
  return [task.createdAt, task.startedAt, task.endedAt, task.updatedAt].filter(Number.isFinite)
}

/** Queue tasks with any activity inside [since, until]. */
function tasksInWindow(store, since, until) {
  const tasks = []
  for (const task of store.tasks || []) {
    if (!task || task.source !== 'queue') continue
    const stamps = taskStamps(task)
    if (stamps.some(time => time >= since && time <= until)) tasks.push(task)
  }
  return tasks
}

/** Tasks that are still open right now (regardless of the window). */
function activeQueueTasks(store) {
  return (store.tasks || []).filter(task =>
    task && task.source === 'queue' && ACTIVE_TASK_STATUSES.includes(task.status))
}

function taskErrorEntry(task) {
  return {
    id: task.id,
    title: task.title,
    error: compactText(task.error || '未知错误', 500),
    cwd: task.cwd || '',
    failedAt: Number.isFinite(task.endedAt) ? task.endedAt : (task.updatedAt || task.createdAt || null),
  }
}

function correctionCandidates(store, windowTasks, activeTasks) {
  const bySession = new Map()
  for (const task of [...activeTasks, ...windowTasks]) {
    if (!task || !task.sessionId || bySession.has(task.sessionId)) continue
    bySession.set(task.sessionId, task)
  }
  const candidates = [...bySession.values()]
  candidates.sort((left, right) =>
    (Number.isFinite(right.updatedAt) ? right.updatedAt : 0) -
    (Number.isFinite(left.updatedAt) ? left.updatedAt : 0))
  return candidates
}

/**
 * Gather everything the retrospective prompt needs for one window.
 *
 * The first user message of a task Session is the task prompt the secretary
 * admitted itself; every later `user` message is a correction or addition the
 * human wrote while supervising the run, which is exactly what a retrospective
 * must mine.
 */
export async function collectRetrospectiveData({ store, bridge, since, until, options = {} }) {
  const from = Number.isFinite(since) ? since : (Number.isFinite(until) ? until - 24 * 60 * 60 * 1000 : Date.now() - 24 * 60 * 60 * 1000)
  const to = Number.isFinite(until) ? until : Date.now()
  const date = options && typeof options.date === 'string' && isRealDate(options.date)
    ? options.date
    : localDateString(to)
  const maxTasks = Number.isFinite(options.maxCorrectionTasks)
    ? Math.max(0, Math.floor(options.maxCorrectionTasks))
    : MAX_CORRECTION_TASKS
  const maxMessages = Number.isFinite(options.maxCorrectionMessages)
    ? Math.max(0, Math.floor(options.maxCorrectionMessages))
    : MAX_CORRECTION_MESSAGES

  const tasks = tasksInWindow(store, from, to)
  const activeTasks = activeQueueTasks(store)
  const errors = tasks.filter(task => task.status === 'failed' || task.error).map(taskErrorEntry)

  const corrections = []
  if (maxTasks > 0 && maxMessages > 0 && bridge && typeof bridge.transcript === 'function') {
    const candidates = correctionCandidates(store, tasks, activeTasks).slice(0, maxTasks)
    for (const task of candidates) {
      if (!task.sessionId) continue
      let transcript = null
      try {
        transcript = await bridge.transcript(task.sessionId)
      } catch {
        transcript = null
      }
      const messages = Array.isArray(transcript?.messages) ? transcript.messages : []
      const userMessages = messages.filter(message => message && message.role === 'user' && typeof message.text === 'string' && message.text.trim())
      // The first user message is the task prompt itself, not a correction.
      const appended = userMessages.slice(1)
      if (appended.length === 0) continue
      const picked = appended.slice(-maxMessages).map(message => ({
        text: compactText(message.text, 400),
        time: Number.isFinite(message.time) ? message.time : null,
      }))
      corrections.push({
        taskId: task.id,
        taskTitle: task.title,
        cwd: task.cwd || '',
        messages: picked,
      })
    }
  }

  return { date, tasks, corrections, errors, activeTasks }
}

// ---------------------------------------------------------------------------
// Retrospective prompt.
// ---------------------------------------------------------------------------

function describeTaskLine(task) {
  const parts = [`[${statusLabel(task.status)}] ${task.title || '未命名任务'}`]
  parts.push(`失败：${task.status === 'failed' ? '是' : '否'}`)
  if (task.error) parts.push(`错误：${compactText(task.error, 200)}`)
  const summary = task.resultSummary
    || (task.result && task.result.finalAnswer)
    || task.resultPreview
    || ''
  if (summary) parts.push(`结果：${compactText(summary, 200)}`)
  if (task.cwd) parts.push(`目录：${task.cwd}`)
  if (Number.isFinite(task.durationMs)) parts.push(`耗时：${formatDuration(task.durationMs)}`)
  return `- ${parts.join('；')}`
}

function describeActiveTaskLine(task) {
  const parts = [`[${statusLabel(task.status)}] ${task.title || '未命名任务'}`]
  if (task.cwd) parts.push(`目录：${task.cwd}`)
  if (task.error) parts.push(`错误：${compactText(task.error, 200)}`)
  return `- ${parts.join('；')}`
}

function skillModeLabel(mode) {
  if (mode === 'off') return 'off（不生成技能）'
  if (mode === 'auto') return 'auto（生成后自动启用）'
  return 'ask（生成候选，等待用户采用）'
}

/**
 * The fixed retrospective request. Data blocks are plain Markdown; the output
 * contract is the three marker sections parsed by `extractEvolutionSections`.
 */
export function buildRetrospectivePrompt(input = {}) {
  const date = typeof input.date === 'string' && isRealDate(input.date) ? input.date : localDateString()
  const until = Number.isFinite(input.until) ? input.until : Date.now()
  const since = Number.isFinite(input.since) ? input.since : null
  const tasks = Array.isArray(input.tasks) ? input.tasks : []
  const corrections = Array.isArray(input.corrections) ? input.corrections : []
  const errors = Array.isArray(input.errors) ? input.errors : []
  const activeTasks = Array.isArray(input.activeTasks) ? input.activeTasks : []
  const lessons = Array.isArray(input.lessons) ? input.lessons : []
  const skills = Array.isArray(input.skills) ? input.skills : []
  const skillMode = input.skillMode === 'off' || input.skillMode === 'auto' ? input.skillMode : 'ask'

  const failedCount = tasks.filter(task => task.status === 'failed').length
  const windowText = since === null
    ? '此前没有成功复盘记录，本次覆盖最近一段时间的任务活动'
    : `${localDateTimeString(since)} 至 ${localDateTimeString(until)}`

  const taskLines = tasks.length
    ? tasks.slice(0, MAX_PROMPT_TASKS).map(describeTaskLine)
    : ['- 无']
  const activeLines = activeTasks.length
    ? activeTasks.slice(0, MAX_PROMPT_ACTIVE_TASKS).map(describeActiveTaskLine)
    : ['- 无']
  const errorLines = errors.length ? errors.slice(0, MAX_PROMPT_TASKS).map(entry =>
    `- 任务「${entry.title}」的失败原因：${compactText(entry.error, 300)}`) : ['- 无']

  const correctionLines = []
  for (const item of corrections) {
    for (const message of Array.isArray(item.messages) ? item.messages : []) {
      if (correctionLines.length >= MAX_PROMPT_CORRECTIONS) break
      correctionLines.push(`- 任务「${item.taskTitle}」的用户纠正：${compactText(message.text, 400)}`)
    }
    if (correctionLines.length >= MAX_PROMPT_CORRECTIONS) break
  }
  if (correctionLines.length === 0) correctionLines.push('- 无')

  const lessonLines = lessons.length
    ? lessons.map((lesson, index) => {
      const scope = lesson.scope === 'project' ? `项目：${lesson.project}` : '全局'
      return `${index + 1}. [${scope}] ${compactText(lesson.text, MAX_LESSON_TEXT)}`
    })
    : ['（无）']
  const skillLines = skills.length
    ? skills.map(skill => `- ${skill.name}：${compactText(skill.description, 160)}`)
    : ['（无）']

  const lines = [
    '你是「任务管家」的复盘引擎；只输出规定格式，不调用任何工具、不创建或写入文件、不解释过程。',
    '',
    '## 数据',
    `- 复盘日期：${date}`,
    `- 覆盖窗口：${windowText}`,
    `- 任务数量：${tasks.length}（失败 ${failedCount}）`,
    `- 技能沉淀模式：${skillModeLabel(skillMode)}`,
    '',
    '### 本期任务',
    ...taskLines,
    '',
    '### 当前活跃任务',
    ...activeLines,
    '',
    '### 失败与错误',
    ...errorLines,
    '',
    '### 用户纠正/补充（优先从中提炼经验）',
    ...correctionLines,
    '',
    '### 已有经验（不得重复输出，除非补充证据）',
    ...lessonLines,
    '',
    '### 已有技能（不得同名）',
    ...skillLines,
    '',
    '## 输出格式（严格遵循）',
    '只输出下面以 marker 分隔的内容；marker 行必须原样出现，不要用任何代码围栏包裹 marker：',
    '',
    '<<<RETROSPECTIVE>>>',
    `# ${date} 复盘`,
    '',
    REPORT_SECTIONS[0],
    REPORT_SECTIONS[1],
    REPORT_SECTIONS[2],
    REPORT_SECTIONS[3],
    REPORT_SECTIONS[4],
    '<<<LESSONS_JSON>>>',
    '[{"text":"可执行规则","category":"correction|error|preference|process|other","scope":"global|project","project":null,"evidence":"任务标题/日期"}]',
    ...(skillMode === 'off' ? [] : [
      '<<<SKILLS_JSON>>>',
      '[{"name":"kebab-case","description":"何时使用（≤120字）","whenToUse":"触发条件（≤120字）","scope":"global|project","project":null,"content":"Markdown 指令正文（≤4000字）"}]',
    ]),
    '<<<END>>>',
    '',
    '## 要求',
    '1. 报告必须使用上面给出的五个二级标题与顺序，正文不超过 1200 字；只写有数据依据的内容，没有内容的小节写「无」。',
    '2. 经验规则只输出**新增或需要更新**的规则；已有经验不得重复输出（除非补充证据）；每条是可执行祈使句、不超过 80 字；优先从「用户纠正」与「失败原因」提炼；没有新增就输出 []；最多 8 条。',
  ]
  if (skillMode !== 'off') {
    lines.push(
      `3. 技能只在发现「同类任务重复出现 ≥2 次」或「标准化流程明确」时输出，最多 3 条；不得与已有技能同名；必须是可复用的指令包而不是一次性任务描述；没有就输出 []${skillMode === 'auto' ? '；生成的技能会被直接启用' : '；生成的技能会作为候选等待用户采用'}。`,
    )
  }
  lines.push(
    '4. 项目作用域判断：与特定仓库/目录强相关的放 project 并填该任务绝对目录；通用工作方式放 global。',
    '5. 不要编造数据中不存在的任务、结果或纠正；不得输出规定 marker 之外的内容。',
  )

  let prompt = lines.join('\n')
  if (prompt.length > MAX_RETRO_PROMPT_CHARS) {
    prompt = `${prompt.slice(0, MAX_RETRO_PROMPT_CHARS)}\n\n（数据过多，已截断）`
  }
  return prompt
}

// ---------------------------------------------------------------------------
// Model output parsing.
// ---------------------------------------------------------------------------

const SECTION_MARKERS = {
  retrospective: '<<<RETROSPECTIVE>>>',
  lessons: '<<<LESSONS_JSON>>>',
  skills: '<<<SKILLS_JSON>>>',
  end: '<<<END>>>',
}

/** A code-fence-wrapped or backtick-wrapped marker still counts as a marker. */
function markerKind(line) {
  let cleaned = String(line || '').trim()
  if (!cleaned) return ''
  cleaned = cleaned.replace(/^`+/, '').replace(/`+$/, '').trim()
  if (!cleaned) return ''
  for (const [kind, marker] of Object.entries(SECTION_MARKERS)) {
    if (cleaned === marker) return kind
  }
  return ''
}

/** Strip one wrapping code fence (```markdown / ```json / plain ```). */
function stripCodeFence(text) {
  const value = String(text || '').trim()
  const match = /^`{3,}[A-Za-z0-9_-]*[ \t]*\n([\s\S]*?)\n?`{3,}[ \t]*$/.exec(value)
  return match ? match[1].trim() : value
}

/**
 * Split a model answer into report text and the two raw JSON sections.
 * Missing markers yield null for the raw sections; when the retrospective
 * marker itself is missing the whole answer is treated as the report.
 */
export function extractEvolutionSections(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const found = { retrospective: -1, lessons: -1, skills: -1, end: -1 }
  for (let index = 0; index < lines.length; index += 1) {
    const kind = markerKind(lines[index])
    if (kind && found[kind] < 0) found[kind] = index
  }
  if (found.retrospective < 0) {
    return { report: normalized.trim(), lessonsRaw: null, skillsRaw: null }
  }
  const laterBoundaries = [
    ['lessons', found.lessons],
    ['skills', found.skills],
    ['end', found.end],
  ].filter(([, index]) => index > found.retrospective).sort((left, right) => left[1] - right[1])
  const reportEnd = laterBoundaries.length > 0 ? laterBoundaries[0][1] : lines.length
  const report = lines.slice(found.retrospective + 1, reportEnd).join('\n').trim()

  const sectionText = startIndex => {
    if (startIndex < 0) return null
    const after = laterBoundaries.find(([, index]) => index > startIndex)
    const end = after ? after[1] : lines.length
    return stripCodeFence(lines.slice(startIndex + 1, end).join('\n')).trim()
  }

  return {
    report,
    lessonsRaw: sectionText(found.lessons),
    skillsRaw: sectionText(found.skills),
  }
}

/** Best-effort JSON array parse: fences stripped, narration ignored, no throw. */
function parseSuggestedJson(raw, label) {
  const text = stripCodeFence(raw)
  if (!text) return []
  const attempt = value => {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  let parsed = attempt(text)
  if (parsed === null) {
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start >= 0 && end > start) parsed = attempt(text.slice(start, end + 1))
  }
  if (parsed === null) {
    try {
      console.warn('[personal-secretary] 复盘 JSON 解析失败：', label)
    } catch {
      // logging must never break the generation flow
    }
    return []
  }
  return parsed
}

const RETRO_HEADING = /^#{1,2}\s+\d{4}-\d{2}-\d{2}\s+复盘\s*$/

/**
 * Normalise a model-written report: strip a wrapping code fence, drop leading
 * narration before the `# <date> 复盘` heading (adding it when missing), trim
 * to one trailing newline and cap the length.
 */
export function extractRetrospectiveBody(text, date) {
  const day = typeof date === 'string' && isRealDate(date) ? date : localDateString()
  let normalized = String(text || '').replace(/\r\n?/g, '\n').trim()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const fenced = /^`{3,}[A-Za-z0-9_-]*[ \t]*\n([\s\S]*?)\n?`{3,}[ \t]*$/.exec(normalized)
    if (!fenced) break
    normalized = fenced[1].trim()
  }
  if (!normalized) return `# ${day} 复盘\n`
  const lines = normalized.split('\n')
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (RETRO_HEADING.test(lines[index].trim())) {
      start = index
      break
    }
  }
  let body
  if (start >= 0) {
    body = lines.slice(start).join('\n').trim()
  } else {
    body = `# ${day} 复盘\n\n${normalized}`.trim()
  }
  body = body.trimEnd()
  if (body.length > MAX_REPORT_CHARS) body = body.slice(0, MAX_REPORT_CHARS).trimEnd()
  return `${body}\n`
}

/** True when the report has real section content below its heading. */
function reportHasContent(markdown) {
  const lines = String(markdown || '').split('\n')
  if (lines.length <= 1) return false
  return lines.slice(1).join('\n').trim().length > 0
}

// ---------------------------------------------------------------------------
// Merge model suggestions into durable state.
// ---------------------------------------------------------------------------

/**
 * Merge suggested lesson rules into the existing list.
 * Matching is exact on trimmed, case-insensitive text: a match updates
 * evidence/updatedAt and re-activates it, otherwise a new retrospective lesson
 * is appended. The result is capped at MAX_LESSONS by recency.
 */
export function mergeSuggestedLessons(existing, suggested, now = Date.now()) {
  const stamp = Number.isFinite(now) ? now : Date.now()
  const lessons = (Array.isArray(existing) ? existing : []).map(normalizeLesson).filter(Boolean)
  const items = Array.isArray(suggested) ? suggested : []
  let added = 0
  let updated = 0
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string') continue
    const text = raw.text.trim().slice(0, MAX_LESSON_TEXT)
    if (!text) continue
    const scope = raw.scope === 'project' ? 'project' : 'global'
    let project = null
    if (scope === 'project') {
      const candidate = typeof raw.project === 'string' ? raw.project.trim() : ''
      // A project-scoped rule without a project directory is unusable: drop it.
      if (!candidate) continue
      project = resolve(candidate)
    }
    const key = text.toLowerCase()
    const match = lessons.find(lesson => lesson.text.trim().toLowerCase() === key)
    const evidence = typeof raw.evidence === 'string' ? raw.evidence.trim().slice(0, 200) : ''
    if (match) {
      if (evidence) match.evidence = evidence
      match.updatedAt = stamp
      match.active = true
      updated += 1
      continue
    }
    const lesson = normalizeLesson({
      text,
      category: LESSON_CATEGORIES.includes(raw.category) ? raw.category : 'other',
      scope,
      project,
      evidence,
      source: 'retrospective',
      active: true,
      createdAt: stamp,
      updatedAt: stamp,
    })
    if (!lesson) continue
    lessons.push(lesson)
    added += 1
  }
  lessons.sort((left, right) =>
    (Number.isFinite(right.updatedAt) ? right.updatedAt : 0) -
    (Number.isFinite(left.updatedAt) ? left.updatedAt : 0))
  return { lessons: lessons.slice(0, MAX_LESSONS), added, updated }
}

/**
 * Append suggested skills. Same-name entries (existing or earlier in this
 * batch) are skipped so a model can never overwrite a human-managed skill.
 */
export function mergeSuggestedSkills(existing, suggested, status, now = Date.now()) {
  const stamp = Number.isFinite(now) ? now : Date.now()
  const targetStatus = SKILL_STATUSES.includes(status) ? status : 'proposed'
  const skills = (Array.isArray(existing) ? existing : []).map(normalizeSkill).filter(Boolean)
  const seen = new Set(skills.map(skill => skill.name))
  const added = []
  let skipped = 0
  for (const raw of Array.isArray(suggested) ? suggested : []) {
    if (!raw || typeof raw !== 'object') {
      skipped += 1
      continue
    }
    const skill = normalizeSkill({
      ...raw,
      status: targetStatus,
      source: 'retrospective',
      createdAt: stamp,
      updatedAt: stamp,
    })
    if (!skill || seen.has(skill.name)) {
      skipped += 1
      continue
    }
    seen.add(skill.name)
    skills.push(skill)
    added.push(skill)
  }
  skills.sort((left, right) =>
    (Number.isFinite(right.updatedAt) ? right.updatedAt : 0) -
    (Number.isFinite(left.updatedAt) ? left.updatedAt : 0))
  return { skills: skills.slice(0, MAX_SKILLS), added, skipped }
}

// ---------------------------------------------------------------------------
// Runtime skill provider.
// ---------------------------------------------------------------------------

/** Active skills whose scope matches `cwd` (missing cwd -> global only). */
export function selectApplicableSkills(skills, cwd) {
  return (Array.isArray(skills) ? skills : []).filter(skill =>
    Boolean(skill) && skill.status === 'active' && isSkillApplicable(skill, cwd))
}

function isSkillApplicable(skill, cwd) {
  if (!skill || skill.status !== 'active') return false
  if (skill.scope !== 'project') return true
  return isWithinProject(cwd, skill.project)
}

/** The full definition a DSH skill provider returns from `get()`. */
export function buildSkillDefinition(skill) {
  if (!skill || typeof skill !== 'object') return undefined
  const definition = {
    name: skill.name,
    description: skill.description,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'personal-secretary',
    provider: EVOLUTION_PROVIDER_NAME,
    content: skill.content,
  }
  if (typeof skill.whenToUse === 'string' && skill.whenToUse.trim()) {
    definition.whenToUse = skill.whenToUse.trim()
  }
  return definition
}

// ---------------------------------------------------------------------------
// Files.
// ---------------------------------------------------------------------------

/** Newest-first retrospective files under `dir`, at most 200 entries. */
export function listRetrospectiveFiles(dir) {
  if (typeof dir !== 'string' || dir === '') return []
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const files = []
  for (const name of names) {
    if (!RETROSPECTIVE_FILE_PATTERN.test(name)) continue
    const path = join(dir, name)
    try {
      const info = statSync(path)
      if (!info.isFile()) continue
      files.push({
        date: name.slice(0, -3),
        path,
        bytes: info.size,
        updatedAt: info.mtimeMs,
      })
    } catch {
      // A file removed between readdir and stat is simply skipped.
    }
  }
  files.sort((left, right) => (left.date < right.date ? 1 : left.date > right.date ? -1 : 0))
  return files.slice(0, RETROSPECTIVE_LIST_LIMIT)
}

/** Read one retrospective; missing file -> undefined, bad date -> HttpError. */
export function readRetrospectiveFile(dir, date) {
  const text = String(date || '')
  if (!isRealDate(text)) throw new HttpError(400, '日期格式应为 YYYY-MM-DD')
  if (typeof dir !== 'string' || dir === '') return undefined
  const path = join(dir, `${text}.md`)
  if (!existsSync(path)) return undefined
  return readFileSync(path, 'utf8')
}

// ---------------------------------------------------------------------------
// Local fallback report (model unavailable / unstructured output).
// ---------------------------------------------------------------------------

/** Deterministic report assembled from the gathered data, no model needed. */
export function buildRetrospectiveFallback(data = {}) {
  const date = typeof data.date === 'string' && isRealDate(data.date) ? data.date : localDateString()
  const tasks = Array.isArray(data.tasks) ? data.tasks : []
  const corrections = Array.isArray(data.corrections) ? data.corrections : []
  const errors = Array.isArray(data.errors) ? data.errors : []
  const activeTasks = Array.isArray(data.activeTasks) ? data.activeTasks : []
  const completed = tasks.filter(task => task.status === 'done')
  const failed = tasks.filter(task => task.status === 'failed')
  const correctionCount = corrections.reduce((total, item) =>
    total + (Array.isArray(item.messages) ? item.messages.length : 0), 0)

  const lines = [`# ${date} 复盘`, '', REPORT_SECTIONS[0], '']
  if (tasks.length === 0 && activeTasks.length === 0) {
    lines.push('本期没有任务活动。')
  } else {
    lines.push(`本期共 ${tasks.length} 项任务有活动：完成 ${completed.length} 项，失败 ${failed.length} 项；当前活跃任务 ${activeTasks.length} 项；记录到用户纠正/补充 ${correctionCount} 条。`)
  }

  lines.push('', REPORT_SECTIONS[1], '')
  if (completed.length > 0) {
    for (const task of completed.slice(0, 10)) {
      lines.push(`- 完成「${task.title}」${task.resultSummary ? `：${compactText(task.resultSummary, 60)}` : ''}`)
    }
  } else {
    lines.push('无')
  }

  lines.push('', REPORT_SECTIONS[2], '')
  if (errors.length > 0) {
    for (const entry of errors.slice(0, 10)) lines.push(`- 失败「${entry.title}」：${compactText(entry.error, 200)}`)
  }
  let correctionLines = 0
  for (const item of corrections) {
    for (const message of Array.isArray(item.messages) ? item.messages : []) {
      if (correctionLines >= 10) break
      lines.push(`- 用户纠正「${item.taskTitle}」：${compactText(message.text, 200)}`)
      correctionLines += 1
    }
    if (correctionLines >= 10) break
  }
  if (errors.length === 0 && correctionLines === 0) lines.push('无')

  lines.push('', REPORT_SECTIONS[3], '')
  lines.push('- 本次复盘由本地兜底生成（模型未返回可用内容），经验规则本次不更新，原有经验保持不变。')

  lines.push('', REPORT_SECTIONS[4], '')
  lines.push('- 本次未识别到新的技能候选。')

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

// ---------------------------------------------------------------------------
// Engine.
// ---------------------------------------------------------------------------

/**
 * Create the retrospective engine.
 *
 * Mirrors `createReports`: one 30s timer, one background Session per run,
 * atomic file writes, and a restart recovery pass. The engine also owns the
 * runtime skill provider that exposes active distilled skills to DSH.
 */
export function createEvolution({ ctx, store, bridge, notify, options = {} }) {
  const tickMs = Number.isFinite(options.tickMs) ? options.tickMs : EVOLUTION_TICK_MS
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : RETROSPECTIVE_POLL_MS
  const maxWaitMs = Number.isFinite(options.maxWaitMs) ? options.maxWaitMs : RETROSPECTIVE_MAX_WAIT_MS
  const push = typeof notify === 'function' ? notify : () => {}
  let timer = null
  let kickHandle = null
  let disposed = false
  let providerDisposer = null
  let providerControl = null
  let skillsAvailable = false

  function log(...args) {
    try {
      console.log('[personal-secretary]', ...args)
    } catch {
      // logging must never break the retrospective engine
    }
  }

  function settings() {
    return store.settings.evolution
  }

  function evolutionDir() {
    const value = settings()
    return value && typeof value.dir === 'string' ? value.dir : join(store.dir, 'evolution')
  }

  function today() {
    return localDateString(Date.now())
  }

  function isGenerating() {
    const value = settings()
    return Boolean(value && value.generatingDate)
  }

  function listRetrospectives() {
    return listRetrospectiveFiles(evolutionDir())
  }

  function readRetrospective(date) {
    return readRetrospectiveFile(evolutionDir(), date)
  }

  function skillMeta(skill) {
    return {
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse || '',
      scope: skill.scope,
      project: skill.project,
      status: skill.status,
      source: skill.source,
      evidence: skill.evidence || '',
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
    }
  }

  /** Everything `GET /evolution` returns (minus its `ok` flag). */
  function meta() {
    const data = store.evolution || { lessons: [], skills: [], lastRunAt: null }
    return {
      settings: { ...settings() },
      skillsAvailable,
      lessons: data.lessons.map(lesson => ({ ...lesson })),
      skills: data.skills.map(skillMeta),
      retrospectives: listRetrospectives(),
      running: isGenerating(),
    }
  }

  // --- runtime skill provider ---------------------------------------------

  function providerCandidates(options_) {
    const cwd = options_ && typeof options_.cwd === 'string' ? options_.cwd : ''
    return selectApplicableSkills(store.evolution.skills, cwd).map(skill => {
      const candidate = {
        name: skill.name,
        description: skill.description,
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'personal-secretary',
        provider: EVOLUTION_PROVIDER_NAME,
        rank: EVOLUTION_SKILL_RANK,
        locator: { name: skill.name },
      }
      if (skill.whenToUse) candidate.whenToUse = skill.whenToUse
      return candidate
    })
  }

  function providerDefinition(candidate, options_) {
    let name = ''
    if (typeof candidate === 'string') name = candidate
    else if (candidate && typeof candidate === 'object') {
      if (typeof candidate.name === 'string') name = candidate.name
      else if (candidate.locator && typeof candidate.locator.name === 'string') name = candidate.locator.name
    }
    if (!name) return undefined
    const skill = store.evolution.skills.find(item => item.name === name && item.status === 'active')
    if (!skill) return undefined
    // Re-check project scope only when the caller states a cwd; the candidate
    // normally arrives from `list({cwd})` and is already scoped.
    if (options_ && typeof options_.cwd === 'string' && !isSkillApplicable(skill, options_.cwd)) {
      return undefined
    }
    return buildSkillDefinition(skill)
  }

  function createProvider(control) {
    if (control) providerControl = control
    return {
      name: EVOLUTION_PROVIDER_NAME,
      list(options_) {
        return providerCandidates(options_)
      },
      get(candidate, options_) {
        return providerDefinition(candidate, options_)
      },
    }
  }

  /** Push skill changes into the Host skill catalog immediately. */
  function invalidateSkills() {
    try {
      if (providerControl && typeof providerControl.invalidate === 'function') providerControl.invalidate()
    } catch (error) {
      log('skill provider invalidate failed:', errorMessage(error))
    }
  }

  function refreshSkills() {
    invalidateSkills()
  }

  function registerSkillProvider() {
    if (providerDisposer) return providerDisposer
    let service = null
    try {
      service = typeof ctx.get === 'function' ? ctx.get('skills') : null
    } catch {
      service = null
    }
    if (!service || typeof service.registerProvider !== 'function') {
      skillsAvailable = false
      return () => {}
    }
    skillsAvailable = true
    const install = () => {
      const dispose = service.registerProvider(control => createProvider(control))
      return typeof dispose === 'function' ? dispose : () => {}
    }
    try {
      if (typeof ctx.effect === 'function') {
        providerDisposer = ctx.effect(install, 'personal-secretary: evolution skill provider')
      } else {
        providerDisposer = install()
      }
    } catch (error) {
      log('skill provider registration failed:', errorMessage(error))
      providerDisposer = null
      return () => {}
    }
    if (typeof providerDisposer !== 'function') providerDisposer = () => {}
    return providerDisposer
  }

  // --- generation ----------------------------------------------------------

  function writeRetrospectiveFile(date, content) {
    const dir = evolutionDir()
    mkdirSync(dir, { recursive: true })
    const target = join(dir, `${date}.md`)
    const tmp = join(dir, `.${date}.md.${process.pid}.${Date.now()}.tmp`)
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, target)
    return target
  }

  function resolveTargetDate(value) {
    const text = value === undefined || value === null || value === ''
      ? today()
      : String(value).trim()
    if (!isRealDate(text)) throw new HttpError(400, '日期格式应为 YYYY-MM-DD')
    return text
  }

  function markSkipped(date, window, now) {
    const stamp = Number.isFinite(now) ? now : Date.now()
    store.updateEvolutionStatus({
      lastDate: date,
      lastStatus: 'ok',
      lastError: null,
      lastGeneratedAt: stamp,
      generatingDate: null,
      lastCoveredSince: window.since,
    })
    store.setEvolutionLastRun(stamp)
    log('retrospective skipped, no reviewable content:', date)
  }

  async function waitForTurn(sessionId, startedAt) {
    const deadline = startedAt + maxWaitMs
    for (;;) {
      if (disposed) throw new Error('复盘生成已取消：插件已停止')
      const last = await bridge.lastTurnEnd(sessionId)
      if (last && last.reason) {
        const time = Number.isFinite(last.time) ? last.time : startedAt
        if (time >= startedAt - 1000) return
      }
      if (Date.now() >= deadline) throw new Error('复盘生成超时（10 分钟）')
      await sleep(pollMs)
    }
  }

  function applySuggestions(sections, skillMode, stamp) {
    let lessonsChanged = 0
    if (sections.lessonsRaw !== null) {
      const suggested = parseSuggestedJson(sections.lessonsRaw, 'lessons')
      if (suggested.length > 0) {
        const merged = mergeSuggestedLessons(store.evolution.lessons, suggested, stamp)
        if (merged.added > 0 || merged.updated > 0) {
          store.replaceLessons(merged.lessons)
          lessonsChanged = merged.added + merged.updated
        }
      }
    }
    let skillsSuggested = 0
    let skillsActivated = 0
    if (skillMode !== 'off' && sections.skillsRaw !== null) {
      const suggested = parseSuggestedJson(sections.skillsRaw, 'skills')
      if (suggested.length > 0) {
        const status = skillMode === 'auto' ? 'active' : 'proposed'
        const merged = mergeSuggestedSkills(store.evolution.skills, suggested, status, stamp)
        if (merged.added.length > 0) {
          store.replaceSkills(merged.skills)
          skillsSuggested = merged.added.length
          skillsActivated = skillMode === 'auto' ? merged.added.length : 0
        }
      }
    }
    return { lessonsChanged, skillsSuggested, skillsActivated }
  }

  async function runGeneration(startedAt, window, date) {
    try {
      const collected = await collectRetrospectiveData({
        store,
        bridge,
        since: window.since,
        until: window.until,
        options: { date },
      })
      if (disposed) throw new Error('复盘生成已取消：插件已停止')
      if (collected.tasks.length === 0 && collected.activeTasks.length === 0 && collected.corrections.length === 0) {
        markSkipped(date, window, Date.now())
        return
      }
      const skillMode = settings().skillMode
      const prompt = buildRetrospectivePrompt({
        date,
        since: window.since,
        until: window.until,
        tasks: collected.tasks,
        corrections: collected.corrections,
        errors: collected.errors,
        activeTasks: collected.activeTasks,
        lessons: store.evolution.lessons,
        skills: store.evolution.skills,
        skillMode,
      })
      const dir = evolutionDir()
      mkdirSync(dir, { recursive: true })
      const sessionId = await bridge.createSession({ cwd: dir })
      // The retrospective Session is ours: it must not be imported as a
      // workspace task by the scheduler's session mirror.
      store.ownSession(sessionId)
      await bridge.selectModel(sessionId, {
        provider: store.settings.provider,
        model: store.settings.model,
        reasoningEffort: store.settings.reasoningEffort,
      })
      await bridge.prompt(sessionId, prompt)
      await waitForTurn(sessionId, startedAt)
      const summary = await bridge.summarize(sessionId)
      if (disposed) throw new Error('复盘生成已取消：插件已停止')

      const text = String(summary.finalAnswer || '').trim()
      const sections = extractEvolutionSections(text)
      let body = sections.report && sections.report.trim()
        ? extractRetrospectiveBody(sections.report, date)
        : buildRetrospectiveFallback(collected)
      if (!reportHasContent(body)) {
        log('retrospective model output was empty, using the local fallback report')
        body = buildRetrospectiveFallback(collected)
      }
      const generatedAt = Date.now()
      const applied = applySuggestions(sections, skillMode, generatedAt)
      const path = writeRetrospectiveFile(date, body)
      store.updateEvolutionStatus({
        lastDate: date,
        lastStatus: 'ok',
        lastError: null,
        lastGeneratedAt: generatedAt,
        generatingDate: null,
        lastCoveredSince: window.since,
      })
      // The next window starts at the instant this run started.
      store.setEvolutionLastRun(startedAt)
      if (applied.skillsSuggested > 0) invalidateSkills()
      try {
        push('retrospective', {
          date,
          content: body,
          path,
          lessonsAdded: applied.lessonsChanged,
          skillsSuggested: applied.skillsSuggested,
          skillsActivated: applied.skillsActivated,
        })
      } catch (error) {
        log('retrospective notify failed:', errorMessage(error))
      }
    } catch (error) {
      log('retrospective generation failed:', errorMessage(error))
      try {
        store.updateEvolutionStatus({
          lastStatus: 'failed',
          lastError: trimError(errorMessage(error), 500),
          generatingDate: null,
        })
      } catch (statusError) {
        log('retrospective failure bookkeeping failed:', errorMessage(statusError))
      }
    }
  }

  function generateAt(date, now) {
    if (disposed) throw new HttpError(409, '复盘引擎已停止')
    const target = resolveTargetDate(date)
    if (isGenerating()) throw new HttpError(409, '复盘正在生成中')
    const startedAt = Number.isFinite(now) ? now : Date.now()
    const window = periodWindow(settings(), store.evolution.lastRunAt, startedAt)
    if (tasksInWindow(store, window.since, window.until).length === 0 && activeQueueTasks(store).length === 0) {
      markSkipped(target, window, startedAt)
      return { ok: true, date: target, skipped: true }
    }
    store.updateEvolutionStatus({ lastStatus: 'running', lastError: null, generatingDate: target })
    void runGeneration(startedAt, window, target)
    return { ok: true, date: target }
  }

  /** Generate now (manual trigger); the generation itself runs in the background. */
  function generate(date) {
    return generateAt(date, Date.now())
  }

  async function checkDue(now = Date.now()) {
    try {
      if (disposed) return
      if (!isRetrospectiveDue(settings(), now)) return
      generateAt(localDateString(now), now)
    } catch (error) {
      log('retrospective due check failed:', errorMessage(error))
    }
  }

  function recoverStale() {
    const current = settings()
    if (!current) return
    if (current.lastStatus === 'running' || current.generatingDate) {
      store.updateEvolutionStatus({
        lastStatus: 'failed',
        lastError: '上次复盘未完成（进程已重启）',
        generatingDate: null,
      })
    }
  }

  function start() {
    if (timer || disposed) return
    recoverStale()
    timer = setInterval(() => { void checkDue() }, tickMs)
    if (typeof timer === 'object' && timer && typeof timer.unref === 'function') timer.unref()
    void checkDue()
  }

  function stop() {
    disposed = true
    if (timer) clearInterval(timer)
    timer = null
    if (kickHandle) clearTimeout(kickHandle)
    kickHandle = null
  }

  /** Immediate re-check after the schedule settings changed. */
  function kick() {
    if (disposed) return
    if (kickHandle) return
    kickHandle = setTimeout(() => {
      kickHandle = null
      void checkDue()
    }, 50)
    if (kickHandle && typeof kickHandle.unref === 'function') kickHandle.unref()
  }

  recoverStale()

  return {
    start,
    stop,
    kick,
    generate,
    checkDue,
    recoverStale,
    isGenerating,
    registerSkillProvider,
    refreshSkills,
    invalidateSkills,
    meta,
    listRetrospectives,
    readRetrospective,
    settings,
    today,
  }
}

export { MAX_LESSONS, MAX_SKILLS, localDateString, localTimeString, isRealDate, REPORT_SECTIONS, STATUS_LABELS }

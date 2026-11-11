/**
 * Durable private-secretary state: settings plus the ordered task list.
 *
 * One JSON document under the profile directory. Every mutation bumps `rev`,
 * which the browser uses to tell a fresh poll from a stale one. Writes are
 * atomic (temp file + rename) so a crash cannot leave a half-written board.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

// v4 (idea column + priority) is an additive schema change: tasks from a v3
// document load with `priority: 'normal'` and keep their status untouched.
// The version stays 4 on purpose: the loader keys the workspace import window
// on version equality, so a bump would needlessly replay 24h of sessions.
// v9 (self-evolution) is another additive normalise-only change: an old
// document loads with the default retrospective schedule and empty data.
export const STATE_VERSION = 4
export const DEFAULT_CONCURRENCY = 2
export const MAX_CONCURRENCY = 10
export const MAX_TITLE = 120
export const MAX_PROMPT = 200_000
export const MAX_BATCH = 100
export const MAX_GROUP = 60
export const DEFAULT_GROUP = '秘书台'
export const DEFAULT_REPORT_TIME = '21:00'
// v0.6 adds the morning brief schedule additively: an older document simply
// loads with the default 08:30 schedule and no run state.
export const DEFAULT_BRIEF_TIME = '08:30'
// v0.7: the morning brief carries up to three structured, one-click task
// suggestions produced by the model (persisted as `lastSuggestions`).
export const MAX_BRIEF_SUGGESTIONS = 3
const MAX_SUGGESTION_TITLE = 60
const MAX_SUGGESTION_REASON = 80
const MAX_SUGGESTION_PROMPT = 500
export const REPORT_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
export const REPORT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
export const TASK_STATUSES = ['idea', 'pending', 'running', 'paused', 'blocked', 'done', 'failed', 'cancelled']
// A task may only be *created* into one of these two columns; every other
// status is reached through an explicit action.
export const CREATE_STATUSES = ['idea', 'pending']
export const DEFAULT_CREATE_STATUS = 'idea'
export const TASK_PRIORITIES = ['urgent', 'high', 'normal', 'low']
export const DEFAULT_PRIORITY = 'normal'
export const PRIORITY_LABELS = { urgent: '紧急', high: '高', normal: '普通', low: '低' }
export const REPORT_STATUSES = ['idle', 'running', 'ok', 'failed']
export const WEBHOOK_FORMATS = ['generic', 'feishu', 'wecom', 'dingtalk', 'slack']
// v9 adds the retrospective event additively: an older document simply loads
// with the new event enabled, exactly like the other notification defaults.
// v0.6 inserts the morning-brief event before the retrospective one.
export const WEBHOOK_EVENTS = ['claimed', 'succeeded', 'blocked', 'failed', 'dailyReport', 'morningBrief', 'retrospective']
export const WEBHOOK_STATUSES = ['idle', 'ok', 'failed']

// ---------------------------------------------------------------------------
// Self-evolution (v9): retrospective schedule, lessons and distilled skills.
// ---------------------------------------------------------------------------
export const DEFAULT_RETRO_TIME = '22:00'
export const EVOLUTION_INTERVALS = ['daily', 'weekly']
export const EVOLUTION_SKILL_MODES = ['off', 'ask', 'auto']
export const LESSON_CATEGORIES = ['correction', 'error', 'preference', 'process', 'other']
export const LESSON_SCOPES = ['global', 'project']
export const SKILL_STATUSES = ['proposed', 'active', 'disabled']
export const MAX_LESSONS = 40
export const MAX_SKILLS = 20
export const MAX_LESSON_TEXT = 260
export const MAX_LESSON_EVIDENCE = 200
export const MAX_SKILL_NAME = 64
export const MAX_SKILL_DESCRIPTION = 300
export const MAX_SKILL_WHEN_TO_USE = 300
export const MAX_SKILL_CONTENT = 8000
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function defaultWebhook() {
  return {
    enabled: false,
    url: '',
    format: 'generic',
    secretHeader: 'Authorization',
    secret: '',
    events: {
      claimed: true,
      succeeded: true,
      blocked: true,
      failed: true,
      dailyReport: true,
      morningBrief: true,
      retrospective: true,
    },
    lastStatus: 'idle',
    lastAt: null,
    lastEvent: null,
    lastError: null,
  }
}

function normalizeWebhookUrl(value) {
  const raw = normOptionalString(value) || ''
  if (raw === '') return ''
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new HttpError(400, 'Webhook 地址不是合法 URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, 'Webhook 地址必须是 http(s) URL')
  }
  return raw
}

function normalizeWebhook(raw) {
  const base = defaultWebhook()
  if (!raw || typeof raw !== 'object') return base
  const next = { ...base, events: { ...base.events } }
  next.enabled = raw.enabled === true
  try {
    next.url = normalizeWebhookUrl(raw.url)
  } catch {
    next.url = ''
    next.enabled = false
  }
  if (WEBHOOK_FORMATS.includes(raw.format)) next.format = raw.format
  next.secretHeader = (normOptionalString(raw.secretHeader) || base.secretHeader).slice(0, 80)
  next.secret = typeof raw.secret === 'string' ? raw.secret.slice(0, 500) : ''
  if (raw.events && typeof raw.events === 'object') {
    for (const event of WEBHOOK_EVENTS) {
      if (event in raw.events) next.events[event] = raw.events[event] !== false
    }
  }
  if (WEBHOOK_STATUSES.includes(raw.lastStatus)) next.lastStatus = raw.lastStatus
  if (Number.isFinite(raw.lastAt)) next.lastAt = raw.lastAt
  if (typeof raw.lastEvent === 'string') next.lastEvent = raw.lastEvent.slice(0, 40)
  if (typeof raw.lastError === 'string') next.lastError = raw.lastError.slice(0, 500)
  return next
}

const MAX_SESSION_LEDGER = 300
// Automatic recovery points: every save keeps the previous document in
// `history/` before overwriting, so an accidental deletion (a bad click, a
// helper script, a bug) can be undone from the settings dialog.
const MAX_HISTORY_BACKUPS = 60
const HISTORY_DIR = 'history'
const HISTORY_NAME_PATTERN = /^state-[A-Za-z0-9._-]+\.json$/
const HISTORY_READ_PATTERN = /^state-.*\.json$/
const REPORT_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/

/**
 * Where the durable state lives.
 *
 * `$DSH_PROFILE_DIR/.personal-secretary` wins when the Host process knows its
 * profile; `$DSH_HOME/.personal-secretary` is the fallback (and the location
 * older installs used). When only the fallback file exists it is migrated once
 * into the profile location, so an upgrade keeps the board and settings.
 */
export function resolveDataLayout() {
  const profile = String(process.env.DSH_PROFILE_DIR || '').trim()
  const home = String(process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
  const primary = join(profile || home, '.personal-secretary')
  const legacy = profile ? [join(home, '.personal-secretary')] : []
  return { primary, legacy }
}

export function resolveDataDir() {
  return resolveDataLayout().primary
}

function copyReportFiles(from, to) {
  let names = []
  try {
    names = readdirSync(from)
  } catch {
    return
  }
  const files = names.filter(name => REPORT_FILE_PATTERN.test(name))
  if (files.length === 0) return
  mkdirSync(to, { recursive: true })
  for (const name of files) {
    const target = join(to, name)
    if (existsSync(target)) continue
    try {
      copyFileSync(join(from, name), target)
    } catch {
      // A single unreadable report must not block startup.
    }
  }
}

/** @returns the legacy directory the state was copied from, or null. */
function migrateStateDir(primary, legacyDirs) {
  const file = join(primary, 'state.json')
  if (existsSync(file)) return null
  for (const legacy of legacyDirs) {
    if (!legacy || resolve(legacy) === resolve(primary)) continue
    const legacyFile = join(legacy, 'state.json')
    if (!existsSync(legacyFile)) continue
    try {
      mkdirSync(primary, { recursive: true })
      copyFileSync(legacyFile, file)
      copyReportFiles(join(legacy, 'reports'), join(primary, 'reports'))
      return legacy
    } catch {
      return null
    }
  }
  return null
}

export function defaultDailyReport(stateDir) {
  return {
    enabled: true,
    time: DEFAULT_REPORT_TIME,
    dir: join(stateDir, 'reports'),
    lastDate: null,
    lastStatus: 'idle',
    lastError: null,
    lastGeneratedAt: null,
    generatingDate: null,
  }
}

/**
 * Default schedule + runtime bookkeeping for the v9 retrospective engine.
 *
 * `lastDate/lastStatus/lastError/lastGeneratedAt/generatingDate/lastCoveredSince`
 * are runtime state: they only change through `updateEvolutionStatus`, never
 * through a user settings patch.
 */
export function defaultEvolution(stateDir = resolveDataDir()) {
  return {
    enabled: true,
    interval: 'daily',
    time: DEFAULT_RETRO_TIME,
    weekday: 1,
    dir: join(stateDir, 'evolution'),
    skillMode: 'ask',
    lastDate: null,
    lastStatus: 'idle',
    lastError: null,
    lastGeneratedAt: null,
    generatingDate: null,
    lastCoveredSince: null,
  }
}

export function defaultSettings(stateDir = resolveDataDir()) {
  return {
    concurrency: DEFAULT_CONCURRENCY,
    provider: '',
    model: '',
    reasoningEffort: null,
    autoStart: true,
    notifyOnDone: true,
    group: DEFAULT_GROUP,
    dailyReport: defaultDailyReport(stateDir),
    morningBrief: defaultMorningBrief(stateDir),
    evolution: defaultEvolution(stateDir),
    // A fresh store must already own the default notification config: the
    // settings row and the webhook notifier both read it before the first save.
    webhook: defaultWebhook(),
  }
}

export function normalizeGroup(value, fallback = DEFAULT_GROUP) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? text.slice(0, MAX_GROUP) : fallback
}

/**
 * Where a newly published task lands. The product default is the idea column
 * (待开始): publishing captures the thought, but nothing runs until the user
 * explicitly promotes it into the claim queue.
 */
export function normalizeNewTaskStatus(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_CREATE_STATUS
  const text = String(value).trim()
  if (!CREATE_STATUSES.includes(text)) {
    throw new HttpError(400, '新任务状态只能是 idea（待开始）或 pending（排队中）')
  }
  return text
}

/** Priority is display/filter metadata only; it never influences scheduling. */
export function normalizePriority(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_PRIORITY
  const text = String(value).trim()
  if (!TASK_PRIORITIES.includes(text)) {
    throw new HttpError(400, '优先级只能是 urgent（紧急）/ high（高）/ normal（普通）/ low（低）')
  }
  return text
}

/**
 * Shared validation for one structured morning-brief suggestion (v0.7).
 *
 * The model returns `{title, reason, prompt, priority}` items that the UI can
 * turn into a queued task with one click. Invalid items are dropped, text is
 * clipped and an unknown priority falls back to `normal`.
 */
export function normalizeSuggestion(raw) {
  if (!raw || typeof raw !== 'object') return null
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, MAX_SUGGESTION_TITLE) : ''
  if (!title) return null
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, MAX_SUGGESTION_REASON) : ''
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim().slice(0, MAX_SUGGESTION_PROMPT) : ''
  const priority = TASK_PRIORITIES.includes(raw.priority) ? raw.priority : DEFAULT_PRIORITY
  return { title, reason, prompt: prompt || title, priority }
}

/** Normalise a suggestion list: keep valid entries, cap at MAX_BRIEF_SUGGESTIONS. */
export function normalizeSuggestions(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    const suggestion = normalizeSuggestion(item)
    if (!suggestion) continue
    out.push(suggestion)
    if (out.length >= MAX_BRIEF_SUGGESTIONS) break
  }
  return out
}

// v0.6: the priority rank drives the *insertion position* of a pending task.
// The user can still override the resulting order manually by dragging a card
// or by using "run next", which move the row and are never re-sorted.
export const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 }

export function pendingPriorityRank(priority) {
  return Object.prototype.hasOwnProperty.call(PRIORITY_RANK, priority)
    ? PRIORITY_RANK[priority]
    : PRIORITY_RANK[DEFAULT_PRIORITY]
}

/**
 * Index at which `task` should be spliced into `tasks` so that pending tasks
 * read urgent -> high -> normal -> low while keeping the existing relative
 * order of equal-rank tasks.
 *
 * Only the pending rows are considered: the insertion point is the first
 * pending row with a strictly lower rank, otherwise just after the last
 * pending row, otherwise the end of the array.
 */
export function pendingInsertIndex(tasks, task) {
  const list = Array.isArray(tasks) ? tasks : []
  const rank = pendingPriorityRank(task && task.priority)
  let lastPending = -1
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index]
    if (!item || item.status !== 'pending') continue
    lastPending = index
    if (pendingPriorityRank(item.priority) > rank) return index
  }
  return lastPending >= 0 ? lastPending + 1 : list.length
}

/** The report directory always persists as an absolute path. */
/**
 * True for a report directory that is the *default* of some secretary state
 * directory (`<...>/.personal-secretary/reports`). Such paths are remapped to
 * this install's state directory when a state file is migrated or moved.
 */
export function isDefaultSecretaryReportDir(value) {
  if (typeof value !== 'string' || value === '') return false
  const normalized = resolve(value)
  return basename(normalized) === 'reports' && basename(dirname(normalized)) === '.personal-secretary'
}

export function resolveReportDir(value, stateDir) {
  const fallback = join(stateDir, 'reports')
  if (value === null || value === undefined) return fallback
  const text = String(value).trim()
  if (!text) return fallback
  return resolve(text)
}

/** The retrospective output directory always persists as an absolute path. */
export function resolveEvolutionDir(value, stateDir) {
  const fallback = join(stateDir, 'evolution')
  if (value === null || value === undefined) return fallback
  const text = String(value).trim()
  if (!text) return fallback
  return resolve(text)
}

/**
 * True for an evolution directory that is the *default* of some secretary
 * state directory (`<...>/.personal-secretary/evolution`). Such paths are
 * remapped to this install's state directory when a state file moved.
 */
export function isDefaultSecretaryEvolutionDir(value) {
  if (typeof value !== 'string' || value === '') return false
  const normalized = resolve(value)
  return basename(normalized) === 'evolution' && basename(dirname(normalized)) === '.personal-secretary'
}

/** The morning-brief output directory always persists as an absolute path. */
export function resolveBriefDir(value, stateDir) {
  const fallback = join(stateDir, 'briefs')
  if (value === null || value === undefined) return fallback
  const text = String(value).trim()
  if (!text) return fallback
  return resolve(text)
}

/**
 * True for a brief directory that is the *default* of some secretary state
 * directory (`<...>/.personal-secretary/briefs`). Such paths are remapped to
 * this install's state directory when a state file moved.
 */
export function isDefaultSecretaryBriefDir(value) {
  if (typeof value !== 'string' || value === '') return false
  const normalized = resolve(value)
  return basename(normalized) === 'briefs' && basename(dirname(normalized)) === '.personal-secretary'
}

function clampConcurrency(value) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.round(n)))
}

function normOptionalString(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

function normalizeDailyReport(raw, stateDir) {
  const next = defaultDailyReport(stateDir)
  if (!raw || typeof raw !== 'object') return next
  next.enabled = raw.enabled !== false
  if (typeof raw.time === 'string' && REPORT_TIME_PATTERN.test(raw.time.trim())) next.time = raw.time.trim()
  next.dir = resolveReportDir(raw.dir, stateDir)
  next.lastDate = typeof raw.lastDate === 'string' && REPORT_DATE_PATTERN.test(raw.lastDate)
    ? raw.lastDate
    : null
  next.lastStatus = REPORT_STATUSES.includes(raw.lastStatus) ? raw.lastStatus : 'idle'
  next.lastError = typeof raw.lastError === 'string' && raw.lastError !== '' ? raw.lastError : null
  next.lastGeneratedAt = Number.isFinite(raw.lastGeneratedAt) ? raw.lastGeneratedAt : null
  next.generatingDate = typeof raw.generatingDate === 'string' && REPORT_DATE_PATTERN.test(raw.generatingDate)
    ? raw.generatingDate
    : null
  return next
}

/** Default schedule + runtime bookkeeping for the v0.6 morning-brief engine. */
export function defaultMorningBrief(stateDir = resolveDataDir()) {
  return {
    enabled: true,
    time: DEFAULT_BRIEF_TIME,
    dir: join(stateDir, 'briefs'),
    lastDate: null,
    lastStatus: 'idle',
    lastError: null,
    lastGeneratedAt: null,
    generatingDate: null,
    lastSuggestions: [],
  }
}

/**
 * Lenient normalisation for `settings.morningBrief` (load / restore only).
 * A user settings patch is validated strictly in `updateSettings` instead.
 *
 * `previous` is the optional fallback used when the incoming document has no
 * usable value for a field (for example a partial settings restore).
 */
export function normalizeMorningBrief(raw, stateDir = resolveDataDir(), previous = null) {
  const base = previous && typeof previous === 'object' ? previous : defaultMorningBrief(stateDir)
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const next = defaultMorningBrief(stateDir)
  next.enabled = source.enabled === undefined ? base.enabled !== false : source.enabled !== false
  if (typeof source.time === 'string' && REPORT_TIME_PATTERN.test(source.time.trim())) {
    next.time = source.time.trim()
  } else if (typeof base.time === 'string' && REPORT_TIME_PATTERN.test(base.time)) {
    next.time = base.time
  }
  next.dir = 'dir' in source ? resolveBriefDir(source.dir, stateDir) : resolveBriefDir(base.dir, stateDir)
  const lastDate = source.lastDate === undefined ? base.lastDate : source.lastDate
  next.lastDate = typeof lastDate === 'string' && REPORT_DATE_PATTERN.test(lastDate) ? lastDate : null
  const lastStatus = source.lastStatus === undefined ? base.lastStatus : source.lastStatus
  next.lastStatus = REPORT_STATUSES.includes(lastStatus) ? lastStatus : 'idle'
  const lastError = source.lastError === undefined ? base.lastError : source.lastError
  next.lastError = typeof lastError === 'string' && lastError !== '' ? lastError : null
  const lastGeneratedAt = source.lastGeneratedAt === undefined ? base.lastGeneratedAt : source.lastGeneratedAt
  next.lastGeneratedAt = Number.isFinite(lastGeneratedAt) ? lastGeneratedAt : null
  const generatingDate = source.generatingDate === undefined ? base.generatingDate : source.generatingDate
  next.generatingDate = typeof generatingDate === 'string' && REPORT_DATE_PATTERN.test(generatingDate)
    ? generatingDate
    : null
  const lastSuggestions = source.lastSuggestions === undefined ? base.lastSuggestions : source.lastSuggestions
  next.lastSuggestions = normalizeSuggestions(lastSuggestions)
  return next
}

/**
 * Lenient normalisation for `settings.evolution` (load / restore only).
 * A user settings patch is validated strictly in `updateSettings` instead.
 */
export function normalizeEvolutionSettings(raw, stateDir = resolveDataDir()) {
  const next = defaultEvolution(stateDir)
  if (!raw || typeof raw !== 'object') return next
  next.enabled = raw.enabled !== false
  if (EVOLUTION_INTERVALS.includes(raw.interval)) next.interval = raw.interval
  if (typeof raw.time === 'string' && REPORT_TIME_PATTERN.test(raw.time.trim())) next.time = raw.time.trim()
  if (Number.isInteger(raw.weekday) && raw.weekday >= 0 && raw.weekday <= 6) next.weekday = raw.weekday
  next.dir = resolveEvolutionDir(raw.dir, stateDir)
  if (EVOLUTION_SKILL_MODES.includes(raw.skillMode)) next.skillMode = raw.skillMode
  next.lastDate = typeof raw.lastDate === 'string' && REPORT_DATE_PATTERN.test(raw.lastDate)
    ? raw.lastDate
    : null
  next.lastStatus = REPORT_STATUSES.includes(raw.lastStatus) ? raw.lastStatus : 'idle'
  next.lastError = typeof raw.lastError === 'string' && raw.lastError !== '' ? raw.lastError : null
  next.lastGeneratedAt = Number.isFinite(raw.lastGeneratedAt) ? raw.lastGeneratedAt : null
  next.generatingDate = typeof raw.generatingDate === 'string' && REPORT_DATE_PATTERN.test(raw.generatingDate)
    ? raw.generatingDate
    : null
  next.lastCoveredSince = Number.isFinite(raw.lastCoveredSince) ? raw.lastCoveredSince : null
  return next
}

/** Lenient normalisation for the `state.evolution` data block (load/restore). */
export function normalizeEvolutionData(raw) {
  const data = { lessons: [], skills: [], lastRunAt: null }
  if (!raw || typeof raw !== 'object') return data
  if (Array.isArray(raw.lessons)) {
    data.lessons = raw.lessons.map(normalizeLesson).filter(Boolean)
    if (data.lessons.length > MAX_LESSONS) data.lessons = capLessons(data.lessons)
  }
  if (Array.isArray(raw.skills)) {
    data.skills = capSkills(raw.skills.map(normalizeSkill).filter(Boolean))
  }
  data.lastRunAt = Number.isFinite(raw.lastRunAt) ? raw.lastRunAt : null
  return data
}

/** `l_` + 12 hex, stable and collision-safe enough for a 40-item list. */
export function newLessonId() {
  return `l_${randomBytes(6).toString('hex')}`
}

/**
 * Shared lesson validation for add/update/load and retrospective merges.
 * Invalid entries return null so callers decide whether to drop or throw.
 */
export function normalizeLesson(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.text !== 'string') return null
  const text = raw.text.trim().slice(0, MAX_LESSON_TEXT)
  if (!text) return null
  const scope = raw.scope === 'project' ? 'project' : 'global'
  let project = null
  if (scope === 'project') {
    const value = normOptionalString(raw.project)
    if (!value) return null
    project = resolve(value)
  }
  const now = Date.now()
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id.slice(0, 40) : newLessonId(),
    text,
    category: LESSON_CATEGORIES.includes(raw.category) ? raw.category : 'other',
    scope,
    project,
    evidence: typeof raw.evidence === 'string' ? raw.evidence.trim().slice(0, MAX_LESSON_EVIDENCE) : '',
    source: raw.source === 'retrospective' ? 'retrospective' : 'manual',
    active: raw.active !== false,
    createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
  }
}

/** Shared skill validation for data load and retrospective merges. */
export function normalizeSkill(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name || name.length > MAX_SKILL_NAME || !SKILL_NAME_PATTERN.test(name)) return null
  const description = typeof raw.description === 'string'
    ? raw.description.trim().slice(0, MAX_SKILL_DESCRIPTION)
    : ''
  if (!description) return null
  const content = typeof raw.content === 'string' ? raw.content.trim().slice(0, MAX_SKILL_CONTENT) : ''
  if (!content) return null
  const scope = raw.scope === 'project' ? 'project' : 'global'
  let project = null
  if (scope === 'project') {
    const value = normOptionalString(raw.project)
    if (value) project = resolve(value)
  }
  const now = Date.now()
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now
  return {
    name,
    description,
    whenToUse: typeof raw.whenToUse === 'string'
      ? raw.whenToUse.trim().slice(0, MAX_SKILL_WHEN_TO_USE)
      : '',
    content,
    scope,
    project,
    status: SKILL_STATUSES.includes(raw.status) ? raw.status : 'proposed',
    source: raw.source === 'retrospective' ? 'retrospective' : 'manual',
    evidence: typeof raw.evidence === 'string' ? raw.evidence.trim().slice(0, MAX_LESSON_EVIDENCE) : '',
    createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
  }
}

/** Keep the most recently updated lessons, capped at MAX_LESSONS. */
function capLessons(list) {
  const entries = (Array.isArray(list) ? list : []).filter(Boolean)
  entries.sort((left, right) =>
    (Number.isFinite(right.updatedAt) ? right.updatedAt : 0) -
    (Number.isFinite(left.updatedAt) ? left.updatedAt : 0))
  return entries.slice(0, MAX_LESSONS)
}

/** Keep one entry per name (first wins), most recently updated first, capped. */
function capSkills(list) {
  const seen = new Set()
  const unique = []
  for (const skill of Array.isArray(list) ? list : []) {
    if (!skill || typeof skill.name !== 'string' || seen.has(skill.name)) continue
    seen.add(skill.name)
    unique.push(skill)
  }
  unique.sort((left, right) =>
    (Number.isFinite(right.updatedAt) ? right.updatedAt : 0) -
    (Number.isFinite(left.updatedAt) ? left.updatedAt : 0))
  return unique.slice(0, MAX_SKILLS)
}

function trimLedger(list, limit = MAX_SESSION_LEDGER) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const value = list[index]
    if (typeof value !== 'string' || value === '' || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= limit) break
  }
  return out.reverse()
}

export class TaskStore {
  constructor(options = {}) {
    let migratedFrom = null
    if (options.dir) {
      this.dir = options.dir
    } else {
      const layout = resolveDataLayout()
      this.dir = layout.primary
      migratedFrom = migrateStateDir(layout.primary, layout.legacy)
    }
    this.file = join(this.dir, 'state.json')
    this.state = {
      version: STATE_VERSION,
      rev: 0,
      settings: defaultSettings(this.dir),
      tasks: [],
      syncSince: null,
      ownedSessions: [],
      removedSessions: [],
      evolution: { lessons: [], skills: [], lastRunAt: null },
    }
    this.load()
    if (migratedFrom || this.reportDirRemapped || this.evolutionDirRemapped || this.briefDirRemapped) this.save()
  }

  load() {
    try {
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!raw || typeof raw !== 'object') return
      this.state.version = STATE_VERSION
      this.state.rev = Number.isFinite(raw.rev) ? raw.rev : 0
      this.state.settings = this.normalizeSettings(raw.settings)
      this.state.tasks = Array.isArray(raw.tasks) ? raw.tasks.filter(isTaskLike).map(normalizeTask) : []
      // An older document never had the "recent workspace sessions" import
      // window; treating it as a first run replays the last 24 hours once.
      const sameVersion = Number(raw.version) === STATE_VERSION
      this.state.syncSince = sameVersion && Number.isFinite(raw.syncSince) ? raw.syncSince : null
      this.state.ownedSessions = trimLedger(raw.ownedSessions)
      this.state.removedSessions = trimLedger(raw.removedSessions)
      this.state.evolution = normalizeEvolutionData(raw.evolution)
      const expectedReportDir = join(this.dir, 'reports')
      const loadedReportDir = this.state.settings.dailyReport.dir
      if (isDefaultSecretaryReportDir(loadedReportDir) &&
        resolve(loadedReportDir) !== resolve(expectedReportDir)) {
        this.state.settings = {
          ...this.state.settings,
          dailyReport: { ...this.state.settings.dailyReport, dir: expectedReportDir },
        }
        this.reportDirRemapped = true
      }
      const expectedEvolutionDir = join(this.dir, 'evolution')
      const loadedEvolutionDir = this.state.settings.evolution.dir
      if (isDefaultSecretaryEvolutionDir(loadedEvolutionDir) &&
        resolve(loadedEvolutionDir) !== resolve(expectedEvolutionDir)) {
        this.state.settings = {
          ...this.state.settings,
          evolution: { ...this.state.settings.evolution, dir: expectedEvolutionDir },
        }
        this.evolutionDirRemapped = true
      }
      const expectedBriefDir = join(this.dir, 'briefs')
      const loadedBriefDir = this.state.settings.morningBrief.dir
      if (isDefaultSecretaryBriefDir(loadedBriefDir) &&
        resolve(loadedBriefDir) !== resolve(expectedBriefDir)) {
        this.state.settings = {
          ...this.state.settings,
          morningBrief: { ...this.state.settings.morningBrief, dir: expectedBriefDir },
        }
        this.briefDirRemapped = true
      }
    } catch {
      // A corrupt file must not take the plugin down; start with an empty board.
      this.state.tasks = []
    }
  }

  normalizeSettings(raw) {
    const base = defaultSettings(this.dir)
    if (!raw || typeof raw !== 'object') return base
    return {
      concurrency: clampConcurrency(raw.concurrency),
      provider: normOptionalString(raw.provider) || '',
      model: normOptionalString(raw.model) || '',
      reasoningEffort: normOptionalString(raw.reasoningEffort),
      autoStart: raw.autoStart !== false,
      notifyOnDone: raw.notifyOnDone !== false,
      group: normalizeGroup(raw.group),
      dailyReport: normalizeDailyReport(raw.dailyReport, this.dir),
      morningBrief: normalizeMorningBrief(raw.morningBrief, this.dir),
      evolution: normalizeEvolutionSettings(raw.evolution, this.dir),
      webhook: normalizeWebhook(raw.webhook),
    }
  }

  save() {
    mkdirSync(this.dir, { recursive: true })
    this.backupCurrent()
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  get historyDir() {
    return join(this.dir, HISTORY_DIR)
  }

  /** Copy the current document aside before it is overwritten (best effort). */
  backupCurrent() {
    try {
      if (!existsSync(this.file)) return
      mkdirSync(this.historyDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      copyFileSync(this.file, join(this.historyDir, `state-${stamp}-r${this.state.rev}.json`))
      this.pruneHistory()
    } catch {
      // Backups must never break a normal save.
    }
  }

  pruneHistory() {
    try {
      const names = readdirSync(this.historyDir).filter(name => HISTORY_READ_PATTERN.test(name))
      if (names.length <= MAX_HISTORY_BACKUPS) return
      const entries = names.map(name => {
        const path = join(this.historyDir, name)
        let savedAt = 0
        try {
          savedAt = statSync(path).mtimeMs
        } catch {
          savedAt = 0
        }
        return { name, path, savedAt }
      })
      entries.sort((left, right) => right.savedAt - left.savedAt)
      for (const entry of entries.slice(MAX_HISTORY_BACKUPS)) {
        try {
          rmSync(entry.path, { force: true })
        } catch {
          // ignore an unremovable backup
        }
      }
    } catch {
      // best effort
    }
  }

  /** Newest-first recovery points shown in the settings dialog. */
  listBackups(limit = 20) {
    let names = []
    try {
      names = readdirSync(this.historyDir).filter(name => HISTORY_READ_PATTERN.test(name))
    } catch {
      return []
    }
    const entries = []
    for (const name of names) {
      const path = join(this.historyDir, name)
      try {
        const info = statSync(path)
        let taskCount = 0
        let rev = 0
        try {
          const raw = JSON.parse(readFileSync(path, 'utf8'))
          taskCount = Array.isArray(raw.tasks) ? raw.tasks.length : 0
          rev = Number.isFinite(raw.rev) ? raw.rev : 0
        } catch {
          // keep the entry; a broken backup is still listed for diagnostics
        }
        entries.push({ name, savedAt: info.mtimeMs, bytes: info.size, taskCount, rev })
      } catch {
        // skip unreadable entries
      }
    }
    entries.sort((left, right) => right.savedAt - left.savedAt)
    return entries.slice(0, Math.max(1, Math.min(100, limit)))
  }

  backupPath(name) {
    if (typeof name !== 'string' || !HISTORY_NAME_PATTERN.test(name)) return null
    const path = join(this.historyDir, name)
    if (!resolve(path).startsWith(`${resolve(this.historyDir)}${sep}`)) return null
    return existsSync(path) ? path : null
  }

  /**
   * Replace the live document with one recovery point. The current document is
   * itself backed up first, so a restore is undoable too.
   */
  restoreBackup(name) {
    const path = this.backupPath(name)
    if (!path) throw new HttpError(404, '备份不存在')
    let raw
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      throw new HttpError(400, '备份文件无法解析')
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tasks)) {
      throw new HttpError(400, '备份文件格式不正确')
    }
    this.state.settings = this.normalizeSettings(raw.settings)
    this.state.tasks = raw.tasks.filter(isTaskLike).map(normalizeTask)
    this.state.ownedSessions = trimLedger(raw.ownedSessions)
    this.state.removedSessions = trimLedger(raw.removedSessions)
    this.state.evolution = normalizeEvolutionData(raw.evolution)
    this.state.version = STATE_VERSION
    this.bump()
    this.save()
    return this.state.tasks
  }

  bump() {
    this.state.rev += 1
    return this.state.rev
  }

  get rev() {
    return this.state.rev
  }

  get settings() {
    return this.state.settings
  }

  get tasks() {
    return this.state.tasks
  }

  get syncSince() {
    return this.state.syncSince
  }

  get ownedSessions() {
    return this.state.ownedSessions
  }

  get removedSessions() {
    return this.state.removedSessions
  }

  /** Retrospective data block: `{ lessons, skills, lastRunAt }`. */
  get evolution() {
    return this.state.evolution
  }

  snapshot() {
    return {
      rev: this.state.rev,
      settings: this.state.settings,
      tasks: this.state.tasks,
      counts: this.counts(),
    }
  }

  counts() {
    const counts = { idea: 0, pending: 0, running: 0, paused: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 }
    for (const task of this.state.tasks) {
      if (counts[task.status] === undefined) counts[task.status] = 0
      counts[task.status] += 1
    }
    return counts
  }

  find(id) {
    return this.state.tasks.find(task => task.id === id)
  }

  findBySession(sessionId) {
    if (!sessionId) return undefined
    return this.state.tasks.find(task => task.sessionId === sessionId)
  }

  /** Default group for a new task: explicit value first, then the setting. */
  groupOf(input) {
    const explicit = input && typeof input.group === 'string' ? input.group.trim() : ''
    if (explicit) return explicit.slice(0, MAX_GROUP)
    return normalizeGroup(this.state.settings.group)
  }

  add(input) {
    const title = String(input.title || '').trim()
    const prompt = String(input.prompt || '').trim()
    const cwd = String(input.cwd || '').trim()
    if (!title) throw new HttpError(400, '请填写任务标题')
    if (!prompt) throw new HttpError(400, '请填写任务内容')
    if (!cwd) throw new HttpError(400, '请选择工作目录')
    const status = normalizeNewTaskStatus(input.status)
    const priority = normalizePriority(input.priority)
    const task = {
      id: randomUUID(),
      title: title.slice(0, MAX_TITLE),
      prompt: prompt.slice(0, MAX_PROMPT),
      cwd,
      group: this.groupOf(input),
      status,
      priority,
      source: 'queue',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    if (typeof input.chainFrom === 'string' && input.chainFrom !== '') task.chainFrom = input.chainFrom
    // v0.6: a task created directly into the queue is inserted by priority
    // instead of appended, so the array order stays the claim order.
    if (task.status === 'pending') {
      this.state.tasks.splice(pendingInsertIndex(this.state.tasks, task), 0, task)
    } else {
      this.state.tasks.push(task)
    }
    this.bump()
    this.save()
    return task
  }

  /**
   * Publish several tasks at once; `chain` links each task to the one before
   * it so the next task receives the previous task's result as input.
   */
  addBatch(input) {
    const cwd = String(input.cwd || '').trim()
    const items = Array.isArray(input.items) ? input.items : []
    const chain = input.chain === true
    if (!cwd) throw new HttpError(400, '请选择工作目录')
    if (items.length === 0) throw new HttpError(400, '请至少填写一个任务')
    if (items.length > MAX_BATCH) throw new HttpError(400, `一次最多发布 ${MAX_BATCH} 个任务`)
    const status = normalizeNewTaskStatus(input.status)
    const priority = normalizePriority(input.priority)
    const createdAt = Date.now()
    const created = []
    let previousId
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index] || {}
      const title = String(item.title || '').trim()
      const prompt = String(item.prompt || '').trim()
      if (!title) throw new HttpError(400, `第 ${index + 1} 个任务缺少标题`)
      if (!prompt) throw new HttpError(400, `第 ${index + 1} 个任务缺少内容`)
      const task = {
        id: randomUUID(),
        title: title.slice(0, MAX_TITLE),
        prompt: prompt.slice(0, MAX_PROMPT),
        cwd,
        group: this.groupOf(input),
        status,
        priority,
        source: 'queue',
        createdAt: createdAt + index,
        updatedAt: createdAt + index,
      }
      if (chain && previousId) task.chainFrom = previousId
      previousId = task.id
      if (task.status === 'pending') {
        this.state.tasks.splice(pendingInsertIndex(this.state.tasks, task), 0, task)
      } else {
        this.state.tasks.push(task)
      }
      created.push(task)
    }
    this.bump()
    this.save()
    return created
  }

  /** Record one task imported from the DSH workspace session list. */
  importSessionTask(input) {
    const sessionId = String(input.sessionId || '')
    if (!sessionId) throw new Error('导入会话缺少 sessionId')
    const title = String(input.title || '').trim() || 'DSH 会话'
    const task = {
      id: randomUUID(),
      title: title.slice(0, MAX_TITLE),
      prompt: title.slice(0, MAX_PROMPT),
      cwd: String(input.cwd || ''),
      group: this.groupOf(input),
      status: input.status === 'running' ? 'running' : 'done',
      priority: DEFAULT_PRIORITY,
      source: 'session',
      sessionId,
      createdAt: Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
      updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : Date.now(),
    }
    this.state.tasks.push(task)
    this.bump()
    this.save()
    return task
  }

  /**
   * idea -> pending: the user decided to start an idea. v0.6 inserts the task
   * by priority; dragging a card or using "run next" stays a later manual
   * override of that computed order.
   */
  promote(id) {
    const task = this.find(id)
    if (!task) throw new HttpError(404, '任务不存在')
    if (task.status !== 'idea') throw new HttpError(400, '只有待开始中的任务可以移入排队中')
    task.status = 'pending'
    task.updatedAt = Date.now()
    this.state.tasks = this.state.tasks.filter(item => item.id !== task.id)
    this.state.tasks.splice(pendingInsertIndex(this.state.tasks, task), 0, task)
    this.bump()
    this.save()
    return task
  }

  /** Re-insert one pending task by its priority (priority change / retry). */
  repositionPending(id) {
    const task = this.find(id)
    if (!task || task.status !== 'pending') return task
    this.state.tasks = this.state.tasks.filter(item => item.id !== task.id)
    this.state.tasks.splice(pendingInsertIndex(this.state.tasks, task), 0, task)
    task.updatedAt = Date.now()
    this.bump()
    this.save()
    return task
  }

  /** pending -> idea: back into the idea column, nothing is executed. */
  demote(id) {
    const task = this.find(id)
    if (!task) throw new HttpError(404, '任务不存在')
    if (task.status !== 'pending') throw new HttpError(400, '只有排队中的任务可以移回待开始')
    task.status = 'idea'
    task.updatedAt = Date.now()
    this.bump()
    this.save()
    return task
  }

  /** Sessions the secretary itself created must never be re-imported. */
  ownSession(sessionId) {
    if (!sessionId) return false
    if (this.state.ownedSessions.includes(sessionId)) return false
    this.state.ownedSessions.push(sessionId)
    this.state.ownedSessions = trimLedger(this.state.ownedSessions)
    this.bump()
    this.save()
    return true
  }

  isOwnedSession(sessionId) {
    return Boolean(sessionId) && this.state.ownedSessions.includes(sessionId)
  }

  /** A deleted imported row stays deleted instead of returning on the next sync. */
  hideSession(sessionId) {
    if (!sessionId) return false
    if (this.state.removedSessions.includes(sessionId)) return false
    this.state.removedSessions.push(sessionId)
    this.state.removedSessions = trimLedger(this.state.removedSessions)
    this.bump()
    this.save()
    return true
  }

  isHiddenSession(sessionId) {
    return Boolean(sessionId) && this.state.removedSessions.includes(sessionId)
  }

  setSyncSince(value) {
    const next = Number.isFinite(value) ? value : null
    if (this.state.syncSince === next) return next
    this.state.syncSince = next
    this.bump()
    this.save()
    return next
  }

  reorder(ids) {
    const wanted = Array.isArray(ids) ? ids.map(String) : null
    if (!wanted || wanted.length !== this.state.tasks.length) {
      throw new HttpError(400, '排序参数必须包含全部任务')
    }
    const byId = new Map(this.state.tasks.map(task => [task.id, task]))
    if (new Set(wanted).size !== wanted.length) throw new HttpError(400, '排序参数包含重复任务')
    const next = []
    for (const id of wanted) {
      const task = byId.get(id)
      if (!task) throw new HttpError(400, `排序参数包含未知任务: ${id}`)
      next.push(task)
    }
    this.state.tasks = next
    this.bump()
    this.save()
    return this.state.tasks
  }

  update(id, mutate) {
    const task = this.find(id)
    if (!task) return undefined
    mutate(task)
    this.bump()
    this.save()
    return task
  }

  remove(id) {
    const index = this.state.tasks.findIndex(task => task.id === id)
    if (index < 0) return undefined
    const [task] = this.state.tasks.splice(index, 1)
    this.bump()
    this.save()
    return task
  }

  moveToPendingFront(id) {
    const task = this.find(id)
    if (!task) throw new HttpError(404, '任务不存在')
    this.state.tasks = [task, ...this.state.tasks.filter(item => item.id !== id)]
    this.bump()
    this.save()
    return task
  }

  updateSettings(patch) {
    const next = {
      ...this.state.settings,
      dailyReport: { ...this.state.settings.dailyReport },
      morningBrief: { ...(this.state.settings.morningBrief || defaultMorningBrief(this.dir)) },
      evolution: { ...this.state.settings.evolution },
    }
    if (patch && typeof patch === 'object') {
      if ('concurrency' in patch) next.concurrency = clampConcurrency(patch.concurrency)
      if ('provider' in patch) next.provider = normOptionalString(patch.provider) || ''
      if ('model' in patch) next.model = normOptionalString(patch.model) || ''
      if ('reasoningEffort' in patch) next.reasoningEffort = normOptionalString(patch.reasoningEffort)
      if ('autoStart' in patch) next.autoStart = patch.autoStart !== false
      if ('notifyOnDone' in patch) next.notifyOnDone = patch.notifyOnDone !== false
      if ('group' in patch) next.group = normalizeGroup(patch.group)
      if ('webhook' in patch) {
        const incoming = patch.webhook
        if (incoming !== null && typeof incoming !== 'object') {
          throw new HttpError(400, '消息通知设置格式不正确')
        }
        const webhook = { ...next.webhook, events: { ...(next.webhook.events || {}) } }
        const source = incoming && typeof incoming === 'object' ? incoming : {}
        if ('enabled' in source) webhook.enabled = source.enabled === true
        if ('url' in source) {
          const nextUrl = normalizeWebhookUrl(source.url)
          if (nextUrl !== webhook.url) {
            webhook.lastStatus = 'idle'
            webhook.lastAt = null
            webhook.lastEvent = null
            webhook.lastError = null
          }
          webhook.url = nextUrl
        }
        if ('format' in source) {
          if (!WEBHOOK_FORMATS.includes(source.format)) throw new HttpError(400, '不支持的 Webhook 格式')
          if (source.format !== webhook.format) {
            webhook.lastStatus = 'idle'
            webhook.lastAt = null
            webhook.lastEvent = null
            webhook.lastError = null
          }
          webhook.format = source.format
        }
        if ('secretHeader' in source) {
          webhook.secretHeader = (normOptionalString(source.secretHeader) || 'Authorization').slice(0, 80)
        }
        if ('secret' in source) webhook.secret = typeof source.secret === 'string' ? source.secret.slice(0, 500) : ''
        if ('events' in source && source.events && typeof source.events === 'object') {
          for (const event of WEBHOOK_EVENTS) {
            if (event in source.events) webhook.events[event] = source.events[event] !== false
          }
        }
        if (webhook.enabled && webhook.url === '') throw new HttpError(400, '启用消息通知前请填写 Webhook 地址')
        // Delivery bookkeeping is written by the notifier itself.
        if (WEBHOOK_STATUSES.includes(source.lastStatus)) webhook.lastStatus = source.lastStatus
        if (Number.isFinite(source.lastAt)) webhook.lastAt = source.lastAt
        if (typeof source.lastEvent === 'string') webhook.lastEvent = source.lastEvent.slice(0, 40)
        if (typeof source.lastError === 'string') webhook.lastError = source.lastError.slice(0, 500)
        next.webhook = webhook
      }
      if ('dailyReport' in patch) {
        const daily = patch.dailyReport
        if (daily !== null && typeof daily !== 'object') {
          throw new HttpError(400, '日报设置格式不正确')
        }
        const incoming = daily && typeof daily === 'object' ? daily : {}
        if ('enabled' in incoming) next.dailyReport.enabled = incoming.enabled !== false
        if ('time' in incoming) {
          const time = String(incoming.time === null || incoming.time === undefined ? '' : incoming.time).trim()
          if (!REPORT_TIME_PATTERN.test(time)) throw new HttpError(400, '日报时间格式应为 HH:mm')
          next.dailyReport.time = time
        }
        if ('dir' in incoming) next.dailyReport.dir = resolveReportDir(incoming.dir, this.dir)
      }
      if ('morningBrief' in patch) {
        const brief = patch.morningBrief
        if (brief !== null && (typeof brief !== 'object' || Array.isArray(brief))) {
          throw new HttpError(400, '晨间简报设置格式不正确')
        }
        const incoming = brief && typeof brief === 'object' ? brief : {}
        // Only schedule preferences are user-writable; run state
        // (lastStatus/lastDate/generatingDate/...) has its own setter.
        if ('enabled' in incoming) next.morningBrief.enabled = incoming.enabled !== false
        if ('time' in incoming) {
          const time = String(incoming.time === null || incoming.time === undefined ? '' : incoming.time).trim()
          if (!REPORT_TIME_PATTERN.test(time)) {
            throw new HttpError(400, '晨间简报时间必须是 24 小时制 HH:mm')
          }
          next.morningBrief.time = time
        }
        if ('dir' in incoming) {
          const dir = incoming.dir
          if (dir !== null && dir !== undefined && (typeof dir !== 'string' || dir.trim() === '')) {
            throw new HttpError(400, '晨间简报目录不合法')
          }
          next.morningBrief.dir = resolveBriefDir(dir, this.dir)
        }
      }
      if ('evolution' in patch) {
        const evolution = patch.evolution
        if (evolution !== null && typeof evolution !== 'object') {
          throw new HttpError(400, '复盘设置格式不正确')
        }
        const incoming = evolution && typeof evolution === 'object' ? evolution : {}
        // Only schedule preferences are user-writable; run state
        // (lastStatus/lastDate/generatingDate/...) has its own setter.
        if ('enabled' in incoming) next.evolution.enabled = incoming.enabled !== false
        if ('interval' in incoming) {
          if (!EVOLUTION_INTERVALS.includes(incoming.interval)) {
            throw new HttpError(400, '复盘频率只能是 daily 或 weekly')
          }
          next.evolution.interval = incoming.interval
        }
        if ('time' in incoming) {
          const time = String(incoming.time === null || incoming.time === undefined ? '' : incoming.time).trim()
          if (!REPORT_TIME_PATTERN.test(time)) throw new HttpError(400, '复盘时间格式应为 HH:mm')
          next.evolution.time = time
        }
        if ('weekday' in incoming) {
          const weekday = Number(incoming.weekday)
          if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
            throw new HttpError(400, '复盘星期必须是 0-6')
          }
          next.evolution.weekday = weekday
        }
        if ('dir' in incoming) next.evolution.dir = resolveEvolutionDir(incoming.dir, this.dir)
        if ('skillMode' in incoming) {
          if (!EVOLUTION_SKILL_MODES.includes(incoming.skillMode)) {
            throw new HttpError(400, '技能沉淀模式只能是 off / ask / auto')
          }
          next.evolution.skillMode = incoming.skillMode
        }
      }
    }
    this.state.settings = next
    this.bump()
    this.save()
    return next
  }

  /** Reports bookkeeping: persists without touching the user-facing settings. */
  updateDailyReport(patch) {
    const next = { ...this.state.settings.dailyReport }
    if (patch && typeof patch === 'object') {
      if ('lastDate' in patch) {
        next.lastDate = typeof patch.lastDate === 'string' && REPORT_DATE_PATTERN.test(patch.lastDate)
          ? patch.lastDate
          : null
      }
      if ('lastStatus' in patch) {
        next.lastStatus = REPORT_STATUSES.includes(patch.lastStatus) ? patch.lastStatus : 'idle'
      }
      if ('lastError' in patch) {
        next.lastError = typeof patch.lastError === 'string' && patch.lastError !== '' ? patch.lastError : null
      }
      if ('lastGeneratedAt' in patch) {
        next.lastGeneratedAt = Number.isFinite(patch.lastGeneratedAt) ? patch.lastGeneratedAt : null
      }
      if ('generatingDate' in patch) {
        next.generatingDate = typeof patch.generatingDate === 'string' && REPORT_DATE_PATTERN.test(patch.generatingDate)
          ? patch.generatingDate
          : null
      }
    }
    this.state.settings = { ...this.state.settings, dailyReport: next }
    this.bump()
    this.save()
    return next
  }

  /** Morning-brief runtime bookkeeping (never user-facing settings). */
  updateMorningBrief(patch) {
    const next = { ...(this.state.settings.morningBrief || defaultMorningBrief(this.dir)) }
    if (patch && typeof patch === 'object') {
      if ('lastDate' in patch) {
        next.lastDate = typeof patch.lastDate === 'string' && REPORT_DATE_PATTERN.test(patch.lastDate)
          ? patch.lastDate
          : null
      }
      if ('lastStatus' in patch) {
        next.lastStatus = REPORT_STATUSES.includes(patch.lastStatus) ? patch.lastStatus : 'idle'
      }
      if ('lastError' in patch) {
        next.lastError = typeof patch.lastError === 'string' && patch.lastError !== '' ? patch.lastError : null
      }
      if ('lastGeneratedAt' in patch) {
        next.lastGeneratedAt = Number.isFinite(patch.lastGeneratedAt) ? patch.lastGeneratedAt : null
      }
      if ('generatingDate' in patch) {
        next.generatingDate = typeof patch.generatingDate === 'string' && REPORT_DATE_PATTERN.test(patch.generatingDate)
          ? patch.generatingDate
          : null
      }
      // v0.7: structured suggestions produced by the morning-brief model.
      if ('lastSuggestions' in patch) {
        next.lastSuggestions = normalizeSuggestions(patch.lastSuggestions)
      }
    }
    this.state.settings = { ...this.state.settings, morningBrief: next }
    this.bump()
    this.save()
    return next
  }

  /** Compact evolution state for the 1.5s `/state` poll (no full texts). */
  getEvolutionMeta() {
    const evolution = this.state.settings.evolution
    const data = this.state.evolution
    return {
      enabled: evolution.enabled === true,
      interval: evolution.interval,
      time: evolution.time,
      lastDate: evolution.lastDate,
      lastStatus: evolution.lastStatus,
      lastError: evolution.lastError,
      lastGeneratedAt: evolution.lastGeneratedAt,
      generatingDate: evolution.generatingDate,
      lessonCount: data.lessons.length,
      activeSkillCount: data.skills.filter(skill => skill.status === 'active').length,
      proposedSkillCount: data.skills.filter(skill => skill.status === 'proposed').length,
    }
  }

  /** Retrospective runtime bookkeeping (never user settings). */
  updateEvolutionStatus(patch) {
    const next = { ...this.state.settings.evolution }
    if (patch && typeof patch === 'object') {
      if ('lastDate' in patch) {
        next.lastDate = typeof patch.lastDate === 'string' && REPORT_DATE_PATTERN.test(patch.lastDate)
          ? patch.lastDate
          : null
      }
      if ('lastStatus' in patch) {
        next.lastStatus = REPORT_STATUSES.includes(patch.lastStatus) ? patch.lastStatus : 'idle'
      }
      if ('lastError' in patch) {
        next.lastError = typeof patch.lastError === 'string' && patch.lastError !== '' ? patch.lastError : null
      }
      if ('lastGeneratedAt' in patch) {
        next.lastGeneratedAt = Number.isFinite(patch.lastGeneratedAt) ? patch.lastGeneratedAt : null
      }
      if ('generatingDate' in patch) {
        next.generatingDate = typeof patch.generatingDate === 'string' && REPORT_DATE_PATTERN.test(patch.generatingDate)
          ? patch.generatingDate
          : null
      }
      if ('lastCoveredSince' in patch) {
        next.lastCoveredSince = Number.isFinite(patch.lastCoveredSince) ? patch.lastCoveredSince : null
      }
    }
    this.state.settings = { ...this.state.settings, evolution: next }
    this.bump()
    this.save()
    return next
  }

  /** Start instant of the last successful retrospective; drives the window. */
  setEvolutionLastRun(value) {
    const next = Number.isFinite(value) ? value : null
    if (this.state.evolution.lastRunAt === next) return next
    this.state.evolution = { ...this.state.evolution, lastRunAt: next }
    this.bump()
    this.save()
    return next
  }

  replaceLessons(list) {
    const lessons = capLessons((Array.isArray(list) ? list : []).map(normalizeLesson).filter(Boolean))
    this.state.evolution = { ...this.state.evolution, lessons }
    this.bump()
    this.save()
    return lessons
  }

  addLesson(input) {
    const raw = input && typeof input === 'object' ? input : {}
    const text = typeof raw.text === 'string' ? raw.text.trim() : ''
    if (!text) throw new HttpError(400, '经验内容不能为空')
    if (text.length > MAX_LESSON_TEXT) throw new HttpError(400, `经验内容不能超过 ${MAX_LESSON_TEXT} 字`)
    const scope = raw.scope === 'project' ? 'project' : 'global'
    let project = null
    if (scope === 'project') {
      const value = normOptionalString(raw.project)
      if (!value) throw new HttpError(400, '项目作用域需要填写项目目录')
      project = resolve(value)
    }
    const lesson = normalizeLesson({
      text,
      category: raw.category,
      scope,
      project,
      source: 'manual',
      active: true,
    })
    if (!lesson) throw new HttpError(400, '经验规则格式不正确')
    this.state.evolution = {
      ...this.state.evolution,
      lessons: capLessons([...this.state.evolution.lessons, lesson]),
    }
    this.bump()
    this.save()
    return lesson
  }

  updateLesson(id, patch) {
    const key = typeof id === 'string' ? id : String(id || '')
    const index = this.state.evolution.lessons.findIndex(lesson => lesson.id === key)
    if (index < 0) throw new HttpError(404, '经验规则不存在')
    const current = this.state.evolution.lessons[index]
    const source = patch && typeof patch === 'object' ? patch : {}
    const raw = { ...current }
    if ('text' in source) {
      const text = typeof source.text === 'string' ? source.text.trim() : ''
      if (!text) throw new HttpError(400, '经验内容不能为空')
      if (text.length > MAX_LESSON_TEXT) throw new HttpError(400, `经验内容不能超过 ${MAX_LESSON_TEXT} 字`)
      raw.text = text
    }
    if ('category' in source) raw.category = source.category
    if ('scope' in source) {
      const scope = source.scope === 'project' ? 'project' : 'global'
      raw.scope = scope
      if (scope === 'global') {
        raw.project = null
      } else {
        const project = normOptionalString(source.project) || normOptionalString(raw.project)
        if (!project) throw new HttpError(400, '项目作用域需要填写项目目录')
        raw.project = project
      }
    } else if ('project' in source && raw.scope === 'project') {
      const project = normOptionalString(source.project)
      if (!project) throw new HttpError(400, '项目作用域需要填写项目目录')
      raw.project = project
    }
    if ('active' in source) raw.active = source.active !== false
    const lesson = normalizeLesson(raw)
    if (!lesson) throw new HttpError(400, '经验规则格式不正确')
    lesson.updatedAt = Date.now()
    const lessons = [...this.state.evolution.lessons]
    lessons[index] = lesson
    this.state.evolution = { ...this.state.evolution, lessons: capLessons(lessons) }
    this.bump()
    this.save()
    return lesson
  }

  deleteLesson(id) {
    const key = typeof id === 'string' ? id : String(id || '')
    const index = this.state.evolution.lessons.findIndex(lesson => lesson.id === key)
    if (index < 0) return false
    this.state.evolution = {
      ...this.state.evolution,
      lessons: this.state.evolution.lessons.filter((_, position) => position !== index),
    }
    this.bump()
    this.save()
    return true
  }

  replaceSkills(list) {
    const skills = capSkills((Array.isArray(list) ? list : []).map(normalizeSkill).filter(Boolean))
    this.state.evolution = { ...this.state.evolution, skills }
    this.bump()
    this.save()
    return skills
  }

  setSkillStatus(name, status) {
    const key = typeof name === 'string' ? name.trim() : ''
    if (!key) throw new HttpError(400, '技能名称不合法')
    if (!SKILL_STATUSES.includes(status)) throw new HttpError(400, '技能状态不合法')
    const index = this.state.evolution.skills.findIndex(skill => skill.name === key)
    if (index < 0) throw new HttpError(404, '技能不存在')
    const skill = { ...this.state.evolution.skills[index], status, updatedAt: Date.now() }
    const skills = [...this.state.evolution.skills]
    skills[index] = skill
    this.state.evolution = { ...this.state.evolution, skills: capSkills(skills) }
    this.bump()
    this.save()
    return skill
  }

  deleteSkill(name) {
    const key = typeof name === 'string' ? name.trim() : ''
    const index = this.state.evolution.skills.findIndex(skill => skill.name === key)
    if (index < 0) return false
    this.state.evolution = {
      ...this.state.evolution,
      skills: this.state.evolution.skills.filter((_, position) => position !== index),
    }
    this.bump()
    this.save()
    return true
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function isTaskLike(value) {
  return value && typeof value === 'object' && typeof value.id === 'string' && typeof value.title === 'string'
}

function normalizeTask(raw) {
  const now = Date.now()
  const task = {
    id: String(raw.id),
    title: typeof raw.title === 'string' ? raw.title : '',
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    group: normalizeGroup(raw.group),
    status: TASK_STATUSES.includes(raw.status) ? raw.status : 'pending',
    priority: TASK_PRIORITIES.includes(raw.priority) ? raw.priority : DEFAULT_PRIORITY,
    source: raw.source === 'session' ? 'session' : 'queue',
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
  }
  if (Number.isFinite(raw.updatedAt)) task.updatedAt = raw.updatedAt
  for (const key of ['startedAt', 'endedAt', 'settleAfterSeq', 'resultBackfillAt']) {
    if (Number.isFinite(raw[key])) task[key] = raw[key]
  }
  for (const key of ['sessionId', 'provider', 'model', 'reasoningEffort', 'error', 'lastMessage', 'chainFrom']) {
    if (typeof raw[key] === 'string' && raw[key] !== '') task[key] = raw[key]
  }
  if (raw.result && typeof raw.result === 'object') {
    const result = {}
    if (typeof raw.result.finalAnswer === 'string') result.finalAnswer = raw.result.finalAnswer
    if (Number.isFinite(raw.result.turns)) result.turns = raw.result.turns
    if (Number.isFinite(raw.result.durationMs)) result.durationMs = raw.result.durationMs
    if (raw.result.usage && typeof raw.result.usage === 'object') {
      const usage = {}
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens']) {
        if (Number.isFinite(raw.result.usage[key])) usage[key] = raw.result.usage[key]
      }
      if (Object.keys(usage).length) result.usage = usage
    }
    if (Object.keys(result).length) task.result = result
  }
  return task
}

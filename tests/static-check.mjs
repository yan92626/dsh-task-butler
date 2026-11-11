#!/usr/bin/env node
/**
 * Static packaging checks for the dsh-personal-secretary bundle.
 *
 * Verifies the manifest, exported locales/icon, and the browser half's
 * constraints (single file, no local imports, no Harness client packages, only
 * theme tokens for colors). It does not prove rendering; see
 * tests/client-dom.mjs for the DOM mount test.
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
let checks = 0

function check(name, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures.push(`${name} ${detail}`.trim())
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const read = path => readFileSync(join(root, path), 'utf8')
const json = path => JSON.parse(read(path))

console.log('1. manifest')
const pkg = json('package.json')
check('package name', pkg.name === 'dsh-personal-secretary', pkg.name)
check('bundle patch declared', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
check('client platform web', pkg.dsh?.client?.platform === 'web')
check('client loads immediately', pkg.dsh?.client?.immediately === true)
check('client export', pkg.exports?.['./client'] === './client.js')
check('locale export pattern', Boolean(pkg.exports?.['./locale/*.json']))
check('icon export', pkg.exports?.['./icon'] === './icon.svg')
for (const entry of ['index.js', 'host', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'README.md']) {
  check(`files lists ${entry}`, (pkg.files || []).includes(entry))
}

console.log('2. patch')
const patch = read('cordis.patch.yml')
check('patch inserts personal-secretary row', /id:\s*personal-secretary\b/.test(patch) && /name:\s*'dsh-personal-secretary'/.test(patch), patch)
check('patch row id matches bundle id', !/task-queue/.test(patch), patch)

console.log('3. display resources')
for (const target of ['locale/zh.json', 'locale/en.json']) {
  const locale = json(target)
  check(`${target} has meta.title`, typeof locale.meta?.title === 'string' && locale.meta.title.length > 0)
  check(`${target} has meta.description`, typeof locale.meta?.description === 'string' && locale.meta.description.length > 0)
}
const icon = read('icon.svg')
const iconBytes = statSync(join(root, 'icon.svg')).size
check('icon is an svg element', /^<svg[\s>]/.test(icon.trim()), icon.slice(0, 40))
check('icon is under 256 KiB', iconBytes <= 256 * 1024, String(iconBytes))
check('icon declares viewBox', /viewBox="[^"]+"/.test(icon))

console.log('4. host half')
const hostFiles = ['index.js', 'host/store.js', 'host/session.js', 'host/scheduler.js', 'host/api.js', 'host/evolution.js', 'host/tool.js', 'host/webhook.js', 'host/briefs.js']
for (const file of hostFiles) {
  const source = read(file)
  check(`${file} parses as ESM (no require)`, !/\brequire\s*\(/.test(source))
}
const indexSource = read('index.js')
check('host exports apply', /export function apply\s*\(/.test(indexSource))
check('host injects webServer + sessionController',
  /inject\s*=\s*\[\s*'webServer'\s*,\s*'sessionController'\s*\]/.test(indexSource), indexSource.slice(0, 400))
check('api path prefix is secretary scoped', /\/secretary\/api/.test(read('host/api.js')))

console.log('5. browser half')
const client = read('client.js')
check('registers through ModuleLoader', /__ModuleLoader__\.load\s*\(/.test(client))
check('module id matches package', /id:\s*'dsh-personal-secretary'/.test(client))
check('no ReactDOM dependency', !/react-dom/.test(client))
check('no Harness client package import', !/dsh-client-ui-primitives/.test(client) && !/@deepseek-ai\/dsh-client/.test(client))
check('no document.body writes', !/document\.body/.test(client))
check('no local relative imports', !/\bimport\s+[^;]*from\s+['"]\.\.?\//.test(client))
check('registers sidebar.panellist', /sidebar\.panellist/.test(client))
check('sidebar id is secretary', client.includes("'secretary'"))
check('registers main panel', /name:\s*'main'/.test(client))
check('uses the same-origin API prefix', client.includes('/secretary/api'))
check('uses state endpoint', client.includes('/state'))
check('uses reorder endpoint', client.includes('/tasks/reorder'))
check('uses transcript endpoint', client.includes('/transcript'))
check('uses chat endpoint', client.includes('/chat'))
check('uses batch endpoint', client.includes('/tasks/batch'))
check('export report feature removed', !client.includes('/secretary/api/export') && !client.includes('导出报告'))
check('renders chained tasks', client.includes('chainFrom'))
check('supports completion notifications', client.includes('Notification') || client.includes('notifyOnDone'))
check('has a kanban column layout', client.includes('grid-template-columns') && client.includes('column'))
const colorLiterals = [...client.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g)].map(m => m[0].toLowerCase())
// v7: a documented decorative palette is allowed (pastel washes, icon tiles,
// chips, the violet CTA gradient); every other literal color stays forbidden.
const ALLOWED_LITERAL_COLORS = new Set([
  '#8b5cf6', '#7c3aed', '#a78bfa', '#6366f1',
  '#3b82f6', '#60a5fa',
  '#10b981', '#34d399',
  '#f59e0b', '#fbbf24',
  '#f43f5e', '#fb7185',
  '#fff', '#ffffff',
])
const forbiddenColors = colorLiterals.filter(color => !ALLOWED_LITERAL_COLORS.has(color))
check('only the documented decorative palette uses literal colors', forbiddenColors.length === 0, forbiddenColors.slice(0, 8).join(','))
check('literal colors stay rare (decorative only)', colorLiterals.length < 260, String(colorLiterals.length))
const tokens = new Set([...client.matchAll(/--dsw-[a-z0-9-]+/g)].map(m => m[0]))
const allowed = new Set([
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary', '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
])
check('theme tokens are all documented aliases', [...tokens].every(token => allowed.has(token)), [...tokens].filter(t => !allowed.has(t)).join(','))
check('has an error boundary', /componentDidCatch|ErrorBoundary/.test(client))
check('has search input', client.includes('搜索'))
check('has per-column search', client.includes('搜索本列'))
check('daily report time is 24-hour', client.includes('24 小时制') || client.includes('24小时制'))
// AM/PM is style-dependent; the 24-hour hint check above covers the input format.
check('supports status filter', client.includes('blocked') && client.includes('paused'))
check('supports task editing', client.includes('/tasks/update'))
check('supports pause/resume/interrupt actions', client.includes("'pause'") && client.includes("'resume'") && client.includes("'interrupt'"))
check('has daily report UI', client.includes('/reports') && client.includes('日报'))
check('has webhook notification UI', /webhook/i.test(client) && client.includes('测试通知'))
check('uses the webhook test endpoint', client.includes('/webhook/test'))
check('has the idea status column', client.includes("'idea'") && client.includes('想法'))
check('supports priority enums', ['urgent', 'high', 'normal', 'low'].every(level => client.includes(`'${level}'`)))
check('supports promote/demote actions', client.includes("'promote'") && client.includes("'demote'"))
check('settings is a dialog', client.includes('SettingsDialog') || client.includes('settings-dialog'))
check('cards show absolute time in a tooltip', client.includes('toISOString') || client.includes('fullTime') || client.includes('formatFullTime'))
check('group surfaces removed from the client', !client.includes('秘书台'))
check('has card hover motion', client.includes('translateY') && client.includes('prefers-reduced-motion'))
check('colors cards per status', client.includes('data-status=') || client.includes('data-status"'))
check('has drag handlers', /onDragStart|dragstart|draggable/.test(client))
check('calls pickDirectory', client.includes('pickDirectory'))
check('opens the session conversation', client.includes('openSession') && client.includes("selectPanel('conversation')"))


console.log('6. v9 self-evolution / retrospectives')
const evolutionSource = read('host/evolution.js')
check('evolution host module exists', evolutionSource.length > 2000)
check('evolution host module is ESM (no require)', !/\brequire\s*\(/.test(evolutionSource))
const evolutionExports = [
  'isRetrospectiveDue', 'periodWindow', 'selectLessonsForTask', 'buildLessonsPromptBlock',
  'buildTaskPromptWithLessons', 'buildRetrospectivePrompt', 'extractEvolutionSections',
  'extractRetrospectiveBody', 'mergeSuggestedLessons', 'mergeSuggestedSkills',
  'selectApplicableSkills', 'buildSkillDefinition', 'buildRetrospectiveFallback',
  'listRetrospectiveFiles', 'readRetrospectiveFile', 'collectRetrospectiveData', 'createEvolution',
]
for (const name of evolutionExports) {
  check(`evolution exports ${name}`, new RegExp(`export (async )?function ${name}\\b`).test(evolutionSource))
}
check('evolution provider name is namespaced', evolutionSource.includes("'secretary-evolution'"))
check('evolution provider uses the DSH skill rank', /EVOLUTION_SKILL_RANK = 250/.test(evolutionSource))
const storeSource = read('host/store.js')
check('store persists evolution data', storeSource.includes('getEvolutionMeta') &&
  storeSource.includes('replaceLessons') && storeSource.includes('replaceSkills'))
check('store caps lessons and skills', /MAX_LESSONS = 40/.test(storeSource) && /MAX_SKILLS = 20/.test(storeSource))
check('store webhook events include retrospective', storeSource.includes("'retrospective'"))
check('index wires the evolution engine', indexSource.includes('createEvolution') &&
  indexSource.includes('registerSkillProvider'))
const schedulerSource = read('host/scheduler.js')
check('scheduler never injects lessons into task prompts',
  !schedulerSource.includes('buildTaskPromptWithLessons') && !schedulerSource.includes('selectLessonsForTask'))
const apiSource = read('host/api.js')
for (const route of ["'/evolution'", "'/evolution/content'", "'/evolution/skills/content'",
  "'/evolution/generate'", "'/evolution/lessons'", "'/evolution/lessons/update'",
  "'/evolution/lessons/delete'", "'/evolution/skills/action'"]) {
  check(`api route ${route}`, apiSource.includes(route))
}
check('api version is 0.6.0', /VERSION = '0\.6\.0'/.test(apiSource))
check('state carries the evolution meta', apiSource.includes('getEvolutionMeta()'))
check('state carries the briefs meta', /briefs\s*:\s*[^\n]{0,80}meta\s*\(\s*\)/.test(apiSource))
const toolSource = read('host/tool.js')
check('agent tool supports retrospective and evolution', toolSource.includes("'retrospective'") &&
  toolSource.includes("'evolution'"))
check('webhook has a retrospective template', read('host/webhook.js').includes('retrospectiveMarkdown'))
check('package version is 0.6.0', pkg.version === '0.6.0', pkg.version)
check('client has the retrospective entry', client.includes('evolutionButton') && client.includes('/evolution'))
check('client has the self-evolution settings section', client.includes('evolutionSection') &&
  client.includes('skillMode'))
check('client lists the retrospective webhook event', client.includes("'retrospective'") &&
  client.includes('webhookEventRetrospective'))
check('client calls every evolution endpoint',
  ['/evolution/generate', '/evolution/lessons', '/evolution/lessons/update', '/evolution/lessons/delete',
    '/evolution/skills/action', '/evolution/content', '/evolution/skills/content'].every(route => client.includes(route)))
check('client covers all three drawer tabs', client.includes('tabRetro') && client.includes('tabLessons') &&
  client.includes('tabSkills'))

console.log('7. v0.6 morning brief + today workbench')
const briefsSource = read('host/briefs.js')
check('briefs host module is ESM (no require)', !/\brequire\s*\(/.test(briefsSource))
const briefsExports = [
  'isBriefDue', 'buildMorningBriefPrompt', 'buildMorningBriefFallback', 'collectMorningBriefData',
  'extractBriefBody', 'normalizeMorningBriefText', 'listBriefFiles', 'readBriefFile', 'createBriefs',
]
for (const name of briefsExports) {
  check(`briefs exports ${name}`, new RegExp(`export (async )?function ${name}\\b`).test(briefsSource))
}
check('briefs exposes the engine constants', /BRIEF_TICK_MS = 30_000/.test(briefsSource) &&
  /BRIEF_POLL_MS = 1_000/.test(briefsSource) &&
  /BRIEF_MAX_WAIT_MS = 10 \* 60 \* 1000/.test(briefsSource) &&
  /BRIEF_DATE_PATTERN/.test(briefsSource))
check('briefs uses the fixed four sections', ['昨日回顾', '今日焦点', '等你处理', '风险与提醒']
  .every(heading => briefsSource.includes(heading)))

check('store exports pendingInsertIndex', /export function pendingInsertIndex\b/.test(storeSource))
check('store has repositionPending', /repositionPending\s*\(/.test(storeSource))
check('store has defaultMorningBrief', /export function defaultMorningBrief\b/.test(storeSource))
check('store has updateMorningBrief', /updateMorningBrief\s*\(/.test(storeSource))
check('store webhook events include morningBrief', storeSource.includes("'morningBrief'"))
check('scheduler exports pendingInClaimOrder', /export function pendingInClaimOrder\b/.test(schedulerSource))
check('scheduler backfills session results', /backfillSessionResult|selectSessionResultBackfill|resultBackfillAt/.test(schedulerSource))
check('tool describes priority as queue ordering', toolSource.includes('优先级参与入队排序') &&
  !toolSource.includes('优先级只影响展示与筛选'))
check('index wires the briefs engine', indexSource.includes('createBriefs') &&
  /briefs\.start\s*\(/.test(indexSource) && /briefs\.stop\s*\(/.test(indexSource))
check('api kicks the briefs engine after settings updates', /if\s*\(\s*briefs\b[^\n]*\)\s*briefs\.kick\s*\(/.test(apiSource))
check('api exposes brief operations', apiSource.includes('listBriefs') &&
  apiSource.includes('briefContent') && apiSource.includes('generateBrief'))
for (const route of ["'/briefs'", "'/briefs/content'", "'/briefs/generate'"]) {
  check(`api route ${route}`, apiSource.includes(route))
}
check('webhook has a morning brief template', read('host/webhook.js').includes('morningBriefMarkdown'))

check('client uses the briefs endpoints', client.includes('/briefs') && client.includes('/briefs/generate') &&
  client.includes('/webhook/log'))
for (const text of ['今日焦点', '待你处理', '晨间简报', '交代一件事', '通知记录']) {
  check(`client has the v0.6 copy ${text}`, client.includes(text))
}
for (const text of ['下一个执行', '停止本轮', '自动执行']) {
  check(`client renames the action copy ${text}`, client.includes(text))
}
for (const text of ['想法', '队列', '进行中', '已结束']) {
  check(`client has the v0.6 column copy ${text}`, client.includes(text))
}
check('client has the today view shell', client.includes("'today'") && client.includes('查看晨报'))
check('client degrades when the Host has no briefs', client.includes('当前 Host 版本不支持晨间简报'))

// The browser half keeps its zh/en dictionaries inline: every key must exist in
// both languages (§4.6) and the v0.6 copy must be present in English too.
function dictionaryKeys(source, startMarker) {
  const start = source.indexOf(startMarker)
  if (start < 0) return []
  const end = source.indexOf('\n    }', start)
  const block = source.slice(start, end >= 0 ? end : source.length)
  return [...block.matchAll(/\n\s{6}([A-Za-z0-9_]+):/g)].map(match => match[1])
}
const zhKeys = dictionaryKeys(client, 'const zh = {')
const enKeys = dictionaryKeys(client, 'const en = {')
check('client zh/en dictionaries are key-paired',
  zhKeys.length > 300 && zhKeys.length === enKeys.length && zhKeys.every(key => enKeys.includes(key)),
  `zh=${zhKeys.length} en=${enKeys.length}`)
check('v0.6 copy is translated to English',
  ['Morning brief', 'Needs you', 'View brief', 'Generate now', 'No brief yet today',
    'Delivery log', 'Run next', 'Stop this run', 'Auto-run', 'Add to queue'].every(text => client.includes(text)))
check('old naming is fully replaced in the client',
  !['待开始', '发布任务', '置顶', '打断', '自动领取', '已归档'].some(text => client.includes(text)))

console.log()
if (failures.length) {
  console.log(`${failures.length}/${checks} checks failed:`)
  for (const failure of failures) console.log(' -', failure)
  process.exit(1)
}
console.log(`all ${checks} static checks passed`)

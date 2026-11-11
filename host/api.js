/**
 * Same-origin JSON API consumed by the plugin's browser half.
 *
 * One prefix route keeps the whole surface in this module. Every mutating call
 * persists first and then kicks the scheduler, so the browser never has to
 * reason about ordering: a 200 response describes the board as already saved.
 */
import { HttpError, PRIORITY_LABELS, normalizePriority } from './store.js'

const PREFIX = '/secretary/api'
const VERSION = '0.7.0'
const MAX_BODY_BYTES = 1_000_000
const VALID_ACTIONS = new Set([
  'cancel',
  'retry',
  'delete',
  'run-next',
  'run',
  'pause',
  'resume',
  'interrupt',
  'promote',
  'demote',
])
const ACTIVE_STATUSES = new Set(['pending', 'running', 'paused', 'blocked'])
const FINISHED_STATUSES = new Set(['done', 'failed', 'cancelled'])
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

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * The page is the only legitimate browser caller: a same-origin fetch carries
 * an Origin header (or none at all for a same-origin GET), while a cross-site
 * caller cannot match the Host header.
 */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function isLoopbackHost(hostHeader) {
  const host = String(hostHeader || '').toLowerCase()
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

/**
 * Apply the Host's own Connection gate to this route.
 *
 * Plugin routes register on the bare web server, so they never pass through the
 * `/api` fence that authenticates the browser (which holds the host's session
 * cookie). A loopback-only deployment keeps its existing trust model — local
 * same-origin callers — but once the deployment is reachable through a tunnel,
 * proxy, or declared authority, this route must ask the same gate the host's
 * own API uses, so an unauthenticated remote caller can no longer queue work
 * that runs an Agent.
 *
 * @returns undefined when admitted, or the HTTP status to reject with.
 */
function connectionRejection(ctx, req) {
  if (isLoopbackHost(req.headers.host)) return undefined
  let connection = null
  try {
    connection = typeof ctx.get === 'function' ? ctx.get('connection') : null
  } catch {
    connection = null
  }
  if (!connection || typeof connection.requestRejection !== 'function') {
    // A deployment that cannot answer the gate is not a loopback-only caller:
    // fail closed rather than exposing the board to whoever reached the port.
    return 403
  }
  try {
    const status = connection.requestRejection({ headers: req.headers })
    return status === 401 || status === 403 ? status : undefined
  } catch {
    return 403
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try {
        const value = JSON.parse(text)
        resolve(value && typeof value === 'object' ? value : {})
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'))
      }
    })
    req.on('error', error => reject(error))
  })
}

function requireString(value, field, maxLength) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new HttpError(400, `缺少参数：${field}`)
  if (maxLength && text.length > maxLength) throw new HttpError(400, `参数过长：${field}`)
  return text
}

export function createApi({ ctx, store, bridge, scheduler, reports, briefs, webhook, evolution }) {
  function reportModule() {
    if (!reports) throw new HttpError(500, '日报模块不可用')
    return reports
  }

  function briefModule() {
    if (!briefs) throw new HttpError(500, '晨间简报模块不可用')
    return briefs
  }

  function evolutionModule() {
    if (!evolution) throw new HttpError(500, '复盘模块不可用')
    return evolution
  }

  /** Skill wire shape for lists: the full content is fetched on demand. */
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

  async function state() {
    const snapshot = store.snapshot()
    return {
      ok: true,
      rev: snapshot.rev,
      settings: snapshot.settings,
      tasks: snapshot.tasks.map(wireTask),
      counts: snapshot.counts,
      runningCount: snapshot.counts.running,
      reports: reportModule().meta(),
      // v0.6: omitted only on a Host that was not assembled with the briefs
      // engine (the browser half degrades gracefully in that case).
      briefs: briefs && typeof briefs.meta === 'function' ? briefs.meta() : null,
      evolution: store.getEvolutionMeta(),
    }
  }

  /**
   * Trim a task for the polling payload: results stay previewable while the
   * full answer remains available through the task transcript.
   */
  function wireTask(task) {
    if (!task.result) return task
    const answer = typeof task.result.finalAnswer === 'string' ? task.result.finalAnswer : ''
    return {
      ...task,
      result: {
        ...task.result,
        finalAnswer: answer.length > 4000 ? `${answer.slice(0, 4000)}…` : answer,
      },
    }
  }

  function formatTime(value) {
    if (!Number.isFinite(value)) return '—'
    try {
      return new Date(value).toLocaleString('zh-CN', { hour12: false })
    } catch {
      return new Date(value).toISOString()
    }
  }

  function formatDuration(value) {
    if (!Number.isFinite(value) || value < 0) return '—'
    const seconds = Math.round(value / 1000)
    if (seconds < 60) return `${seconds} 秒`
    const minutes = Math.floor(seconds / 60)
    const rest = seconds % 60
    return `${minutes} 分 ${rest} 秒`
  }

  function resolveChainFrom(value, selfId) {
    if (value === undefined || value === null || value === '') return undefined
    const id = String(value).trim()
    if (!id) return undefined
    if (selfId && id === selfId) throw new HttpError(400, '不能承接自己')
    if (!store.find(id)) throw new HttpError(400, '承接的任务不存在')
    return id
  }

  function taskPayload(id) {
    const found = id ? store.find(id) : undefined
    return found ? wireTask(found) : undefined
  }

  async function createTask(body) {
    const task = store.add({
      title: requireString(body.title, 'title', 120),
      prompt: requireString(body.prompt, 'prompt', 200_000),
      cwd: requireString(body.cwd, 'cwd', 4096),
      group: typeof body.group === 'string' ? body.group : undefined,
      chainFrom: resolveChainFrom(body.chainFrom),
      // Both are validated by the store: idea | pending, and the priority enum.
      status: body.status,
      priority: body.priority,
    })
    scheduler.kick()
    return { ok: true, rev: store.rev, task: wireTask(task), tasks: store.tasks.map(wireTask) }
  }

  async function createBatch(body) {
    const created = store.addBatch({
      cwd: requireString(body.cwd, 'cwd', 4096),
      group: typeof body.group === 'string' ? body.group : undefined,
      chain: body.chain === true,
      items: Array.isArray(body.items) ? body.items : [],
      status: body.status,
      priority: body.priority,
    })
    scheduler.kick()
    return {
      ok: true,
      rev: store.rev,
      tasks: store.tasks.map(wireTask),
      created: created.map(task => task.id),
    }
  }

  async function reorder(body) {
    const tasks = store.reorder(body.ids)
    scheduler.kick()
    return { ok: true, rev: store.rev, tasks: tasks.map(wireTask) }
  }

  async function updateTask(body) {
    const id = requireString(body.id, 'id')
    const task = store.find(id)
    if (!task) throw new HttpError(404, '任务不存在')
    if (task.source === 'session') throw new HttpError(400, 'DSH 工作区会话任务不可编辑')
    if (task.status === 'running') throw new HttpError(400, '执行中的任务不能编辑，请先暂停')
    const patch = {}
    if ('title' in body) patch.title = requireString(body.title, 'title', 120)
    if ('prompt' in body) patch.prompt = requireString(body.prompt, 'prompt', 200_000)
    if ('cwd' in body) patch.cwd = requireString(body.cwd, 'cwd', 4096)
    if ('group' in body) patch.group = typeof body.group === 'string' ? body.group.trim() : ''
    if ('chainFrom' in body) patch.chainFrom = resolveChainFrom(body.chainFrom, id)
    // Priority is validated here; v0.6 re-inserts a pending task by priority
    // after the update instead of keeping its old array position.
    if ('priority' in body) patch.priority = normalizePriority(body.priority)
    store.update(id, current => {
      if (patch.title !== undefined) current.title = patch.title
      if (patch.prompt !== undefined) current.prompt = patch.prompt
      if (patch.cwd !== undefined) current.cwd = patch.cwd
      if (patch.group !== undefined) {
        current.group = patch.group ? patch.group.slice(0, 60) : (store.settings.group || '秘书台')
      }
      if ('chainFrom' in patch) {
        if (patch.chainFrom) current.chainFrom = patch.chainFrom
        else delete current.chainFrom
      }
      if (patch.priority !== undefined) current.priority = patch.priority
      current.updatedAt = Date.now()
    })
    if ('priority' in body && task.status === 'pending' &&
      typeof store.repositionPending === 'function') {
      store.repositionPending(id)
    }
    scheduler.kick()
    return { ok: true, rev: store.rev, task: taskPayload(id), tasks: store.tasks.map(wireTask) }
  }

  async function action(body) {
    const id = requireString(body.id, 'id')
    const name = requireString(body.action, 'action')
    if (!VALID_ACTIONS.has(name)) throw new HttpError(400, `未知操作：${name}`)
    const task = store.find(id)
    if (!task) throw new HttpError(404, '任务不存在')
    if (task.source === 'session' && name !== 'delete') {
      throw new HttpError(400, 'DSH 工作区会话任务只支持删除')
    }
    const now = Date.now()

    if (name === 'cancel') {
      if (!ACTIVE_STATUSES.has(task.status)) throw new HttpError(400, '只有未完成的任务可以取消')
      store.update(task.id, current => {
        current.status = 'cancelled'
        current.endedAt = now
        current.updatedAt = now
      })
      if (task.sessionId) await bridge.cancel(task.sessionId)
    } else if (name === 'retry') {
      if (!FINISHED_STATUSES.has(task.status)) throw new HttpError(400, '只有已归档的任务可以重试')
      store.update(task.id, current => {
        current.status = 'pending'
        delete current.startedAt
        delete current.endedAt
        delete current.sessionId
        delete current.error
        delete current.lastMessage
        delete current.result
        delete current.settleAfterSeq
        current.updatedAt = now
      })
      // v0.6: a retried task re-enters the queue in priority order.
      if (typeof store.repositionPending === 'function') store.repositionPending(task.id)
    } else if (name === 'delete') {
      if (task.status === 'running' || task.status === 'paused' || task.status === 'blocked') {
        await bridge.cancel(task.sessionId)
      }
      // A deleted workspace row must not come back on the next import tick.
      if (task.source === 'session' && task.sessionId) store.hideSession(task.sessionId)
      store.remove(task.id)
    } else if (name === 'run-next') {
      store.moveToPendingFront(task.id)
    } else if (name === 'promote') {
      store.promote(task.id)
    } else if (name === 'demote') {
      store.demote(task.id)
    } else if (name === 'run') {
      if (task.status !== 'pending' && task.status !== 'idea') {
        throw new HttpError(400, '只有排队中或待开始中的任务可以执行')
      }
      // Validate the chained predecessor before promoting, so a rejected run
      // leaves an idea task exactly where the user put it.
      if (task.chainFrom) {
        const previous = store.find(task.chainFrom)
        if (!previous) throw new HttpError(400, '前置任务不存在')
        if (previous.status !== 'done') throw new HttpError(400, '前置任务尚未完成')
      }
      // Manual run is the user's "start now": promote first, then claim it.
      if (task.status === 'idea') store.promote(task.id)
      await scheduler.runTask(store.find(task.id))
    } else if (name === 'pause') {
      if (task.status !== 'running' && task.status !== 'blocked') {
        throw new HttpError(400, '只有执行中或阻塞的任务可以暂停')
      }
      // Persist the paused state before cancelling: the aborting turn must not
      // settle the task from the turn/end event that the cancel produces.
      store.update(task.id, current => {
        current.status = 'paused'
        current.updatedAt = now
      })
      if (task.sessionId) await bridge.cancel(task.sessionId)
    } else if (name === 'resume') {
      if (task.status !== 'paused') throw new HttpError(400, '只有已暂停的任务可以继续')
      if (!task.sessionId) throw new HttpError(400, '任务没有可继续的会话')
      await scheduler.resumeTask(task)
    } else if (name === 'interrupt') {
      if (task.status !== 'running' && task.status !== 'blocked' && task.status !== 'paused') {
        throw new HttpError(400, '只有进行中的任务可以打断')
      }
      store.update(task.id, current => {
        current.status = 'cancelled'
        current.endedAt = now
        current.updatedAt = now
      })
      if (task.sessionId) await bridge.cancel(task.sessionId)
    }
    scheduler.kick()
    return {
      ok: true,
      rev: store.rev,
      tasks: store.tasks.map(wireTask),
      task: taskPayload(id),
    }
  }

  async function settings(body) {
    if (body && body.dailyReport !== undefined && body.dailyReport !== null &&
      (typeof body.dailyReport !== 'object' || Array.isArray(body.dailyReport))) {
      throw new HttpError(400, '日报设置格式不正确')
    }
    if (body && body.morningBrief !== undefined && body.morningBrief !== null &&
      (typeof body.morningBrief !== 'object' || Array.isArray(body.morningBrief))) {
      throw new HttpError(400, '晨间简报设置格式不正确')
    }
    if (body && body.evolution !== undefined && body.evolution !== null &&
      (typeof body.evolution !== 'object' || Array.isArray(body.evolution))) {
      throw new HttpError(400, '复盘设置格式不正确')
    }
    const updated = store.updateSettings(body || {})
    scheduler.kick()
    if (reports) reports.kick()
    if (briefs && typeof briefs.kick === 'function') briefs.kick()
    if (evolution && typeof evolution.kick === 'function') evolution.kick()
    return { ok: true, rev: store.rev, settings: updated }
  }

  async function listBackups() {
    const backups = typeof store.listBackups === 'function' ? store.listBackups(20) : []
    return {
      ok: true,
      backups,
      latest: backups.length > 0 ? backups[0] : null,
    }
  }

  async function restoreBackup(body) {
    const name = requireString(body.name, 'name')
    if (typeof store.restoreBackup !== 'function') throw new HttpError(400, '当前版本不支持恢复备份')
    const tasks = store.restoreBackup(name)
    scheduler.kick()
    return { ok: true, rev: store.rev, tasks: tasks.map(wireTask) }
  }

  async function webhookLog() {
    const log = webhook && typeof webhook.deliveryLog === 'function' ? webhook.deliveryLog() : []
    return { ok: true, log }
  }

  async function testWebhook() {
    if (!webhook || typeof webhook.sendTest !== 'function') {
      throw new HttpError(400, '当前版本不支持 Webhook 通知')
    }
    const outcome = await webhook.sendTest()
    if (!outcome || outcome.ok !== true) {
      const message = (outcome && outcome.error) || '发送失败'
      throw new HttpError(/请先填写/.test(message) ? 400 : 502, message)
    }
    return { ok: true, sentAt: Date.now() }
  }

  async function models() {
    try {
      const catalog = await bridge.catalog()
      return { ok: true, catalog }
    } catch (error) {
      return { ok: false, error: error?.message || '读取模型目录失败' }
    }
  }

  async function transcript(url) {
    const sessionId = url.searchParams.get('sessionId')
    if (!sessionId) throw new HttpError(400, '缺少参数：sessionId')
    const task = store.findBySession(sessionId)
    const result = await bridge.transcript(sessionId)
    return {
      ok: true,
      sessionId,
      running: Boolean(task && task.status === 'running'),
      taskId: task?.id,
      title: task?.title,
      status: task?.status,
      messages: result.messages,
      lastTurnEnd: result.lastTurnEnd ?? null,
    }
  }

  async function chat(body) {
    const sessionId = requireString(body.sessionId, 'sessionId')
    const text = requireString(body.text, 'text', 20_000)
    const task = store.findBySession(sessionId)
    if (task && task.source === 'queue' && typeof scheduler.chatIntoTask === 'function') {
      // Chatting with a finished/paused task re-opens it: the next turn either
      // resumes the existing Session (status running) or falls back to the
      // claim queue when the Session is gone (status pending).
      const status = await scheduler.chatIntoTask(task, text)
      return { ok: true, status, revived: status === 'running' || status === 'pending' ? status : undefined }
    }
    await bridge.prompt(sessionId, text)
    return { ok: true }
  }

  async function cancelSession(body) {
    const sessionId = requireString(body.sessionId, 'sessionId')
    await bridge.cancel(sessionId)
    return { ok: true }
  }

  function listReports() {
    const meta = reportModule().meta()
    return { ok: true, reports: meta.reports, settings: meta.settings }
  }

  function reportContent(url) {
    const date = requireString(url.searchParams.get('date'), 'date')
    const content = reportModule().read(date)
    if (content === undefined) throw new HttpError(404, '日报不存在')
    return { ok: true, date, content }
  }

  function generateReport(body) {
    const date = body && body.date !== undefined && body.date !== null && body.date !== ''
      ? String(body.date).trim()
      : undefined
    const result = reportModule().generate(date)
    return { ok: true, date: result.date }
  }

  // --- morning briefs (v0.6) -----------------------------------------------

  function listBriefs() {
    const meta = briefModule().meta()
    return { ok: true, briefs: meta.briefs, settings: meta.settings }
  }

  function briefContent(url) {
    const date = requireString(url.searchParams.get('date'), 'date')
    const module = briefModule()
    const content = module.read(date)
    if (content === undefined) throw new HttpError(404, '该日期没有晨间简报')
    const path = typeof module.pathOf === 'function' ? module.pathOf(date) : ''
    return { ok: true, date, path, content }
  }

  function generateBrief(body) {
    const date = body && body.date !== undefined && body.date !== null && body.date !== ''
      ? String(body.date).trim()
      : undefined
    const result = briefModule().generate(date)
    return { ok: true, date: result.date }
  }

  // --- self-evolution (v9) -------------------------------------------------

  function evolutionState() {
    return { ok: true, ...evolutionModule().meta() }
  }

  function evolutionContent(url) {
    const date = requireString(url.searchParams.get('date'), 'date')
    const content = evolutionModule().readRetrospective(date)
    if (content === undefined) throw new HttpError(404, '复盘不存在')
    return { ok: true, date, content }
  }

  function skillContent(url) {
    const name = requireString(url.searchParams.get('name'), 'name')
    const skill = store.evolution.skills.find(item => item.name === name)
    if (!skill) throw new HttpError(404, '技能不存在')
    return { ok: true, ...skill }
  }

  function generateRetrospective(body) {
    const date = body && body.date !== undefined && body.date !== null && body.date !== ''
      ? String(body.date).trim()
      : undefined
    const result = evolutionModule().generate(date)
    return { ok: true, date: result.date, ...(result.skipped === true ? { skipped: true } : {}) }
  }

  async function addLesson(body) {
    evolutionModule()
    const lesson = store.addLesson({
      text: requireString(body.text, 'text'),
      category: body.category,
      scope: body.scope,
      project: body.project,
    })
    return { ok: true, lesson, lessons: store.evolution.lessons }
  }

  async function updateLesson(body) {
    evolutionModule()
    const id = requireString(body.id, 'id')
    const patch = {}
    if ('text' in body) patch.text = typeof body.text === 'string' ? body.text : ''
    if ('category' in body) patch.category = body.category
    if ('scope' in body) patch.scope = body.scope
    if ('project' in body) patch.project = body.project
    if ('active' in body) patch.active = body.active !== false
    const lesson = store.updateLesson(id, patch)
    return { ok: true, lesson, lessons: store.evolution.lessons }
  }

  async function deleteLesson(body) {
    evolutionModule()
    const id = requireString(body.id, 'id')
    store.deleteLesson(id)
    return { ok: true, lessons: store.evolution.lessons }
  }

  async function skillAction(body) {
    const module = evolutionModule()
    const name = requireString(body.name, 'name')
    const action = requireString(body.action, 'action')
    if (!['adopt', 'disable', 'enable', 'delete'].includes(action)) {
      throw new HttpError(400, `未知操作：${action}`)
    }
    if (action === 'delete') {
      if (!store.deleteSkill(name)) throw new HttpError(404, '技能不存在')
      module.refreshSkills()
      return { ok: true, skills: store.evolution.skills.map(skillMeta) }
    }
    const skill = store.evolution.skills.find(item => item.name === name)
    if (!skill) throw new HttpError(404, '技能不存在')
    let status = ''
    if (action === 'adopt') {
      if (skill.status !== 'proposed') throw new HttpError(400, '技能状态不支持该操作')
      if (!skill.content) throw new HttpError(400, '技能内容为空，无法采用')
      status = 'active'
    } else if (action === 'disable') {
      if (skill.status !== 'active' && skill.status !== 'proposed') {
        throw new HttpError(400, '技能状态不支持该操作')
      }
      status = 'disabled'
    } else {
      if (skill.status !== 'disabled') throw new HttpError(400, '技能状态不支持该操作')
      status = 'active'
    }
    const updated = store.setSkillStatus(name, status)
    module.refreshSkills()
    return { ok: true, skill: skillMeta(updated), skills: store.evolution.skills.map(skillMeta) }
  }

  async function handle(req, res) {
    if (!sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: '拒绝非同源请求' })
      return
    }
    const rejection = connectionRejection(ctx, req)
    if (rejection !== undefined) {
      sendJson(res, rejection, {
        ok: false,
        error: rejection === 401
          ? '需要先登录 DSH：请重新打开 dsh web 启动时打印的网址。'
          : '这个请求来自不受信任的地址，已拒绝。',
      })
      return
    }
    const url = new URL(req.url || '/', 'http://localhost')
    const method = String(req.method || 'GET').toUpperCase()
    let route = url.pathname
    if (route.startsWith(PREFIX)) route = route.slice(PREFIX.length)
    if (!route) route = '/'
    if (route.length > 1 && route.endsWith('/')) route = route.slice(0, -1)

    try {
      if (method === 'GET' && (route === '/ping' || route === '/')) {
        sendJson(res, 200, { ok: true, version: VERSION, rev: store.rev })
        return
      }
      if (method === 'GET' && route === '/state') {
        sendJson(res, 200, await state())
        return
      }
      if (method === 'GET' && route === '/models') {
        sendJson(res, 200, await models())
        return
      }
      if (method === 'GET' && route === '/webhook/log') {
        sendJson(res, 200, await webhookLog())
        return
      }
      if (method === 'GET' && route === '/backups') {
        sendJson(res, 200, await listBackups())
        return
      }
      if (method === 'GET' && route === '/transcript') {
        sendJson(res, 200, await transcript(url))
        return
      }
      if (method === 'GET' && route === '/reports') {
        sendJson(res, 200, listReports())
        return
      }
      if (method === 'GET' && route === '/reports/content') {
        sendJson(res, 200, reportContent(url))
        return
      }
      if (method === 'GET' && route === '/briefs') {
        sendJson(res, 200, listBriefs())
        return
      }
      if (method === 'GET' && route === '/briefs/content') {
        sendJson(res, 200, briefContent(url))
        return
      }
      if (method === 'GET' && route === '/evolution') {
        sendJson(res, 200, evolutionState())
        return
      }
      if (method === 'GET' && route === '/evolution/content') {
        sendJson(res, 200, evolutionContent(url))
        return
      }
      if (method === 'GET' && route === '/evolution/skills/content') {
        sendJson(res, 200, skillContent(url))
        return
      }
      if (method === 'POST') {
        const body = await readJsonBody(req)
        if (route === '/tasks') return sendJson(res, 200, await createTask(body))
        if (route === '/tasks/batch') return sendJson(res, 200, await createBatch(body))
        if (route === '/tasks/reorder') return sendJson(res, 200, await reorder(body))
        if (route === '/tasks/update') return sendJson(res, 200, await updateTask(body))
        if (route === '/tasks/action') return sendJson(res, 200, await action(body))
        if (route === '/settings') return sendJson(res, 200, await settings(body))
        if (route === '/chat') return sendJson(res, 200, await chat(body))
        if (route === '/session/cancel') return sendJson(res, 200, await cancelSession(body))
        if (route === '/webhook/test') return sendJson(res, 200, await testWebhook())
        if (route === '/reports/generate') return sendJson(res, 200, generateReport(body))
        if (route === '/briefs/generate') return sendJson(res, 200, generateBrief(body))
        if (route === '/evolution/generate') return sendJson(res, 200, generateRetrospective(body))
        if (route === '/evolution/lessons') return sendJson(res, 200, await addLesson(body))
        if (route === '/evolution/lessons/update') return sendJson(res, 200, await updateLesson(body))
        if (route === '/evolution/lessons/delete') return sendJson(res, 200, await deleteLesson(body))
        if (route === '/evolution/skills/action') return sendJson(res, 200, await skillAction(body))
        if (route === '/backups/restore') return sendJson(res, 200, await restoreBackup(body))
      }
      sendJson(res, 404, { ok: false, error: `未知接口：${method} ${route}` })
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      const message = error instanceof Error && error.message ? error.message : '内部错误'
      if (status === 500) {
        try {
          console.error('[personal-secretary] api error:', error)
        } catch {
          // ignore
        }
      }
      sendJson(res, status, { ok: false, error: message })
    }
  }

  return {
    handle,
    PREFIX,
    operations: {
      state,
      createTask,
      createBatch,
      reorder,
      updateTask,
      action,
      settings,
      models,
      transcript,
      chat,
      cancelSession,
      listReports,
      reportContent,
      generateReport,
      listBriefs,
      briefContent,
      generateBrief,
      testWebhook,
      webhookLog,
      evolutionMeta: evolutionState,
      generateRetrospective,
      addLesson,
      updateLesson,
      deleteLesson,
      skillAction,
    },
  }
}

export function registerApi(ctx, api) {
  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: api.handle,
  })
  return () => {
    if (typeof dispose === 'function') dispose()
  }
}

export { PREFIX, VERSION }

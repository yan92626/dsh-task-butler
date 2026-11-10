/**
 * Agent tool: let a live Agent publish and supervise secretary work.
 *
 * The tool and the browser share one operation layer (`createApi().operations`),
 * so a task published from chat is the same durable row the board renders, and
 * a control action from chat goes through the same state machine.
 */
const TOOL_NAME = 'secretary'
const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 100
const REPORT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function pickString(args, key) {
  const value = args && typeof args === 'object' ? args[key] : undefined
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

function summarizeTask(task, snippet) {
  const summary = {
    id: task.id,
    title: task.title,
    status: task.status,
    cwd: task.cwd,
    source: task.source || 'queue',
    priority: task.priority || 'normal',
    createdAt: task.createdAt,
  }
  if (task.chainFrom) summary.chainFrom = task.chainFrom
  if (task.startedAt) summary.startedAt = task.startedAt
  if (task.endedAt) summary.endedAt = task.endedAt
  if (task.error) summary.error = task.error
  if (task.sessionId) summary.sessionId = task.sessionId
  if (task.result) {
    summary.durationMs = task.result.durationMs
    summary.turns = task.result.turns
    if (task.result.usage) summary.usage = task.result.usage
    if (typeof task.result.finalAnswer === 'string') summary.resultPreview = snippet(task.result.finalAnswer)
  }
  return summary
}

const CONTROL_ACTIONS = {
  cancel: 'cancel',
  retry: 'retry',
  delete: 'delete',
  run_next: 'run-next',
  run: 'run',
  pause: 'pause',
  resume: 'resume',
  interrupt: 'interrupt',
  promote: 'promote',
  demote: 'demote',
}

export function registerTool(ctx, { store, scheduler, bridge, reports, operations }) {
  let tools
  try {
    tools = ctx.get('tools')
  } catch {
    tools = undefined
  }
  if (!tools || typeof tools.register !== 'function') return () => {}

  const description = [
    '管理「任务管家」：把工作发布成任务，由 Harness 在后台按全局并发自动领取执行。每个任务是一个独立会话，可指定工作目录、默认模型与“承接上一任务结果”的串联关系；也可以查询、取消、重试、置顶、暂停、继续、打断或删除任务，立即生成某天的日报，或执行复盘与自我进化（经验规则与技能沉淀）。',
    '适用：多个彼此独立或按顺序串行的工作、需要排队/限流/无人值守执行、或希望稍后统一查看结果。单次交互式工作直接用当前会话即可，不要为了用秘书而用秘书。',
    '新任务默认放进「待开始」（status=idea，暂不执行）；需要真正开展时用 promote 移入排队中，或发布时直接指定 status=pending。priority 只影响展示与筛选，不影响领取顺序。发布后不要在本会话里重复执行同一件事。',
  ].join(' ')

  const definition = {
    name: TOOL_NAME,
    description,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'publish',
            'list',
            'get',
            'cancel',
            'retry',
            'delete',
            'run_next',
            'run',
            'pause',
            'resume',
            'interrupt',
            'promote',
            'demote',
            'set_settings',
            'daily_report',
            'retrospective',
            'evolution',
          ],
          description: '要执行的操作。publish=发布任务；list=查看任务；get=查看某任务详情与对话；cancel/retry/delete/run_next/run/pause/resume/interrupt=任务控制；promote=待开始 → 排队中；demote=排队中 → 待开始；set_settings=调整并发、默认模型与日报设置；daily_report=立即生成日报；retrospective=立即生成一次复盘（覆盖上次复盘以来的任务），复盘会沉淀经验规则与技能候选；evolution=查看复盘设置、经验规则与技能。',
        },
        title: { type: 'string', description: 'publish 必填：任务标题（简短，可作为卡片标题）。' },
        prompt: { type: 'string', description: 'publish 必填：任务正文，写清目标、约束与验收标准。' },
        cwd: { type: 'string', description: 'publish 可选：任务工作目录的绝对路径；省略时使用当前默认工作目录。' },
        chain_from: { type: 'string', description: 'publish 可选：承接某个已完成任务的 id，把它的执行结果拼进本次任务开头。' },
        status: {
          type: 'string',
          enum: ['idea', 'pending'],
          description: 'publish 可选：新任务放入哪一列。idea=待开始（默认，暂不执行），pending=排队中（发布后即参与自动领取）。',
        },
        priority: {
          type: 'string',
          enum: ['urgent', 'high', 'normal', 'low'],
          description: 'publish 可选：优先级（紧急/高/普通/低），仅用于展示与筛选，不影响领取顺序与串联；默认 normal。',
        },
        id: { type: 'string', description: 'get/cancel/retry/delete/run_next/run/pause/resume/interrupt 必填：任务 id（也接受该任务的会话 id）。' },
        limit: { type: 'integer', description: 'list 可选：最多返回多少个任务，默认 20，最大 100。' },
        concurrency: { type: 'integer', description: 'set_settings 可选：全局并发 1-10。' },
        auto_start: { type: 'boolean', description: 'set_settings 可选：是否自动领取任务。' },
        provider: { type: 'string', description: 'set_settings 可选：默认模型 provider。' },
        model: { type: 'string', description: 'set_settings 可选：默认模型 id。' },
        reasoning_effort: { type: 'string', description: 'set_settings 可选：默认思考强度 id。' },
        notify_on_done: { type: 'boolean', description: 'set_settings 可选：任务跑完时是否发送完成通知。' },
        daily_report_time: { type: 'string', description: 'set_settings 可选：自动生成日报的本地时间 HH:mm。' },
        date: { type: 'string', description: 'daily_report / retrospective 可选：要生成或复盘的日期 YYYY-MM-DD，默认今天。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderValue,
    },
    async execute(args) {
      const action = pickString(args, 'action')
      if (!action) throw new Error('缺少参数 action')
      if (action === 'publish') return publish(args)
      if (action === 'list') return list(args)
      if (action === 'get') return get(args)
      if (action === 'set_settings') return setSettings(args)
      if (action === 'daily_report') return dailyReport(args)
      if (action === 'retrospective') return retrospective(args)
      if (action === 'evolution') return evolutionInfo()
      return control(action, args)
    },
  }

  function renderValue(_args, value) {
    let text
    try {
      text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    } catch {
      text = String(value)
    }
    if (text.length > 20_000) text = `${text.slice(0, 20_000)}…`
    return [{ type: 'text', text }]
  }

  async function publish(args) {
    const title = pickString(args, 'title')
    const prompt = pickString(args, 'prompt')
    if (!title) throw new Error('publish 需要 title')
    if (!prompt) throw new Error('publish 需要 prompt')
    let cwd = pickString(args, 'cwd')
    if (!cwd) {
      try {
        const workingDirectory = ctx.get('workingDirectory')
        if (workingDirectory && typeof workingDirectory.defaultDirectory === 'string') {
          cwd = workingDirectory.defaultDirectory
        }
      } catch {
        cwd = undefined
      }
    }
    if (!cwd) throw new Error('publish 需要 cwd（任务工作目录绝对路径）')
    const result = await operations.createTask({
      title,
      prompt,
      cwd,
      chainFrom: pickString(args, 'chain_from'),
      status: pickString(args, 'status'),
      priority: pickString(args, 'priority'),
    })
    return {
      ok: true,
      message: result.task.status === 'idea'
        ? '任务已发布到待开始，暂不执行；使用 promote 移入排队中后，秘书会按并发自动领取。'
        : '任务已发布到排队中，秘书会自动领取执行。',
      task: summarizeTask(result.task, bridge.snippet),
    }
  }

  async function list(args) {
    const limitRaw = args && Number.isFinite(args.limit) ? args.limit : DEFAULT_LIST_LIMIT
    const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.round(limitRaw)))
    const snapshot = await operations.state()
    return {
      ok: true,
      counts: snapshot.counts,
      runningCount: snapshot.runningCount,
      settings: {
        concurrency: snapshot.settings.concurrency,
        autoStart: snapshot.settings.autoStart,
        provider: snapshot.settings.provider,
        model: snapshot.settings.model,
        reasoningEffort: snapshot.settings.reasoningEffort,
        dailyReport: {
          enabled: snapshot.settings.dailyReport.enabled,
          time: snapshot.settings.dailyReport.time,
          dir: snapshot.settings.dailyReport.dir,
          lastDate: snapshot.settings.dailyReport.lastDate,
          lastStatus: snapshot.settings.dailyReport.lastStatus,
        },
      },
      tasks: snapshot.tasks.slice(0, limit).map(task => summarizeTask(task, bridge.snippet)),
    }
  }

  function resolveTask(args) {
    const id = pickString(args, 'id')
    if (!id) throw new Error('缺少参数 id')
    const task = store.find(id) || store.findBySession(id)
    if (!task) throw new Error(`任务不存在：${id}`)
    return task
  }

  async function get(args) {
    const task = resolveTask(args)
    let messages = []
    if (task.sessionId) {
      try {
        const transcript = await operations.transcript({
          searchParams: new URLSearchParams({ sessionId: task.sessionId }),
        })
        messages = transcript.messages || []
      } catch {
        messages = []
      }
    }
    return {
      ok: true,
      task: summarizeTask(task, bridge.snippet),
      result: task.result ? { ...task.result, finalAnswer: task.result.finalAnswer } : undefined,
      messages: messages.slice(-40),
    }
  }

  async function control(action, args) {
    const operation = CONTROL_ACTIONS[action]
    if (!operation) throw new Error(`未知 action：${action}`)
    const task = resolveTask(args)
    const result = await operations.action({ id: task.id, action: operation })
    scheduler.kick()
    return {
      ok: true,
      task: result.task ? summarizeTask(result.task, bridge.snippet) : undefined,
      tasks: result.tasks.map(item => summarizeTask(item, bridge.snippet)),
    }
  }

  async function setSettings(args) {
    const patch = {}
    if (args && Number.isFinite(args.concurrency)) patch.concurrency = args.concurrency
    if (args && typeof args.auto_start === 'boolean') patch.autoStart = args.auto_start
    if (args && typeof args.provider === 'string') patch.provider = args.provider
    if (args && typeof args.model === 'string') patch.model = args.model
    if (args && typeof args.reasoning_effort === 'string') patch.reasoningEffort = args.reasoning_effort
    if (args && typeof args.notify_on_done === 'boolean') patch.notifyOnDone = args.notify_on_done
    if (args && typeof args.daily_report_time === 'string') {
      patch.dailyReport = { time: args.daily_report_time }
    }
    if (Object.keys(patch).length === 0) throw new Error('set_settings 没有可更新的字段')
    const result = await operations.settings(patch)
    scheduler.kick()
    return { ok: true, settings: result.settings }
  }

  async function dailyReport(args) {
    const date = pickString(args, 'date')
    if (date && !REPORT_DATE_PATTERN.test(date)) throw new Error('date 格式应为 YYYY-MM-DD')
    const result = await operations.generateReport(date ? { date } : {})
    return { ok: true, date: result.date }
  }

  async function retrospective(args) {
    const date = pickString(args, 'date')
    if (date && !REPORT_DATE_PATTERN.test(date)) throw new Error('date 格式应为 YYYY-MM-DD')
    if (!operations || typeof operations.generateRetrospective !== 'function') {
      throw new Error('当前版本不支持复盘')
    }
    const result = await operations.generateRetrospective(date ? { date } : {})
    return {
      ok: true,
      date: result.date,
      ...(result.skipped === true ? { skipped: true } : {}),
      message: result.skipped === true
        ? '本期没有需要复盘的任务，已跳过（未创建模型会话）。'
        : '复盘已开始生成，完成后会写入复盘目录并沉淀经验/技能。',
    }
  }

  async function evolutionInfo() {
    if (!operations || typeof operations.evolutionMeta !== 'function') {
      throw new Error('当前版本不支持自我进化')
    }
    const snapshot = await operations.evolutionMeta()
    const current = snapshot.settings || {}
    return {
      ok: true,
      settings: {
        enabled: current.enabled === true,
        interval: current.interval,
        time: current.time,
        skillMode: current.skillMode,
        lastDate: current.lastDate ?? null,
        lastStatus: current.lastStatus,
        lastError: current.lastError ?? null,
      },
      lessons: (snapshot.lessons || []).map(lesson => ({
        id: lesson.id,
        text: lesson.text,
        category: lesson.category,
        scope: lesson.scope,
        project: lesson.project ?? null,
        active: lesson.active === true,
        evidence: lesson.evidence || '',
      })),
      skills: (snapshot.skills || []).map(skill => ({
        name: skill.name,
        description: skill.description,
        status: skill.status,
        scope: skill.scope,
        whenToUse: skill.whenToUse || '',
      })),
    }
  }

  const dispose = tools.register(definition)
  return () => {
    if (typeof dispose === 'function') dispose()
  }
}

export { TOOL_NAME }

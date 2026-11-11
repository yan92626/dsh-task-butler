/**
 * Webhook notifications.
 *
 * The secretary can push a Markdown message to a configurable webhook when a
 * task is claimed, finishes, blocks, fails, when a daily report is written, or
 * when the v0.6 morning brief is generated.
 * Delivery is best-effort and asynchronous: it never blocks the scheduler and
 * a broken endpoint only records a last-delivery failure.
 */

import { createHmac } from 'node:crypto'

const DELIVERY_TIMEOUT_MS = 10_000
const RESPONSE_SNIPPET_LIMIT = 300
const RESULT_EXCERPT = 1200

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatTime(value) {
  const date = Number.isFinite(value) ? new Date(value) : new Date()
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatDuration(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  const seconds = Math.round(value / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} 分 ${seconds % 60} 秒`
}

function modelLine(task) {
  if (!task || (!task.provider && !task.model)) return ''
  const effort = task.reasoningEffort ? ` · ${task.reasoningEffort}` : ''
  return `${task.provider || '默认'} / ${task.model || '默认'}${effort}`
}

function priorityLabel(task) {
  return { urgent: '紧急', high: '高', normal: '普通', low: '低' }[task && task.priority] || '普通'
}

function baseLines(task) {
  const lines = []
  if (task.cwd) lines.push(`- 工作目录：${task.cwd}`)
  const model = modelLine(task)
  if (model) lines.push(`- 模型：${model}`)
  lines.push(`- 优先级：${priorityLabel(task)}`)
  if (task.sessionId) lines.push(`- 会话：${task.sessionId}`)
  return lines
}

export function claimedMarkdown(task) {
  const lines = [
    `## 🚀 任务已领取`,
    '',
    `**${task.title}**`,
    '',
    '- 状态：处理中',
    ...baseLines(task),
    `- 领取时间：${formatTime(task.startedAt || Date.now())}`,
  ]
  return lines.join('\n')
}

export function succeededMarkdown(task) {
  const result = task.result || {}
  const lines = [
    `## ✅ 任务执行成功`,
    '',
    `**${task.title}**`,
    '',
    `- 完成时间：${formatTime(task.endedAt || Date.now())}`,
    `- 执行耗时：${formatDuration(result.durationMs)}`,
    `- 对话轮次：${result.turns || 0}`,
  ]
  if (result.usage) {
    const cache = result.usage.cacheReadTokens ? ` · 缓存读 ${result.usage.cacheReadTokens}` : ''
    lines.push(`- Tokens：输入 ${result.usage.inputTokens || 0} · 输出 ${result.usage.outputTokens || 0}${cache}`)
  }
  lines.push(...baseLines(task))
  const answer = typeof result.finalAnswer === 'string' ? result.finalAnswer.trim() : ''
  if (answer) {
    lines.push('', '### 结果摘要', '', answer.length > RESULT_EXCERPT ? `${answer.slice(0, RESULT_EXCERPT)}…` : answer)
  }
  return lines.join('\n')
}

export function failedMarkdown(task) {
  const lines = [
    `## ❌ 任务失败`,
    '',
    `**${task.title}**`,
    '',
    `- 失败时间：${formatTime(task.endedAt || Date.now())}`,
    ...(task.error ? [`- 原因：${task.error}`] : []),
    ...baseLines(task),
  ]
  return lines.join('\n')
}

export function blockedMarkdown(task) {
  const lines = [
    `## ⏸️ 任务阻塞，需要你处理`,
    '',
    `**${task.title}**`,
    '',
    '- 状态：等待你的回答或审批',
    ...baseLines(task),
    `- 阻塞时间：${formatTime(Date.now())}`,
  ]
  return lines.join('\n')
}

export function dailyReportMarkdown(payload) {
  const date = payload && payload.date ? payload.date : ''
  const content = payload && typeof payload.content === 'string' ? payload.content.trim() : ''
  const path = payload && payload.path ? payload.path : ''
  return [
    `## 📊 ${date} 工作日报`,
    '',
    content || '_（日报内容为空）_',
    '',
    path ? `> 文件：${path}` : '',
  ].filter(line => line !== '').join('\n')
}

export function testMarkdown() {
  return [
    '## 🔔 任务管家 · Webhook 测试',
    '',
    '收到这条消息说明 Webhook 配置成功，之后的「任务领取 / 执行成功 / 阻塞 / 失败 / 晨报 / 日报 / 复盘」都会以这种 Markdown 形式推送。',
    '',
    `- 发送时间：${formatTime(Date.now())}`,
  ].join('\n')
}

const MORNING_BRIEF_EXCERPT = 600
const MORNING_BRIEF_SUGGESTIONS = 3

function morningBriefSuggestionLines(payload) {
  const suggestions = Array.isArray(payload && payload.suggestions) ? payload.suggestions : []
  const lines = []
  for (const item of suggestions.slice(0, MORNING_BRIEF_SUGGESTIONS)) {
    if (!item || typeof item !== 'object') continue
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    if (!title) continue
    const reason = typeof item.reason === 'string' ? item.reason.trim() : ''
    lines.push(`• ${title}${reason ? ` — ${reason}` : ''}`)
  }
  return lines
}

/**
 * v0.7 morning brief notification: the fixed title, the structured "今天建议"
 * list (title — reason), the brief excerpt (capped) and the file path. Platform
 * flattening applies to this Markdown automatically through `renderMarkdown`.
 */
export function morningBriefMarkdown(payload) {
  const date = payload && payload.date ? String(payload.date) : ''
  const content = payload && typeof payload.content === 'string' ? payload.content.trim() : ''
  const path = payload && payload.path ? String(payload.path) : ''
  const suggestionLines = morningBriefSuggestionLines(payload)
  const excerpt = content.length > MORNING_BRIEF_EXCERPT
    ? `${content.slice(0, MORNING_BRIEF_EXCERPT)}…`
    : content
  return [
    `## 🌅 晨间简报 · ${date}`,
    '',
    ...(suggestionLines.length > 0 ? ['**今天建议：**', ...suggestionLines, ''] : []),
    excerpt || (date ? `_（${date} 晨间简报内容为空）_` : '_（晨间简报内容为空）_'),
    '',
    ...(path ? [`> 文件：${path}`] : []),
  ].filter(line => line !== '').join('\n')
}

/**
 * v9 retrospective notification: the report excerpt plus how many lesson rules
 * changed and how many skills were suggested/auto-activated.
 */
export function retrospectiveMarkdown(payload) {
  const date = payload && payload.date ? String(payload.date) : ''
  const content = payload && typeof payload.content === 'string' ? payload.content.trim() : ''
  const path = payload && payload.path ? String(payload.path) : ''
  const lessonsAdded = Number.isFinite(payload && payload.lessonsAdded) ? payload.lessonsAdded : 0
  const skillsSuggested = Number.isFinite(payload && payload.skillsSuggested) ? payload.skillsSuggested : 0
  const skillsActivated = Number.isFinite(payload && payload.skillsActivated) ? payload.skillsActivated : 0
  const excerpt = content.length > RESULT_EXCERPT ? `${content.slice(0, RESULT_EXCERPT)}…` : content
  return [
    '## 🧠 复盘完成',
    '',
    excerpt || (date ? `_（${date} 复盘内容为空）_` : '_（复盘内容为空）_'),
    '',
    `- 新增/更新经验：${lessonsAdded} 条`,
    `- 技能候选：${skillsSuggested} 个 / 已自动启用：${skillsActivated} 个`,
    ...(path ? ['', `> 文件：${path}`] : []),
  ].join('\n')
}

export function renderMarkdown(event, payload) {
  let markdown = ''
  if (event === 'claimed') markdown = claimedMarkdown(payload)
  else if (event === 'succeeded') markdown = succeededMarkdown(payload)
  else if (event === 'failed') markdown = failedMarkdown(payload)
  else if (event === 'blocked') markdown = blockedMarkdown(payload)
  else if (event === 'dailyReport') markdown = dailyReportMarkdown(payload)
  else if (event === 'morningBrief') markdown = morningBriefMarkdown(payload)
  else if (event === 'retrospective') markdown = retrospectiveMarkdown(payload)
  else markdown = testMarkdown()
  // A stable footer also carries the default keyword, so Feishu/DingTalk bots
  // configured with keyword security accept every notification.
  return `${markdown}\n\n---\n\n> 任务管家`
}


/**
 * Feishu card markdown, WeCom markdown and Slack mrkdwn only support a subset
 * of Markdown: headings, horizontal rules and block quotes are rendered
 * literally. Flatten our templates (and model-written report bodies) into the
 * subset those receivers actually render, so notifications look clean.
 */
function flattenMarkdown(markdown, format) {
  if (format !== 'feishu' && format !== 'wecom' && format !== 'dingtalk' && format !== 'slack') {
    return markdown
  }
  const lines = String(markdown || '').split('\n')
  const out = []
  let inFence = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^```/.test(trimmed)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      out.push(trimmed)
      continue
    }
    if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
      out.push('')
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      out.push(`**${heading[2]}**`)
      continue
    }
    if (trimmed.startsWith('> ')) {
      out.push(trimmed.slice(2))
      continue
    }
    if (/^[-*+]\s+/.test(trimmed)) {
      out.push(`• ${trimmed.replace(/^[-*+]\s+/, '')}`)
      continue
    }
    out.push(line)
  }
  let text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (format === 'slack') {
    // Slack mrkdwn uses single asterisks for bold.
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
  }
  return text
}

function feishuSign(timestamp, secret) {
  const stringToSign = `${timestamp}\n${secret}`
  return createHmac('sha256', stringToSign).update('').digest('base64')
}

function dingtalkSign(timestamp, secret) {
  return createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64')
}

/**
 * Adapt one Markdown message to the receiving platform's payload.
 *
 * Feishu custom bots do not accept a bare `markdown` msg_type; an interactive
 * card with a markdown element renders the same content and is accepted by
 * every current bot. Signed bots get `timestamp`/`sign` when a secret is set.
 */
function buildBody(format, event, markdown, config) {
  const title = '任务管家通知'
  const secret = typeof config.secret === 'string' ? config.secret : ''
  if (format === 'feishu') {
    const payload = {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: title } },
        elements: [{ tag: 'markdown', content: markdown }],
      },
    }
    if (secret !== '') {
      const timestamp = Math.floor(Date.now() / 1000)
      payload.timestamp = String(timestamp)
      payload.sign = feishuSign(timestamp, secret)
    }
    return payload
  }
  if (format === 'wecom') {
    return { msgtype: 'markdown', markdown: { content: markdown } }
  }
  if (format === 'dingtalk') {
    const payload = { msgtype: 'markdown', markdown: { title, text: markdown } }
    if (secret !== '') {
      const timestamp = Date.now()
      payload.timestamp = String(timestamp)
      payload.sign = dingtalkSign(timestamp, secret)
    }
    return payload
  }
  if (format === 'slack') return { text: markdown }
  return { event, title, text: markdown, markdown }
}

/** Turn the receiving platform's response body into a delivery outcome. */
function interpretResponse(format, response, text) {
  const httpStatus = response.status
  const snippet = String(text || '').replace(/\s+/g, ' ').trim().slice(0, RESPONSE_SNIPPET_LIMIT)
  const failure = (message) => ({
    ok: false,
    httpStatus,
    responseSnippet: snippet,
    error: snippet ? `${message}（HTTP ${httpStatus} · ${snippet}）` : `${message}（HTTP ${httpStatus}）`,
  })
  if (!response.ok) return failure('Webhook 返回非成功状态')
  let body = null
  try {
    body = snippet ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!body || typeof body !== 'object') return { ok: true, httpStatus, responseSnippet: snippet }
  if (format === 'feishu') {
    const code = typeof body.code === 'number' ? body.code : (typeof body.StatusCode === 'number' ? body.StatusCode : 0)
    if (code !== 0) return failure(`飞书返回错误 ${code}${body.msg ? `：${body.msg}` : ''}`)
  } else if (format === 'wecom') {
    if (typeof body.errcode === 'number' && body.errcode !== 0) {
      return failure(`企业微信返回错误 ${body.errcode}${body.errmsg ? `：${body.errmsg}` : ''}`)
    }
  } else if (format === 'dingtalk') {
    if (typeof body.errcode === 'number' && body.errcode !== 0) {
      return failure(`钉钉返回错误 ${body.errcode}${body.errmsg ? `：${body.errmsg}` : ''}`)
    }
  } else if (format === 'slack') {
    if (body.ok === false) return failure(`Slack 返回错误${body.error ? `：${body.error}` : ''}`)
  } else if (body.success === false || body.ok === false) {
    return failure('Webhook 返回失败')
  }
  return { ok: true, httpStatus, responseSnippet: snippet }
}

export function createWebhook({ ctx, store }) {
  let chain = Promise.resolve()
  const deliveries = []

  function config() {
    return (store.settings && store.settings.webhook) || {}
  }

  function enabledFor(event) {
    const current = config()
    if (current.enabled !== true) return false
    if (typeof current.url !== 'string' || current.url === '') return false
    const events = current.events || {}
    return events[event] !== false
  }

  function remember(outcome) {
    try {
      deliveries.unshift({
        at: Date.now(),
        event: outcome.event || 'test',
        ok: outcome.ok === true,
        httpStatus: Number.isFinite(outcome.httpStatus) ? outcome.httpStatus : null,
        error: outcome.error || '',
        responseSnippet: outcome.responseSnippet || '',
      })
      if (deliveries.length > 20) deliveries.length = 20
    } catch {
      // diagnostics only
    }
  }

  function deliveryLog() {
    return deliveries.slice(0, 20)
  }

  function record(outcome) {
    remember(outcome)
    try {
      store.updateSettings({
        webhook: {
          lastStatus: outcome.ok ? 'ok' : 'failed',
          lastAt: Date.now(),
          lastEvent: outcome.event || 'test',
          lastError: outcome.ok ? '' : String(outcome.error || '发送失败').slice(0, 500),
        },
      })
    } catch {
      // bookkeeping must never break the caller
    }
  }

  /** Deliver one Markdown payload and resolve to a delivery outcome. */
  async function deliver(event, markdown) {
    const current = config()
    const format = current.format || 'generic'
    const body = buildBody(format, event, flattenMarkdown(markdown, format), current)
    const headers = { 'content-type': 'application/json' }
    if (typeof current.secret === 'string' && current.secret !== '' && format !== 'feishu' && format !== 'dingtalk') {
      headers[current.secretHeader || 'Authorization'] = current.secret
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)
    try {
      const response = await fetch(current.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      let text = ''
      try {
        text = await response.text()
      } catch {
        text = ''
      }
      const outcome = interpretResponse(format, response, text)
      return { ...outcome, event }
    } catch (error) {
      const message = error && error.name === 'AbortError'
        ? '请求超时'
        : (error && error.message ? error.message : '网络错误')
      return { ok: false, event, error: message }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Fire-and-forget notification used by the scheduler and the daily reports.
   * Serialized so a slow webhook cannot interleave deliveries or slow a tick.
   */
  function notify(event, payload) {
    if (!enabledFor(event)) return
    let markdown
    try {
      markdown = renderMarkdown(event, payload)
    } catch {
      return
    }
    chain = chain
      .then(() => deliver(event, markdown))
      .then(outcome => record(outcome))
      .catch(() => {})
    return chain
  }

  /** Settings button: awaited delivery with an explicit outcome. */
  async function sendTest() {
    const current = config()
    if (typeof current.url !== 'string' || current.url === '') {
      return { ok: false, error: '请先填写 Webhook 地址' }
    }
    const outcome = await deliver('test', testMarkdown())
    record(outcome)
    return outcome
  }

  return { notify, sendTest, renderMarkdown, deliveryLog }
}

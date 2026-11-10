/**
 * Thin bridge over the Host `sessionController` service.
 *
 * The secretary never drives an Agent directly: it creates a normal Session,
 * picks its model, admits one prompt, and reads the committed session log back
 * for the transcript, the task result and the "waiting for an answer" state.
 * Everything the secretary causes is therefore reconstructable from ordinary
 * session events.
 */
import { randomUUID } from 'node:crypto'

const MAX_CHAT_TEXT = 20_000
const ASK_USER_QUESTION = 'ask_user_question'
const TITLE_LIMIT = 60

function textOfBlocks(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function trimSnippet(text, limit = 160) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean
}

function findLastTurnEnd(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event && event.type === 'turn/end') {
      return { seq: event.seq, time: event.time, reason: event.data?.reason }
    }
  }
  return undefined
}

function resultCallId(event) {
  if (!event || event.type !== 'tool/result') return ''
  const data = event.data
  if (!data || typeof data !== 'object') return ''
  const direct = data.toolCallId
  if (typeof direct === 'string' && direct) return direct
  const message = data.message
  if (message && typeof message === 'object') {
    if (typeof message.toolCallId === 'string' && message.toolCallId) return message.toolCallId
    const source = message.source
    if (source && typeof source === 'object' && typeof source.callId === 'string' && source.callId) {
      return source.callId
    }
  }
  return ''
}

/**
 * Whether the Session's currently open turn contains an `ask_user_question`
 * tool call that has not been answered yet. `surfaceOp: 'replace'` copies are
 * model-visible state, never a new call, so only appended rows are counted.
 */
function scanEvents(events) {
  let lastTurnStart = -1
  let lastTurnEnd = -1
  let lastUserAt = 0
  const answered = new Set()
  const pendingCalls = []
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (Array.isArray(event.surfaceOp) || event.surfaceOp === 'replace') continue
    if (event.type === 'turn/start') {
      lastTurnStart = Number.isFinite(event.seq) ? event.seq : lastTurnStart
    } else if (event.type === 'user/message') {
      // Only a committed human message counts as activity; runtime context and
      // reminders are injected with a different source kind.
      if (event.surfaceOp === 'append' && event.data && event.data.source && event.data.source.kind === 'user') {
        const time = Number.isFinite(event.time) ? event.time : 0
        if (time > lastUserAt) lastUserAt = time
      }
    } else if (event.type === 'turn/end') {
      lastTurnEnd = Number.isFinite(event.seq) ? event.seq : lastTurnEnd
    } else if (event.type === 'tool/result') {
      const callId = resultCallId(event)
      if (callId) answered.add(callId)
    } else if (event.type === 'tool/call') {
      const data = event.data
      if (data && data.name === ASK_USER_QUESTION && typeof data.callId === 'string') {
        pendingCalls.push({ seq: event.seq, callId: data.callId })
      }
    }
  }
  const lastEnd = findLastTurnEnd(events)
  // A closed turn cannot be "waiting for an answer" any more.
  if (lastTurnEnd > lastTurnStart) return { blocked: false, lastTurnEnd: lastEnd, lastUserAt }
  let blocked = false
  for (let index = pendingCalls.length - 1; index >= 0; index -= 1) {
    const call = pendingCalls[index]
    if (lastTurnStart >= 0 && call.seq <= lastTurnStart) continue
    if (!answered.has(call.callId)) {
      blocked = true
      break
    }
  }
  return { blocked, lastTurnEnd: lastEnd, lastUserAt }
}

export function createSessionBridge(ctx) {
  const controller = () => {
    const service = ctx.get('sessionController')
    if (!service) throw new Error('sessionController 服务不可用，无法创建会话')
    return service
  }
  // Remote-facing controller methods take an AbortSignal; the secretary's
  // calls are short and local, so each one owns a signal that is never aborted.
  const signal = () => new AbortController().signal

  const bridge = {
    /** Create the ordinary Session that will execute one task. */
    async createSession({ cwd }) {
      if (!cwd) throw new Error('任务缺少工作目录')
      const value = await controller().create({ cwd })
      if (!value || !value.sessionId) throw new Error('创建会话失败：未返回会话 ID')
      return value.sessionId
    },

    /** Install the secretary's default model (and reasoning effort) on a Session. */
    async selectModel(sessionId, selection) {
      if (!selection || !selection.provider || !selection.model) return
      const request = { sessionId, provider: selection.provider, model: selection.model }
      if (selection.reasoningEffort) request.reasoningEffort = selection.reasoningEffort
      await controller().selectModel(request)
    },

    /** Admit one prompt; the Agent runs it as its next turn. */
    async prompt(sessionId, text) {
      const content = String(text || '')
      if (!content.trim()) throw new Error('消息内容为空')
      if (content.length > MAX_CHAT_TEXT) throw new Error('消息内容过长')
      await controller().prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: content }],
      }, signal())
    },

    /** Cancel the Session's active turn. Failure is not fatal for a state action. */
    async cancel(sessionId) {
      if (!sessionId) return
      try {
        await controller().cancel({ sessionId })
      } catch {
        // The Session may already be idle or gone; the board state is authoritative.
      }
    },

    async catalog() {
      return await controller().modelCatalog()
    },

    /** Raw workspace session summaries, used by the external-session import. */
    async listItems() {
      let value
      try {
        value = await controller().list({}, signal())
      } catch {
        return []
      }
      const items = Array.isArray(value?.items) ? value.items : Array.isArray(value) ? value : []
      const out = []
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        if (typeof item.sessionId !== 'string' || !item.sessionId) continue
        out.push({
          sessionId: item.sessionId,
          cwd: typeof item.cwd === 'string' ? item.cwd : '',
          updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
          running: item.running === true,
          blank: item.blank === true,
          parentSessionId: typeof item.parentSessionId === 'string' && item.parentSessionId
            ? item.parentSessionId
            : undefined,
        })
      }
      return out
    },

    /** Map of sessionId -> summary for the sessions that still exist. */
    async listSessions() {
      const map = new Map()
      for (const item of await bridge.listItems()) map.set(item.sessionId, item)
      return map
    },

    async inspect(sessionId) {
      if (!sessionId) return undefined
      try {
        return await controller().inspect(sessionId, signal())
      } catch {
        return undefined
      }
    },

    /**
     * One log scan for the scheduler: the last committed turn end plus whether
     * the Agent is currently waiting for a user answer.
     */
    async scan(sessionId) {
      const inspection = await bridge.inspect(sessionId)
      if (!inspection) return undefined
      const events = Array.isArray(inspection.events) ? inspection.events : []
      return scanEvents(events)
    },

    /** Full session log as a simplified chat transcript (user/assistant text). */
    async transcript(sessionId) {
      const inspection = await bridge.inspect(sessionId)
      const events = Array.isArray(inspection?.events) ? inspection.events : []
      const messages = []
      let lastAssistant = ''
      for (const event of events) {
        if (!event || typeof event !== 'object') continue
        // A human transcript uses append-origin surface events only: a
        // replacement copy is model-visible state, not something the user saw.
        if (event.surfaceOp !== 'append') continue
        if (event.type === 'user/message') {
          // Injected runtime context and reminders are user-role events whose
          // source is not `user`; the conversation UI renders those as context
          // rows, so a task chat lists only messages a human actually wrote.
          if (event.data?.source?.kind !== 'user') continue
          const text = textOfBlocks(event.data?.content)
          if (text) {
            messages.push({ id: String(event.data?.id || event.seq), role: 'user', text, time: event.time })
          }
        } else if (event.type === 'assistant/message') {
          const message = event.data?.message
          const text = textOfBlocks(message?.content)
          if (text) {
            messages.push({ id: String(message?.id || event.seq), role: 'assistant', text, time: event.time })
            lastAssistant = text
          }
        }
      }
      const lastTurnEnd = findLastTurnEnd(events)
      return {
        messages,
        lastAssistant,
        lastTurnEnd,
        meta: inspection?.meta,
      }
    },

    /**
     * Aggregate one finished task session: final assistant text, turns and
     * token usage, read from the same committed log the transcript uses.
     */
    async summarize(sessionId) {
      const inspection = await bridge.inspect(sessionId)
      const events = Array.isArray(inspection?.events) ? inspection.events : []
      let finalAnswer = ''
      let turns = 0
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
      for (const event of events) {
        if (!event || typeof event !== 'object') continue
        if (event.type === 'turn/end' && Number.isFinite(event.data?.turn)) {
          turns = Math.max(turns, event.data.turn)
        }
        if (event.surfaceOp !== 'append') continue
        if (event.type === 'assistant/message') {
          const text = textOfBlocks(event.data?.message?.content)
          if (text) finalAnswer = text
          const measured = event.data?.usage
          if (measured) {
            usage.inputTokens += Number(measured.inputTokens) || 0
            usage.outputTokens += Number(measured.outputTokens) || 0
            usage.cacheReadTokens += Number(measured.cacheReadTokens) || 0
          }
        }
      }
      const hasUsage = usage.inputTokens > 0 || usage.outputTokens > 0 || usage.cacheReadTokens > 0
      return {
        finalAnswer,
        turns,
        usage: hasUsage ? usage : undefined,
      }
    },

    /** Last committed turn outcome, used to settle a task after a restart. */
    async lastTurnEnd(sessionId) {
      const inspection = await bridge.inspect(sessionId)
      if (!inspection) return undefined
      return findLastTurnEnd(Array.isArray(inspection.events) ? inspection.events : [])
    },

    /** Title for an imported workspace session: its first human message. */
    async firstUserMessage(sessionId) {
      const inspection = await bridge.inspect(sessionId)
      const events = Array.isArray(inspection?.events) ? inspection.events : []
      for (const event of events) {
        if (!event || typeof event !== 'object') continue
        if (event.type !== 'user/message') continue
        if (event.surfaceOp !== 'append') continue
        if (event.data?.source?.kind !== 'user') continue
        const text = textOfBlocks(event.data?.content).replace(/\s+/g, ' ').trim()
        if (text) return text.slice(0, TITLE_LIMIT)
      }
      return ''
    },

    snippet: trimSnippet,
  }

  return bridge
}

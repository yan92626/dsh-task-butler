/**
 * The secretary's engine: sync DSH workspace sessions onto the board, watch
 * running tasks for completion or a question waiting for an answer, then fill
 * the concurrency budget with the earliest pending task.
 *
 * The session log is the only source of truth for "did it finish" and "is it
 * blocked": the board never guesses from wall-clock time, and a turn that
 * ended before the task started is ignored.
 *
 * v0.6 also backfills imported DSH session tasks: when one of them finishes
 * (running -> done) or an old done row has no `result` yet, the committed log
 * is summarised onto the task, bounded to a few rows per tick so it can never
 * delay claim/dispatch.
 */
import { basename } from 'node:path'

const TICK_MS = 1500
const STALE_SESSION_MS = 90_000
const IMPORT_LIMIT = 100
const BACKFILL_LIMIT = 5
const FIRST_SYNC_WINDOW_MS = 24 * 60 * 60 * 1000
const RESUME_PROMPT = '继续完成该任务（上次被暂停）。'

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

export function buildPrompt(task) {
  return `# 任务：${task.title}\n\n${task.prompt}`
}

/**
 * Compose the prompt a claimed task receives. A task with `chainFrom` gets the
 * upstream task's final answer in front of its own instruction, so a published
 * sequence can carry a plan forward into the next step without manual copying.
 */
async function composePrompt(store, bridge, task) {
  const base = buildPrompt(task)
  if (!task.chainFrom) return base
  const previous = store.find(task.chainFrom)
  if (!previous) return base
  let answer = previous.result && previous.result.finalAnswer ? previous.result.finalAnswer : ''
  if (!answer && previous.sessionId) {
    try {
      const summary = await bridge.summarize(previous.sessionId)
      answer = summary.finalAnswer || ''
    } catch {
      answer = ''
    }
  }
  if (!answer) return base
  return `上一任务「${previous.title}」的结果：\n${answer}\n\n---\n\n${base}`
}

/**
 * Sessions created by earlier versions of this plugin (before the persisted
 * owned-session ledger existed) still carry a task/report prompt as their
 * first human message. Their rows belong to the queue's own history, so a
 * workspace import must skip them instead of resurrecting deleted tasks.
 */
const LEGACY_OWNED_PREFIXES = ['# 任务：', '上一任务「', '你是「私人秘书」', '任务队列自检']

function isLegacyOwnedPrompt(text) {
  const cleaned = String(text || '').trim()
  if (!cleaned) return false
  return LEGACY_OWNED_PREFIXES.some(prefix => cleaned.startsWith(prefix))
}

function importTitle(item, firstMessage) {
  const cleaned = String(firstMessage || '').replace(/\s+/g, ' ').trim()
  if (cleaned) return cleaned.slice(0, 60)
  const dir = item.cwd ? basename(item.cwd) : '工作区'
  return `${dir} · ${item.sessionId.slice(-6)}`
}

/** Pending tasks in the exact order the scheduler will claim them. */
export function pendingInClaimOrder(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter(task => task && task.status === 'pending')
}

/**
 * Done, imported DSH-session tasks that never received their result summary,
 * newest finished first, capped at `limit`.
 *
 * A task that already carries a `resultBackfillAt` attempt marker is excluded
 * on purpose: a deleted or unreadable session can never be retried forever.
 */
export function selectSessionResultBackfill(tasks, limit = BACKFILL_LIMIT) {
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : BACKFILL_LIMIT
  if (max === 0) return []
  const candidates = []
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || task.source !== 'session') continue
    if (task.status !== 'done' || !task.sessionId || task.result) continue
    if (Number.isFinite(task.resultBackfillAt)) continue
    candidates.push(task)
  }
  candidates.sort((left, right) =>
    (right.endedAt || right.updatedAt || right.createdAt || 0) -
    (left.endedAt || left.updatedAt || left.createdAt || 0))
  return candidates.slice(0, max)
}

export function createScheduler({ ctx, store, bridge, notify, options = {} }) {
  const tickMs = Number.isFinite(options.tickMs) ? options.tickMs : TICK_MS
  const push = typeof notify === 'function' ? notify : () => {}
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : STALE_SESSION_MS
  let timer = null
  let ticking = false
  let disposed = false
  const settling = new Set()
  // v0.6 session-result backfill: one serial promise chain, at most a few
  // inspections per tick, never awaited by the scheduler pass itself.
  const backfillQueued = new Set()
  let backfillChain = Promise.resolve()

  function log(...args) {
    try {
      console.log('[personal-secretary]', ...args)
    } catch {
      // logging must never break the scheduler
    }
  }

  function start() {
    if (timer || disposed) return
    timer = setInterval(() => { void tick() }, tickMs)
    if (typeof timer === 'object' && timer && typeof timer.unref === 'function') timer.unref()
    void tick()
  }

  function stop() {
    disposed = true
    if (timer) clearInterval(timer)
    timer = null
    settling.clear()
  }

  /** Ask for an immediate pass (settings/actions changed the budget). */
  function kick() {
    if (disposed) return
    const handle = setTimeout(() => { void tick() }, 20)
    if (handle && typeof handle.unref === 'function') handle.unref()
  }

  async function tick() {
    if (ticking || disposed) return
    ticking = true
    try {
      await syncExternalSessions()
      scheduleBoundedSessionBackfill()
      await scanRunning()
      await reconcileEndedSessions()
      await claimPending()
    } catch (error) {
      log('tick failed:', errorMessage(error))
    } finally {
      ticking = false
    }
  }

  /**
   * Mirror DSH workspace sessions onto the board.
   *
   * First run pins `syncSince` to 24 hours ago (persisted) so the board shows
   * recent workspace sessions immediately, while older history stays out.
   * Later runs only import sessions updated at or after that instant;
   * already-imported rows are deduplicated by sessionId and follow the live
   * running/idle state afterwards.
   */
  async function syncExternalSessions(now = Date.now()) {
    let since = store.syncSince
    if (!Number.isFinite(since)) {
      since = store.setSyncSince(now - FIRST_SYNC_WINDOW_MS)
    }
    const items = await bridge.listItems()
    if (items.length === 0) return

    const bySession = new Map()
    for (const task of store.tasks) {
      if (task.sessionId) bySession.set(task.sessionId, task)
    }

    // Status transitions for rows we already imported.
    for (const item of items) {
      const task = bySession.get(item.sessionId)
      if (!task || task.source !== 'session') continue
      if (item.running && task.status !== 'running') {
        store.update(task.id, current => {
          current.status = 'running'
          current.startedAt = now
          delete current.endedAt
          current.updatedAt = item.updatedAt || now
        })
      } else if (!item.running && task.status === 'running') {
        store.update(task.id, current => {
          current.status = 'done'
          current.endedAt = now
          current.updatedAt = item.updatedAt || now
        })
        // v0.6: write the finished DSH session's result back asynchronously;
        // it must never block the sync or the claim pass.
        scheduleSessionBackfill(task.id, true)
      } else if (item.updatedAt && item.updatedAt !== task.updatedAt) {
        store.update(task.id, current => {
          current.updatedAt = item.updatedAt
        })
      }
    }

    // Import sessions the board has never seen.
    const candidates = []
    for (const item of items) {
      if (bySession.has(item.sessionId)) continue
      if (store.isOwnedSession(item.sessionId) || store.isHiddenSession(item.sessionId)) continue
      if (item.blank || item.parentSessionId) continue
      if (!item.cwd) continue
      if (!Number.isFinite(item.updatedAt) || item.updatedAt < since) continue
      candidates.push(item)
    }
    if (candidates.length === 0) return
    candidates.sort((left, right) => right.updatedAt - left.updatedAt)
    for (const item of candidates.slice(0, IMPORT_LIMIT)) {
      let firstMessage = ''
      try {
        firstMessage = await bridge.firstUserMessage(item.sessionId)
      } catch {
        firstMessage = ''
      }
      if (disposed) return
      if (isLegacyOwnedPrompt(firstMessage)) {
        store.hideSession(item.sessionId)
        continue
      }
      const title = importTitle(item, firstMessage)
      store.importSessionTask({
        sessionId: item.sessionId,
        title,
        prompt: title,
        cwd: item.cwd,
        group: store.settings.group,
        status: item.running ? 'running' : 'done',
        createdAt: item.updatedAt,
        updatedAt: item.updatedAt,
      })
    }
  }

  /**
   * One log scan per running/blocked queue task: settle a finished turn, or
   * flip between `running` and `blocked` while the Agent waits for an answer.
   * Paused tasks are deliberately skipped so a cancelled turn cannot settle
   * them by accident.
   */
  async function scanRunning() {
    const tasks = store.tasks.filter(task =>
      task.source === 'queue' && (task.status === 'running' || task.status === 'blocked'))
    if (tasks.length === 0) return
    for (const task of tasks) {
      if (disposed) return
      if (!task.sessionId) {
        if (Date.now() - (task.startedAt || task.createdAt) > staleMs) {
          markFailed(task, '任务未成功创建会话')
        }
        continue
      }
      const scan = await bridge.scan(task.sessionId)
      if (!scan) {
        if (Date.now() - (task.startedAt || task.createdAt) > staleMs) {
          markFailed(task, '任务会话已不存在，执行结果未知')
        }
        continue
      }
      const current = store.find(task.id)
      if (!current) continue
      if (current.status === 'running') {
        if (scan.blocked) {
          const entering = current.status !== 'blocked'
          store.update(current.id, next => {
            next.status = 'blocked'
            next.updatedAt = Date.now()
          })
          if (entering) push('blocked', store.find(current.id))
          continue
        }
      } else if (current.status === 'blocked' && !scan.blocked) {
        store.update(current.id, next => {
          next.status = 'running'
          next.updatedAt = Date.now()
        })
      }
      // Still waiting for the user: turn/end must not settle this task.
      if (scan.blocked) continue
      if (scan.lastTurnEnd && scan.lastTurnEnd.reason) {
        const time = Number.isFinite(scan.lastTurnEnd.time) ? scan.lastTurnEnd.time : Date.now()
        // A turn end at or below this run's baseline belongs to a previous run
        // (retry/resume/pause) and must not settle the current one.
        const baseline = Number.isFinite(current.settleAfterSeq) ? current.settleAfterSeq : 0
        const seq = Number.isFinite(scan.lastTurnEnd.seq) ? scan.lastTurnEnd.seq : baseline + 1
        if (seq > baseline) settleTask(store.find(current.id), scan.lastTurnEnd.reason, time)
      }
    }
  }

  /** Fill the concurrency budget with the earliest pending tasks. */
  async function claimPending() {
    const settings = store.settings
    if (!settings.autoStart) return
    const limit = Math.max(1, Math.min(10, Number(settings.concurrency) || 1))
    let running = queueRunningCount()
    if (running >= limit) return
    const pending = pendingInClaimOrder(store.tasks)
    for (const task of pending) {
      if (disposed || running >= limit) return
      const current = store.find(task.id)
      if (!current || current.status !== 'pending') continue
      // A chained task waits for its upstream task: running it early would
      // hand it an empty result, and a failed upstream makes it unexecutable.
      if (current.chainFrom) {
        const previous = store.find(current.chainFrom)
        if (!previous) {
          markFailed(current, '前置任务不存在')
          continue
        }
        if (previous.status === 'idea' || previous.status === 'pending' ||
          previous.status === 'running' || previous.status === 'paused' ||
          previous.status === 'blocked') {
          continue
        }
        if (previous.status !== 'done') {
          markFailed(current, `前置任务「${previous.title}」未成功完成`)
          continue
        }
      }
      running += 1
      await launch(current)
    }
  }

  function queueRunningCount() {
    return store.tasks.filter(task => task.source === 'queue' && task.status === 'running').length
  }

  async function launch(task) {
    const settings = { ...store.settings }
    store.update(task.id, current => {
      current.status = 'running'
      current.startedAt = Date.now()
      current.settleAfterSeq = 0
      delete current.endedAt
      delete current.error
      delete current.sessionId
      delete current.lastMessage
      delete current.result
      current.updatedAt = Date.now()
      if (settings.provider) current.provider = settings.provider
      if (settings.model) current.model = settings.model
      if (settings.reasoningEffort) current.reasoningEffort = settings.reasoningEffort
    })
    try {
      const sessionId = await bridge.createSession({ cwd: task.cwd })
      // The secretary's own sessions must never be re-imported as workspace ones.
      store.ownSession(sessionId)
      store.update(task.id, current => { current.sessionId = sessionId })
      await bridge.selectModel(sessionId, {
        provider: settings.provider,
        model: settings.model,
        reasoningEffort: settings.reasoningEffort,
      })
      const current = store.find(task.id) || task
      // The session receives exactly the task prompt the user wrote. Retro
      // lessons are kept in the evolution archive and are never injected into
      // the conversation (they polluted the user's own message previously).
      await bridge.prompt(sessionId, await composePrompt(store, bridge, current))
      push('claimed', store.find(task.id) || current)
    } catch (error) {
      const current = store.find(task.id)
      if (current && current.status === 'running') markFailed(current, errorMessage(error))
    }
  }

  /**
   * Manual "run" from the board: claim immediately, ignoring autoStart and the
   * concurrency budget. The caller validates the chained predecessor first.
   */
  async function runTask(task) {
    const current = store.find(task && task.id)
    if (!current || current.status !== 'pending') return current
    await launch(current)
    return store.find(current.id)
  }

  /**
   * Manual "resume" from the board: the Session is kept, so re-admit a prompt
   * that tells the Agent to continue. The new segment gets a fresh startedAt,
   * which also keeps the previous (cancelled) turn from settling this run.
   */
  async function resumeTask(task) {
    const current = store.find(task && task.id)
    if (!current || current.status !== 'paused' || !current.sessionId) return current
    // Everything committed so far belongs to the paused run; only a later turn
    // end may settle the resumed one.
    let baseline = 0
    try {
      const last = await bridge.lastTurnEnd(current.sessionId)
      if (last && Number.isFinite(last.seq)) baseline = last.seq
    } catch {
      baseline = 0
    }
    store.update(current.id, next => {
      next.status = 'running'
      next.startedAt = Date.now()
      next.settleAfterSeq = baseline
      delete next.endedAt
      delete next.error
      next.updatedAt = Date.now()
    })
    try {
      await bridge.prompt(current.sessionId, RESUME_PROMPT)
    } catch (error) {
      const latest = store.find(current.id)
      if (latest && latest.status === 'running') markFailed(latest, errorMessage(error))
    }
    return store.find(current.id)
  }

  /**
   * Admit a chat message from the task drawer.
   *
   * A live running task just receives the message. A finished/paused/other
   * non-running queue task is RE-OPENED: the committed log up to now becomes
   * the new run's baseline, the task moves back to the running column, and the
   * Agent's next turn settles it again when it closes. If the Session cannot
   * take the message (deleted or otherwise unavailable), the task falls back
   * to the claim queue with the follow-up appended to its prompt, so the
   * secretary can rebuild a Session instead of silently dropping the message.
   *
   * @returns the status the task has after admitting the message.
   */
  async function chatIntoTask(task, text) {
    const current = store.find(task && task.id)
    if (!current || current.source !== 'queue' || !current.sessionId) {
      if (current && current.sessionId) await bridge.prompt(current.sessionId, text)
      return current ? current.status : undefined
    }
    if (current.status === 'running' || current.status === 'blocked') {
      await bridge.prompt(current.sessionId, text)
      return current.status
    }
    // Re-open a finished/paused/not-yet-claimed-but-session-bearing task.
    let baseline = 0
    try {
      const last = await bridge.lastTurnEnd(current.sessionId)
      if (last && Number.isFinite(last.seq)) baseline = last.seq
    } catch {
      baseline = 0
    }
    store.update(current.id, next => {
      next.status = 'running'
      next.startedAt = Date.now()
      next.settleAfterSeq = baseline
      delete next.endedAt
      delete next.error
      next.updatedAt = Date.now()
    })
    try {
      await bridge.prompt(current.sessionId, text)
      return 'running'
    } catch (error) {
      const latest = store.find(current.id)
      if (latest) {
        store.update(latest.id, next => {
          next.status = 'pending'
          next.prompt = `${next.prompt}\n\n[后续要求] ${text}`
          delete next.sessionId
          delete next.settleAfterSeq
          delete next.startedAt
          delete next.endedAt
          delete next.error
          next.updatedAt = Date.now()
        })
        kick()
      }
      return 'pending'
    }
  }

  /** Settle one running task from a committed turn end. */
  function settleTask(task, reason, time, seq) {
    if (!task || task.status !== 'running' || settling.has(task.id)) return
    if (task.source === 'session') return
    const baseline = Number.isFinite(task.settleAfterSeq) ? task.settleAfterSeq : 0
    if (Number.isFinite(seq) && seq <= baseline) return
    settling.add(task.id)
    const kind = reason && reason.kind ? reason.kind : 'completed'
    const endedAt = Number.isFinite(time) ? time : Date.now()
    let status = 'done'
    let error
    if (kind === 'completed') {
      status = 'done'
    } else if (kind === 'aborted') {
      status = 'failed'
      error = '任务被中断'
    } else if (kind === 'error') {
      status = 'failed'
      error = errorMessage(reason.error)
    } else if (kind === 'max-tokens') {
      status = 'failed'
      error = '模型输出达到最大 token 限制'
    } else if (kind === 'interrupted') {
      status = 'failed'
      error = '任务被中断'
    } else {
      status = 'failed'
      error = `任务结束原因：${kind}`
    }
    store.update(task.id, current => {
      current.status = status
      current.endedAt = endedAt
      current.updatedAt = Date.now()
      if (error) current.error = error
      else delete current.error
    })
    // Results (final answer, turns, tokens) are read back from the committed
    // log once, so the board can show outcomes without opening the Session.
    if (task.sessionId) void finalizeResult(task.id, endedAt)
    settling.delete(task.id)
  }

  /** Persist the settled session's summary onto its task. */
  async function finalizeResult(taskId, expectedEndedAt) {
    const task = store.find(taskId)
    if (!task || !task.sessionId) return
    let summary
    try {
      summary = await bridge.summarize(task.sessionId)
    } catch {
      return
    }
    const current = store.find(taskId)
    // A retry may have moved the task on; never write a previous run's result.
    if (!current || current.status === 'pending' || current.status === 'running' ||
      current.status === 'paused' || current.status === 'blocked') return
    if (expectedEndedAt && current.endedAt && current.endedAt !== expectedEndedAt) return
    const endedAt = current.endedAt || Date.now()
    const startedAt = current.startedAt || endedAt
    store.update(taskId, settled => {
      const result = {
        finalAnswer: summary.finalAnswer || '',
        turns: summary.turns || 0,
        durationMs: Math.max(0, endedAt - startedAt),
      }
      if (summary.usage) result.usage = summary.usage
      settled.result = result
      settled.updatedAt = Date.now()
      if (result.finalAnswer) settled.lastMessage = bridge.snippet(result.finalAnswer)
    })
    const finalTask = store.find(taskId)
    if (finalTask) push(finalTask.status === 'done' ? 'succeeded' : 'failed', finalTask)
  }

  /**
   * Serialize session-result backfills behind one promise chain so a few log
   * inspections run at most and they never block the scheduler tick.
   */
  function scheduleSessionBackfill(taskId, force = false) {
    if (disposed || !taskId || backfillQueued.has(taskId)) return
    backfillQueued.add(taskId)
    backfillChain = backfillChain
      .then(() => backfillSessionResult(taskId, force))
      .catch(() => {})
      .then(() => { backfillQueued.delete(taskId) })
  }

  /** Bounded per-tick sweep for legacy done session rows that lack a result. */
  function scheduleBoundedSessionBackfill() {
    if (disposed) return
    const selected = selectSessionResultBackfill(store.tasks, BACKFILL_LIMIT)
    for (const task of selected) scheduleSessionBackfill(task.id)
  }

  /**
   * Summarise one finished imported DSH-session task onto its row.
   *
   * `result.durationMs` is deliberately omitted: a session task's
   * startedAt/endedAt are only the mirror-observation timestamps, so a duration
   * would be fabricated (the contract allows it to stay undefined).
   */
  async function backfillSessionResult(taskId, force = false) {
    if (disposed) return
    const task = store.find(taskId)
    if (!task || task.source !== 'session' || !task.sessionId || task.status !== 'done') return
    if (!force && (task.result || Number.isFinite(task.resultBackfillAt))) return
    let scan
    try {
      scan = await bridge.scan(task.sessionId)
    } catch {
      scan = undefined
    }
    if (!scan) {
      markBackfillAttempt(taskId)
      return
    }
    let summary
    try {
      summary = await bridge.summarize(task.sessionId)
    } catch (error) {
      log('session result backfill failed:', errorMessage(error))
      markBackfillAttempt(taskId)
      return
    }
    const current = store.find(taskId)
    if (!current || current.source !== 'session' || current.status !== 'done') return
    store.update(taskId, settled => {
      const result = {
        finalAnswer: summary && typeof summary.finalAnswer === 'string' ? summary.finalAnswer : '',
        turns: summary && Number.isFinite(summary.turns) ? summary.turns : 0,
      }
      if (summary && summary.usage) result.usage = summary.usage
      settled.result = result
      settled.resultBackfillAt = Date.now()
      if (result.finalAnswer) settled.lastMessage = bridge.snippet(result.finalAnswer)
    })
  }

  /** Remember a failed attempt so the same row is not retried on every tick. */
  function markBackfillAttempt(taskId) {
    const current = store.find(taskId)
    if (!current || current.source !== 'session' || current.status !== 'done') return
    store.update(taskId, task => {
      task.resultBackfillAt = Date.now()
    })
  }

  /** Called from the session/event feed; settles the matching running task. */
  const REVIVABLE_STATUSES = new Set(['done', 'failed', 'cancelled', 'paused', 'pending'])
  const RECONCILE_INTERVAL_MS = 15_000
  let lastReconcileAt = 0

  /**
   * Catch sessions that were resumed while the plugin was not listening (or
   * before this code existed): an ended queue task whose Session has a newer
   * human message than the task's end is active again, so the card follows.
   */
  async function reconcileEndedSessions(now = Date.now()) {
    if (now - lastReconcileAt < RECONCILE_INTERVAL_MS) return
    lastReconcileAt = now
    const candidates = store.tasks
      .filter(task => task.source === 'queue' && task.sessionId && REVIVABLE_STATUSES.has(task.status))
      .sort((left, right) => (right.endedAt || right.updatedAt || right.createdAt) - (left.endedAt || left.updatedAt || left.createdAt))
      .slice(0, 20)
    for (const task of candidates) {
      if (disposed) return
      const scan = await bridge.scan(task.sessionId)
      if (!scan || !Number.isFinite(scan.lastUserAt)) continue
      const endedAt = task.endedAt || task.updatedAt || task.createdAt || 0
      if (scan.lastUserAt <= endedAt + 1000) continue
      // If the new conversation turn has already closed, leave the baseline at
      // 0 so the normal settle pass records its result; otherwise keep the old
      // turn end as the baseline so only the upcoming turn settles the task.
      const newTurnClosed = scan.lastTurnEnd && Number.isFinite(scan.lastTurnEnd.time) && scan.lastTurnEnd.time > endedAt
      const baseline = !newTurnClosed && scan.lastTurnEnd && Number.isFinite(scan.lastTurnEnd.seq)
        ? scan.lastTurnEnd.seq
        : 0
      const current = store.find(task.id)
      if (!current || !REVIVABLE_STATUSES.has(current.status)) continue
      store.update(task.id, next => {
        next.status = 'running'
        next.startedAt = Date.now()
        next.settleAfterSeq = baseline
        delete next.endedAt
        delete next.error
        next.updatedAt = Date.now()
      })
    }
  }
  const reviving = new Set()

  /**
   * Resume a finished/paused queue task when the user keeps talking in its
   * Session from the normal DSH conversation UI (not the plugin drawer). The
   * Session log is the source of truth: a committed human message after the
   * task ended means the work is active again, so the card follows it back to
   * 处理中 and the next turn end settles it (with a fresh result) as usual.
   */
  async function reviveFromSession(task) {
    if (!task || !task.sessionId || reviving.has(task.id)) return
    if (task.source !== 'queue' || !REVIVABLE_STATUSES.has(task.status)) return
    reviving.add(task.id)
    try {
      let baseline = 0
      try {
        const last = await bridge.lastTurnEnd(task.sessionId)
        if (last && Number.isFinite(last.seq)) baseline = last.seq
      } catch {
        baseline = 0
      }
      const current = store.find(task.id)
      if (!current || !REVIVABLE_STATUSES.has(current.status)) return
      store.update(task.id, next => {
        next.status = 'running'
        next.startedAt = Date.now()
        next.settleAfterSeq = baseline
        delete next.endedAt
        delete next.error
        next.updatedAt = Date.now()
      })
    } finally {
      reviving.delete(task.id)
    }
  }

  /**
   * One entry point for the Session event feed. `turn/end` settles a running
   * task; an appended human message revives an ended one.
   */
  function onSessionEvent(sessionId, event) {
    if (!event || typeof event !== 'object') return
    if (event.type === 'turn/end') {
      onTurnEnd(sessionId, event.data?.reason, event.seq)
      return
    }
    if (event.type !== 'user/message' || event.surfaceOp !== 'append') return
    if (event.data?.source?.kind !== 'user') return
    const task = store.findBySession(sessionId)
    if (!task) return
    void reviveFromSession(task)
  }

  function onTurnEnd(sessionId, reason, seq) {
    const task = store.findBySession(sessionId)
    if (!task || task.source !== 'queue' || task.status !== 'running') return
    settleTask(task, reason, Date.now(), seq)
  }

  function markFailed(task, message) {
    store.update(task.id, current => {
      current.status = 'failed'
      current.error = message
      current.endedAt = current.endedAt || Date.now()
      current.updatedAt = Date.now()
    })
    if (task.sessionId) void finalizeResult(task.id, store.find(task.id)?.endedAt)
    else push('failed', store.find(task.id))
    settling.delete(task.id)
  }

  function forget(id) {
    settling.delete(id)
  }

  return {
    start,
    stop,
    kick,
    tick,
    onTurnEnd,
    onSessionEvent,
    reviveFromSession,
    reconcileEndedSessions,
    settleTask,
    runTask,
    resumeTask,
    chatIntoTask,
    syncExternalSessions,
    scanRunning,
    claimPending,
    backfillSessionResult,
    forget,
    RESUME_PROMPT,
  }
}

export { TICK_MS, STALE_SESSION_MS, IMPORT_LIMIT, BACKFILL_LIMIT, FIRST_SYNC_WINDOW_MS, RESUME_PROMPT }
export { errorMessage }

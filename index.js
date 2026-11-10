/**
 * dsh-personal-secretary — Host half.
 *
 * Owns the durable board, the scheduler that claims tasks into real Sessions,
 * the import of ordinary DSH workspace sessions, the daily report timer, and
 * the v9 retrospective engine (lessons + distilled skills).
 * The browser half only reads state and asks for mutations over the same-origin
 * HTTP API, so the secretary keeps working while the page is closed.
 */
import { TaskStore } from './host/store.js'
import { createSessionBridge } from './host/session.js'
import { createScheduler } from './host/scheduler.js'
import { createReports } from './host/reports.js'
import { createApi, registerApi } from './host/api.js'
import { registerTool } from './host/tool.js'
import { createWebhook } from './host/webhook.js'
import { createEvolution } from './host/evolution.js'

export const name = 'dsh-personal-secretary'
export const inject = ['webServer', 'sessionController']

export function apply(ctx) {
  const store = new TaskStore()
  const bridge = createSessionBridge(ctx)
  // Webhook notifications are built first so the scheduler, the daily report
  // timer and the HTTP test route all share one delivery queue.
  const webhook = createWebhook({ ctx, store })
  // The retrospective engine is built before the scheduler (per the v9
  // contract): the scheduler only imports pure prompt helpers from it.
  const evolution = createEvolution({ ctx, store, bridge, notify: webhook.notify })
  const scheduler = createScheduler({ ctx, store, bridge, notify: webhook.notify })
  const reports = createReports({ ctx, store, bridge, notify: webhook.notify })

  // First use inherits the deployment's default model, so "auto run" works
  // without visiting the settings row first.
  try {
    if (!store.settings.provider || !store.settings.model) {
      const service = ctx.get('agentDefaultModel')
      const selection = service && typeof service.currentSelection === 'function'
        ? service.currentSelection()
        : undefined
      if (selection && selection.provider && selection.model) {
        store.updateSettings({
          provider: selection.provider,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort ?? null,
        })
      }
    }
  } catch (error) {
    ctx.logger?.warn?.('[personal-secretary] 读取默认模型失败', error)
  }

  const api = createApi({ ctx, store, bridge, scheduler, reports, webhook, evolution })
  ctx.effect(
    () => registerApi(ctx, api),
    'personal-secretary: http api',
  )

  ctx.effect(
    () => registerTool(ctx, { store, scheduler, bridge, reports, operations: api.operations }),
    'personal-secretary: agent tool',
  )

  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session, event) => {
      try {
        scheduler.onSessionEvent(session?.id, event)
      } catch (error) {
        ctx.logger?.warn?.('[personal-secretary] session event failed', error)
      }
    })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, 'personal-secretary: session events')

  ctx.effect(() => {
    scheduler.start()
    return () => scheduler.stop()
  }, 'personal-secretary: scheduler')

  ctx.effect(() => {
    reports.start()
    return () => reports.stop()
  }, 'personal-secretary: daily reports')

  ctx.effect(() => {
    evolution.start()
    return () => evolution.stop()
  }, 'personal-secretary: evolution')

  // The skill service is optional: an older Host without it still runs the
  // plugin, it just cannot expose distilled skills to sessions.
  ctx.effect(() => evolution.registerSkillProvider(), 'personal-secretary: evolution skills')
}

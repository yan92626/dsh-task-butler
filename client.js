/**
 * dsh-personal-secretary — browser half (v0.7).
 *
 * 任务管家：你交代，我盯着。
 *  - 两个一级视图：今日（默认）/ 任务。今日页只保留三块 + 页脚：
 *    问候与一句话快捷捕获、今日简报（摘要 + 今天建议一键加入队列）、
 *    等你处理（≤3 条 + 还有 N 条）、进行中（≤3 条紧凑行），页脚为
 *    「今天完成 N 件 · 查看工作日志 · 任务看板」
 *  - 页头精简：品牌 + 副标题 + 今日/任务分段控件；右侧仅通知铃铛（未读数）、
 *    回顾（技能候选徽标）、设置、新建任务
 *  - 回顾抽屉：日志 / 复盘 / 经验 / 技能四个 tab（日志 = 工作日志；其余复用复盘面板）
 *  - 通知中心：铃铛 popover（等你处理 + 最近动态 + 通知记录入口 + 全部已读），
 *    通知记录弹窗读取 `GET /webhook/log`
 *  - 任务视图：想法 / 队列 / 进行中 / 已结束 四列看板，一行状态条（计数 + 自动执行 +
 *    全局搜索）替代统计卡；每列保留漏斗筛选（x/y），无列内搜索框
 *  - 卡片：身份行 / 两行 Markdown 清洗后的上下文 / 目录·DSH 标签 / 最多三个元信息
 *    （时间·耗时·模型，tokens 与轮次只在 tooltip 和详情抽屉）
 *  - 跨列拖拽（想法 ⇄ 队列）、队列内拖拽排序 + Alt+↑↓、详情抽屉、编辑 / 发布弹窗、
 *    设置（执行 / 桌面提醒 / 消息推送 / 工作日志 / 晨间简报 / 复盘与沉淀 / 数据备份）
 *  - 轮询（refcount、隐藏页暂停）、错误横幅、toast、系统通知、拖拽 + 键盘排序
 *
 * Single-file plain-JS client plugin for the DSH Web GUI:
 *  - registers a `sidebar.panellist` row (id `secretary`, order 5) and the `main` panel
 *    with key `secretary`
 *  - owns its styles (theme tokens only), locale dictionaries and polling loop
 *  - talks to the same-origin Host API under `/secretary/api/`
 *
 * No imports besides `react`; no JSX; no build step.
 */
window.__ModuleLoader__.load({
  id: 'dsh-personal-secretary',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // ------------------------------------------------------------------ constants

    const NS = 'secretary'
    const API = '/secretary/api'
    const POLL_MS = 1500
    const TRANSCRIPT_POLL_MS = 2000
    const REPORT_POLL_MS = 2500
    const ERROR_VISIBLE_MS = 6000
    const TOAST_VISIBLE_MS = 4200
    const MAX_TOASTS = 3
    const MAX_TITLE_LENGTH = 120
    const MAX_BATCH_ITEMS = 100
    const MAX_CONCURRENCY = 10

    const STATUS_VALUES = ['idea', 'pending', 'running', 'paused', 'blocked', 'done', 'failed', 'cancelled']
    const CLAIMED_STATUSES = ['running', 'paused', 'blocked']
    const ENDED_STATUSES = ['done', 'failed', 'cancelled']
    const RUNNING_STATUSES = ['running', 'blocked']
    const DRAGGABLE_STATUSES = ['idea', 'pending']
    const PRIORITY_VALUES = ['urgent', 'high', 'normal', 'low']
    const DEFAULT_PRIORITY = 'normal'
    const COLUMN_KEYS = ['idea', 'pending', 'claimed', 'ended']
    const WEBHOOK_FORMATS = ['generic', 'feishu', 'wecom', 'dingtalk', 'slack']
    const WEBHOOK_EVENT_KEYS = ['claimed', 'succeeded', 'blocked', 'failed', 'dailyReport', 'morningBrief', 'retrospective']
    const COLUMN_STATUS_FILTERS = { claimed: CLAIMED_STATUSES.slice(), ended: ENDED_STATUSES.slice() }

    /* v9: self-evolution / retrospectives */
    const BRIEF_POLL_MS = 2500
    const LAST_SEEN_KEY = 'dsh-ps-last-seen'
    const FOCUS_SIZE = 3
    const FOCUS_ROTATE = 3
    const TODAY_DONE_MAX = 5
    const NOTIF_WAITING_MAX = 4
    const NOTIF_RECENT_MAX = 6
    const NOTIF_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000
    const EVOLUTION_POLL_MS = 3000
    const EVOLUTION_INTERVALS = ['daily', 'weekly']
    const EVOLUTION_SKILL_MODES = ['off', 'ask', 'auto']
    const EVOLUTION_SCOPES = ['global', 'project']
    const EVOLUTION_LESSON_CATEGORIES = ['correction', 'error', 'preference', 'process', 'other']
    const EVOLUTION_SKILL_STATUSES = ['proposed', 'active', 'disabled']
    const EVOLUTION_STATUSES = ['idle', 'running', 'ok', 'failed']
    const EVOLUTION_TAB_KEYS = ['retrospective', 'lessons', 'skills']
    const REVIEW_TAB_KEYS = ['journal', 'retrospective', 'lessons', 'skills']
    const MAX_LESSON_LENGTH = 260
    const WEEKDAY_KEYS = ['weekdaySun', 'weekdayMon', 'weekdayTue', 'weekdayWed', 'weekdayThu', 'weekdayFri', 'weekdaySat']

    // ------------------------------------------------------------------ dictionaries

    const zh = {
      panelTitle: '任务管家',
      subtitle: '你交代，我盯着',
      review: '回顾',
      reviewSub: '日志、复盘、经验与技能',
      todayBrief: '今日简报',
      journalTab: '日志',
      briefSuggest: '今天建议',
      briefJoin: '加入队列',
      briefJoined: '已加入队列「{title}」',
      todayFooterDone: '今天完成 {count} 件',
      viewJournal: '查看工作日志',
      moreItems: '还有 {count} 条',
      briefYesterdayLog: '查看昨日日志',
// ---- v0.6: today view / briefs / notifications
      viewToday: '今日',
      viewTasks: '任务',
      viewSwitchAria: '一级视图',
      greetingMorning: '早安，今天也交给我。你只需要决定，先做哪一件。',
      onWatch: '我在盯着',
      todayProcessed: '今日已处理 {count} 件',
      todayNeedYouCount: '待你处理 {count} 件',
      capturePlaceholder: '交代一件事…回车记下，稍后安排',
      captureSubmit: '记下',
      captureSaving: '记录中…',
      captureSaved: '已记下，稍后在「想法」里安排',
      captureNoCwd: '还没有可用的工作目录，请先在任务看板里选择一个目录。',
      briefCardTitle: '晨间简报',
      briefView: '查看全文',
      briefGenerate: '立即生成',
      briefGenerating: '正在生成晨报…',
      briefNoToday: '今天还没有晨报',
      briefOff: '晨间简报已关闭',
      briefGoSettings: '去设置',
      briefNextAt: '下次自动生成 {time}',
      briefReady: '晨报已生成',
      briefUnsupported: '当前 Host 版本不支持晨间简报',
      needsYou: '待你处理',
      needsYouEmpty: '今天没有需要你拍板的事，剩下的我盯着。',
      waitBlocked: '等你回复',
      waitBlockedHint: '等待你的回答或审批 · 已等 {duration}',
      waitPaused: '已暂停',
      waitPausedHint: '暂停中 · 点「继续」接着跑',
      waitFailed: '失败待重试',
      waitFailedHint: '上一次执行失败 · {time}',
      waitSkillCandidates: '{count} 个技能候选待采纳',
      waitSkillHint: '复盘沉淀的技能，采纳后所有会话可用',
      waitViewCandidates: '查看候选',
      todayFocus: '今日焦点',
      focusShuffle: '换一批',
      focusEmpty: '还没有可排的事。用上面输入框记一件，或去任务看板新建。',
      focusReasonChain: '承接「{title}」',
      focusReasonPriority: '优先级高',
      focusReasonPending: '已在队列排队',
      focusReasonIdea: '想法待排期',
      focusRunNow: '立即执行',
      todayRunning: '进行中',
      runningEmpty: '目前没有正在跑的任务。队列会按顺序自动执行。',
      todayDone: '今日完成',
      doneEmpty: '今天还没有完成的任务。',
      doneTotal: '今天共完成 {count} 件 · 查看全部',
      doneNoResult: '无结果摘要',
      todayLedger: '今日小账',
      ledgerDone: '完成',
      ledgerRunning: '进行中',
      ledgerWaiting: '待你处理',
      ledgerTokens: '今日 tokens',
      ledgerWeek: '本周完成 {count} 件',
      shortcuts: '快捷入口',
      shortcutBoard: '任务看板',
      shortcutEvolution: '复盘',
      shortcutLessons: '经验',
      webhookCardTitle: '消息推送',
      webhookEnabled: '已开启',
      webhookDisabled: '已关闭',
      webhookLog: '查看通知记录',
      notifications: '通知',
      notificationsAria: '通知中心',
      recentActivity: '最近动态',
      markAllRead: '全部标记已读',
      noActivity: '暂时没有新动态',
      notificationLogTitle: '通知记录',
      notificationLogSub: '最近 20 次 Webhook 投递结果',
      notificationLogEmpty: '还没有投递记录',
      notificationLogFailed: '通知记录加载失败',
      notificationLogRefresh: '刷新',
      notificationUnread: '{count} 条未读',
      notificationRead: '已全部读完',
      briefsTitle: '晨间简报',
      briefsSub: '每天由 AI 汇总昨日进展与今日焦点',
      briefsLoading: '正在加载晨报…',
      briefsEmpty: '还没有晨报',
      briefsEmptyHint: '生成今天的晨间简报，之后会显示在这里。',
      briefsSelect: '选择左侧的晨报查看内容',
      briefsContentLoading: '正在加载晨报内容…',
      briefsLoadFailed: '晨报列表加载失败',
      briefsContentFailed: '晨报内容加载失败',
      briefsGenerate: '立即生成今天',
      briefsRegenerate: '重新生成',
      briefsGenerated: '晨报已生成',
      briefsGenerateFailed: '晨报生成失败',
      briefsRefresh: '刷新',
      briefsToday: '今天',
      briefsNoSelection: '请选择一份晨报',
      briefsEmptyContent: '晨报为空',
      briefLast: '最近状态',
      briefLastDate: '最近日期',
      briefErrorLabel: '最近错误',
      briefGenerateNow: '立即生成',
      briefGenerateDone: '晨报已生成',
      briefGenerateFail: '晨报生成失败',
      briefSettingsTitle: '晨间简报设置',
      briefSettingsSub: '定时生成与输出目录',
      briefEnable: '启用晨间简报',
      briefEnableHint: '按设定的时间自动生成晨报',
      briefTime: '生成时间',
      briefTimeHint: '24 小时制 HH:mm（00:00–23:59）',
      briefTimeInvalid: '晨报时间必须是 24 小时制 HH:mm',
      briefDir: '输出目录',
      briefDirHint: '晨报 Markdown 会写入这个目录，生成时自动创建。',
      briefDirInvalid: '晨报目录不合法',
      briefStatusIdle: '尚未生成',
      briefStatusRunning: '生成中',
      briefStatusOk: '生成成功',
      briefStatusFailed: '生成失败',
      webhookEventMorningBrief: '晨报生成',
      running: '执行中',
      runningPill: '执行中 {running} / {limit}',
      autoStart: '自动执行',
      autoStartHint: '队列中的任务按顺序自动执行',
      settings: '设置',
      settingsTitle: '设置',
      settingsSub: '执行、提醒、推送、工作日志与复盘设置',
      publish: '新建任务',
      reportsTitle: '工作日志',
      reportsSub: '每天汇总真实任务与会话内容',
      reportsLoading: '正在加载工作日志…',
      reportsEmpty: '还没有工作日志',
      reportsEmptyHint: '生成今天的工作日志，之后会显示在这里。',
      reportsSelect: '选择左侧的工作日志查看内容',
      reportsContentLoading: '正在加载工作日志内容…',
      reportsLoadFailed: '工作日志列表加载失败',
      reportsContentFailed: '工作日志内容加载失败',
      reportGenerate: '立即生成今天',
      reportRegenerating: '重新生成',
      reportGenerating: '生成中…',
      reportGenerated: '工作日志已生成',
      reportGenerateFailed: '工作日志生成失败',
      reportRefresh: '刷新',
      reportToday: '今天',
      reportStatusIdle: '尚未生成',
      reportStatusRunning: '生成中',
      reportStatusOk: '生成成功',
      reportStatusFailed: '生成失败',
      reportLastStatus: '最近状态',
      reportLastDate: '最近日期',
      reportDir: '输出目录',
      reportDirHint: '工作日志 Markdown 会写入这个目录，生成时自动创建。',
      reportTime: '执行时间',
      reportTimeHint: '24 小时制 HH:mm（00:00–23:59）',
      reportTimeInvalid: '执行时间必须是 24 小时制 HH:mm（00:00–23:59）',
      reportEnable: '启用工作日志',
      reportEnableHint: '按设定的时间自动生成每日工作日志',
      reportSettingsTitle: '工作日志设置',
      reportSettingsSub: '定时生成与输出目录',
      reportGenerateNow: '立即生成',
      reportError: '最近错误',
      reportNoSelection: '请选择一份工作日志',
      reportBytes: '{size}',
      reportDate: '日期',
      reportSaved: '工作日志设置已保存',
      kpiPending: '队列',
      kpiRunning: '执行中',
      kpiDone: '已完成',
      kpiFailed: '失败',
      kpiIdea: '想法',
      kpiProcessing: '进行中',
      kpiIdeaSub: '想法与暂不开展',
      kpiAutoStartOn: '自动执行 开',
      kpiAutoStartOff: '自动执行 关',
      kpiConcurrency: '并发 {running} / {limit}',
      kpiTodayPlus: '今日 +{count}',
      kpiTodayNone: '无',
      kpiGroupLabel: '统计',
      kpiModuleAria: '{label}：{value}',
      columnPending: '队列',
      columnClaimed: '进行中',
      columnEnded: '已结束',
      columnPendingHint: '队列按顺序自动执行，也可以手动立即执行',
      columnPendingDragHint: '拖动排序 · Alt+↑↓',
      columnClaimedHint: '执行中 / 已暂停 / 等你回复',
      columnEndedHint: '完成、失败与取消的记录',
      emptyPendingColumn: '暂无队列中的任务',
      emptyPendingColumnHint: '新建任务后会出现在这里',
      emptyClaimedColumn: '没有进行中的任务',
      emptyClaimedColumnHint: '自动或手动执行后会出现在这里',
      emptyEndedColumn: '还没有已结束的任务',
      emptyEndedColumnHint: '完成、失败或取消的任务会留在这里',
      filterEmptyTitle: '没有匹配的任务',
      filterEmptyHint: '换一个关键词或筛选条件试试。',
      filterReset: '清除筛选',
      filterAll: '全部',
      filterLabel: '状态筛选',
      dropHere: '拖到这里',
      dragHandle: '拖动排序',
      position: '第 {index} 位',
      openTask: '查看任务详情',
      openSession: '打开会话',
      run: '执行',
      runNext: '下一个执行',
      moveUp: '上移',
      moveDown: '下移',
      retry: '重试',
      pause: '暂停',
      resume: '继续',
      interrupt: '停止本轮',
      delete: '删除',
      deleteTask: '删除任务',
      edit: '编辑',
      view: '查看',
      statusPending: '队列中',
      statusRunning: '执行中',
      statusPaused: '已暂停',
      statusBlocked: '等你回复',
      statusDone: '已完成',
      statusFailed: '失败',
      statusCancelled: '已取消',
      badgeBlocked: '等你回复',
      blockedNote: '等待你的回答或审批',
      badgeSession: 'DSH 会话',
      runningFor: '已运行 {duration}',
      durationChip: '耗时 {duration}',
      tokensChip: '{tokens} tokens',
      chainShort: '承接',
      chainTitle: '承接自「{title}」',
      chainFromLabel: '承接上一任务',
      chainFromNone: '不承接',
      justNow: '刚刚',
      minutesAgo: '{count} 分钟前',
      hoursAgo: '{count} 小时前',
      daysAgo: '{count} 天前',
      overview: '概览',
      taskPrompt: '任务描述',
      resultTitle: '执行结果',
      resultRunning: '任务执行中，完成后会显示最终结果。',
      resultEmpty: '暂无执行结果。',
      resultCopy: '复制结果',
      copied: '已复制',
      copyFailed: '复制失败',
      errorLabel: '错误信息',
      cwd: '工作目录',
      model: '模型',
      noModel: '未指定',
      status: '状态',
      sourceLabel: '来源',
      createdAt: '创建时间',
      startedAt: '开始时间',
      endedAt: '结束时间',
      duration: '执行耗时',
      turns: '对话轮次',
      tokens: 'Tokens',
      tokensUsage: '输入 {input} · 输出 {output}',
      tokensUsageCache: '输入 {input} · 输出 {output} · 缓存 {cache}',
      chat: '任务对话',
      chatPlaceholder: '继续与任务对话…',
      send: '发送',
      sending: '发送中…',
      chatDisabled: '任务尚未开始，暂时不能对话。',
      chatReadOnly: 'DSH 会话为只读导入，请打开会话继续。',
      chatEmpty: '暂无对话内容。',
      transcriptLoading: '加载对话…',
      transcriptEmptyTask: '任务开始后，这里会显示执行过程。',
      transcriptFailed: '对话加载失败',
      chatFailed: '发送失败',
      chatReviveHint: '发送消息会重新启动该任务，卡片将移回「进行中」；会话不可用时将重新排队',
      chatContinueHint: '发送消息将继续该任务',
      chatRevivedRunning: '任务已重新开始，已移回「进行中」',
      chatRevivedPending: '任务已重新排队，稍后会自动执行',
      roleUser: '用户',
      roleAssistant: '助手',
      confirming: '确认删除',
      backToList: '返回列表',
      close: '关闭',
      dismiss: '知道了',
      saving: '保存中…',
      publishTitle: '新建任务',
      publishSubtitle: '新任务默认放进想法，确认后再加入队列执行。',
      modeSingle: '单个',
      modeBatch: '批量',
      fieldTitle: '标题',
      fieldTitlePlaceholder: '例如：修复登录页样式',
      fieldPrompt: '任务描述',
      fieldPromptPlaceholder: '描述要完成的工作、约束与验收标准…',
      fieldCwd: '工作目录',
      fieldCwdPlaceholder: '绝对路径，例如 /Users/me/project',
      chooseDirectory: '选择目录',
      choosing: '选择中…',
      batchLabel: '任务列表',
      batchPlaceholder: '每行一个任务，格式：标题 | 描述\n例如：\n修复登录页样式 | 修复移动端错位问题\n补写单元测试',
      batchHint: '每行一个任务；用「|」分隔标题与描述，未分隔时整行作为标题',
      batchCount: '共 {count} 个任务',
      batchOverflow: '一次最多创建 {max} 个任务',
      chainSwitch: '承接上一任务的结果',
      chainHint: '将「{title}」的执行结果拼接到本任务开头',
      chainHintBatch: '整批任务按顺序串联，后一个承接前一个的结果',
      chainHintNone: '队列里还没有可承接的任务',
      required: '标题、描述和工作目录均为必填项',
      batchRequired: '请至少填写一个任务',
      titleTooLong: '标题不能超过 {max} 个字符',
      cwdInvalid: '工作目录必须是绝对路径',
      submit: '创建',
      submitting: '创建中…',
      cancel: '取消',
      publishSuccess: '已创建 {count} 个任务',
      publishSuccessOne: '已创建 1 个任务',
      editTitle: '编辑任务',
      editSubtitle: '修改标题、描述、目录或承接关系。',
      editSubmit: '保存修改',
      editSubmitting: '保存中…',
      editSuccess: '任务已更新',
      editRunning: '执行中的任务不能编辑，请先暂停。',
      fieldChain: '承接上一任务',
      concurrency: '全局并发',
      concurrencyHint: '同时执行的任务数（1–10）',
      defaultModel: '默认模型',
      reasoningEffort: '思考强度',
      effortDefault: '模型默认',
      notifyOnDone: '任务完成通知',
      notifyOnDoneHint: '队列跑完时发送系统通知与面板提示',
      notifyDenied: '浏览器已拒绝通知权限，将只在面板内提示。',
      notifyUnsupported: '当前环境不支持系统通知，将只在面板内提示。',
      provider: 'Provider',
      modelId: '模型 ID',
      modelsLoading: '正在加载模型…',
      modelsUnavailable: '模型目录不可用',
      modelsUnavailableHint: '仍可手动填写 provider 与模型 ID。',
      current: '当前',
      loadFailed: '加载失败',
      loadingState: '正在加载任务…',
      stateLoadFailed: '状态刷新失败',
      publishFailed: '新建失败',
      settingsFailed: '设置保存失败',
      actionFailed: '操作失败',
      reorderFailed: '排序保存失败',
      reorderSaving: '正在保存顺序…',
      modelsLoadFailed: '模型目录加载失败',
      modelsInvalid: '模型目录返回了无效数据',
      pickFailed: '选择目录失败',
      openSessionFailed: '打开会话失败',
      notifyTitle: '任务管家 · 任务完成',
      notifyBody: '成功 {done} 个 · 失败 {failed} 个',
      notifyToast: '任务跑完了：成功 {done} 个 · 失败 {failed} 个',
      runStarted: '已开始执行「{title}」',
      pausedToast: '已暂停「{title}」',
      resumedToast: '已继续「{title}」',
      interruptedToast: '已停止本轮「{title}」',
      retriedToast: '已重新排队「{title}」',
      blockedHint: '等你回复：在会话里回答问题或审批后，任务会继续；也可以打开会话处理。',
      pausedHint: '已暂停：继续会向会话投递「继续完成该任务」。',
      noTasksYet: '暂无任务',
      queued: '队列中',
      emptyTitle: '还没有任务',
      emptyHint: '把要做的事写下来，我会按顺序安排执行；也可以批量粘贴一组任务。',
      emptyCta: '新建任务',
      emptyCtaBatch: '批量创建',
      crashTitle: '任务管家面板出错了',
      crashHint: '切换页面或刷新后重试；如果问题持续出现，请把控制台里的错误信息反馈给插件作者。',
      searchPlaceholder: '搜索全部任务…',
      searchClear: '清除搜索',
      showSessions: 'DSH 会话',
      unknownError: '未知错误',

      /* v4: 想法 + 优先级 + 设置弹窗 + 跨列拖拽 */
      statusIdea: '想法',
      columnIdeas: '想法',
      columnIdeasHint: '想法与暂不开展的任务 · 想好了拖到队列',
      emptyIdeasColumn: '还没有想法任务',
      emptyIdeasColumnHint: '想法、暂不开展的任务都可以先放在这里',
      emptyIdeasColumnAction: '记一个',
      ideaHint: '想法任务不会自动执行；拖到「队列」或点「加入队列」后才开始执行。',
      badgeIdea: '想法',
      priorityLabel: '优先级',
      priorityUrgent: '紧急',
      priorityHigh: '高',
      priorityNormal: '普通',
      priorityLow: '低',
      priorityAll: '全部优先级',
      filterPriorityLabel: '按优先级筛选',
      fieldStatus: '放入',
      fieldStatusHint: '想法任务不会自动执行，确认后再加入队列',
      statusOptionIdea: '想法',
      statusOptionPending: '队列',
      promote: '加入队列',
      demote: '退回想法',
      promotedToast: '已将「{title}」加入队列',
      demotedToast: '已将「{title}」退回想法',
      dragToPending: '放到队列',
      dragToIdeas: '放到想法',
      dragNotAllowed: '这一列不接受该任务',
      createdChip: '创建 {time}',
      updatedChip: '更新 {time}',
      updatedAt: '更新时间',
      settingsSectionExecution: '执行',
      settingsExecutionSub: '并发、默认模型与自动执行',
      settingsSectionNotify: '桌面提醒',
      settingsNotifySub: '任务跑完时的提醒方式',
      settingsSectionReport: '工作日志',
      settingsReportSub: '定时生成与输出目录',
      settingsDone: '完成',
      settingsAutoSave: '修改会立即保存',
      settingsSectionBackup: '数据备份',
      settingsSectionWebhook: '消息推送',
      webhookSub: '任务、工作日志与晨报的关键进展推送到 Webhook（Markdown）',
      webhookEnableLabel: '启用消息推送',
      webhookEnableHint: '开启后按选择的事件推送；关闭时可先填写配置并发送测试',
      webhookUrl: 'Webhook 地址',
      webhookUrlPlaceholder: 'https://example.com/webhook',
      webhookUrlRequired: '启用前请填写 Webhook 地址',
      webhookUrlInvalid: 'Webhook 地址必须是 http(s) URL',
      webhookFormat: '消息格式',
      webhookFormatHint: '按接收端选择 payload 格式',
      webhookFormatGeneric: '通用 JSON',
      webhookFormatFeishu: '飞书',
      webhookFormatWecom: '企业微信',
      webhookFormatDingtalk: '钉钉',
      webhookFormatSlack: 'Slack',
      webhookEvents: '推送事件',
      webhookEventClaimed: '任务开始执行',
      webhookEventSucceeded: '执行成功',
      webhookEventBlocked: '任务等你回复',
      webhookEventFailed: '任务失败',
      webhookEventDailyReport: '工作日志生成',
      webhookEventRetrospective: '复盘生成',
      webhookEventTest: '测试通知',
      webhookTest: '发送测试通知',
      webhookTesting: '发送中…',
      webhookTestSent: '测试通知已发送',
      webhookTestFailed: '测试通知发送失败',
      webhookTestHint: '填写有效的 Webhook 地址后可发送测试',
      webhookLastLine: '最近：{status} · {time} · {event}',
      webhookLastLineIdle: '最近：暂无记录',
      webhookStatusOk: '成功',
      webhookStatusFailed: '失败',
      webhookSectionAria: '消息推送设置',
      backupSub: '自动保存的恢复点，可随时恢复',
      backupLoading: '正在加载备份…',
      backupEmpty: '暂无备份',
      backupSummary: '自动备份：最近 {count} 份 · 最近一次 {time}（含 {tasks} 个任务）',
      backupRefresh: '刷新',
      backupRefreshing: '刷新中…',
      backupRestore: '恢复',
      backupRestoreConfirm: '确认',
      backupRestoreCancel: '取消',
      backupConfirmPrompt: '确认恢复？',
      backupRestoreWarning: '恢复会用该备份覆盖当前任务与设置；当前数据也会自动备份一份，可再次恢复。',
      backupRestoring: '恢复中…',
      backupRestored: '已恢复到 {time} 的备份',
      backupLoadFailed: '备份列表加载失败',
      backupRestoreFailed: '恢复失败',
      backupTaskCount: '{count} 个任务',
      backupRefreshAria: '刷新备份列表',
      backupRestoreAria: '恢复 {time} 的备份',
      publishIdeaSuccess: '已放入想法 {count} 个任务',
      publishIdeaSuccessOne: '已放入想法 1 个任务',

      /* v6: per-column search/filter + 24h time + uniform card zones */
      columnFilterLabel: '筛选{column}',
      filterStatus: '状态',
      filterPriority: '优先级',
      filterSource: '来源',
      sourceQueue: '队列任务',
      sourceSession: 'DSH 会话',
      sourceSessionDisabled: '这一列不包含 DSH 会话',
      filterClear: '清除筛选',
      filterEmptyHint: '换一个关键词或筛选条件试试。',
      filterEmptyClear: '清除筛选/搜索',
      turnsChip: '{count} 轮',
      contextEmpty: '—',

      /* v9: self-evolution / retrospectives / lessons / skills */
      evolution: '复盘与沉淀',
      evolutionTitle: '复盘与沉淀',
      evolutionSub: '复盘任务进展，沉淀经验规则与可复用技能',
      evolutionButton: '复盘',
      retrospective: '复盘',
      retrospectives: '复盘',
      retrospectiveNow: '立即复盘',
      retrospectiveGenerating: '复盘中…',
      retrospectiveEmpty: '还没有复盘',
      retrospectiveEmptyHint: '到点会自动复盘，也可以立即生成一份。',
      retrospectiveSelect: '选择左侧的复盘查看内容',
      retrospectiveLoading: '正在加载复盘…',
      retrospectiveEmptyContent: '复盘为空',
      retrospectiveContentLoading: '正在加载复盘内容…',
      retrospectiveLoadFailed: '复盘列表加载失败',
      retrospectiveContentFailed: '复盘内容加载失败',
      retrospectiveGenerated: '复盘已生成',
      retrospectiveGenerateFailed: '复盘生成失败',
      retrospectiveSkipped: '本期没有需要复盘的任务',
      retrospectiveNothing: '没有需要复盘的任务',
      retrospectiveRefresh: '刷新复盘列表',
      retrospectiveLastStatus: '最近状态',
      retrospectiveLastDate: '最近复盘',
      retrospectiveError: '最近错误',
      retrospectiveTabAria: '复盘列表，共 {count} 份',
      evolutionLoading: '正在加载复盘与沉淀数据…',
      evolutionLoadFailed: '复盘与沉淀数据加载失败',
      evolutionStatusIdle: '尚未复盘',
      evolutionStatusRunning: '复盘中',
      evolutionStatusOk: '复盘成功',
      evolutionStatusFailed: '复盘失败',
      lessonTab: '经验',
      lessons: '经验规则',
      lessonEmpty: '还没有经验规则，复盘后会在这里沉淀',
      lessonEmptyHint: '复盘或手动添加后，规则会出现在这里。',
      lessonAdd: '添加经验',
      lessonText: '经验内容',
      lessonTextPlaceholder: '例如：给本仓库跑测试必须用 node tests/static-check.mjs，不要用 npm test',
      lessonTextRequired: '请填写经验内容',
      lessonTextTooLong: '经验内容不能超过 {max} 个字符',
      lessonCategory: '分类',
      lessonScope: '作用域',
      lessonProject: '项目目录',
      lessonProjectRequired: '项目作用域必须填写绝对目录',
      lessonEvidence: '证据',
      lessonSource: '来源',
      lessonSourceRetrospective: '复盘沉淀',
      lessonSourceManual: '手动添加',
      lessonActive: '已启用',
      lessonInactive: '已停用',
      lessonEnable: '启用',
      lessonDisable: '停用',
      lessonDelete: '删除经验',
      lessonDeleteConfirm: '确认删除？',
      lessonAdded: '经验已添加',
      lessonUpdated: '经验已更新',
      lessonDeleted: '经验已删除',
      lessonCount: '{count} 条经验',
      lessonAddFailed: '添加经验失败',
      lessonUpdateFailed: '更新经验失败',
      lessonDeleteFailed: '删除经验失败',
      lessonFormHint: '规则只作存档查阅，不会注入任务提示词；新建任务时可手动引用。',
      categoryCorrection: '用户纠正',
      categoryError: '错误',
      categoryPreference: '偏好',
      categoryProcess: '流程',
      categoryOther: '其他',
      scopeGlobal: '全局',
      scopeProject: '项目',
      skillTab: '技能',
      skills: '技能',
      skillCandidates: '技能候选',
      skillEmpty: '还没有技能',
      skillEmptyHint: '复盘发现可复用的重复模式后，会在这里生成技能候选。',
      skillStatusProposed: '待采用',
      skillStatusActive: '已启用',
      skillStatusDisabled: '已停用',
      skillAdopt: '采用',
      skillAdopted: '技能已采用',
      skillEnable: '启用',
      skillDisable: '停用',
      skillEnabled: '技能已启用',
      skillDisabled: '技能已停用',
      skillDelete: '删除技能',
      skillDeleteConfirm: '确认删除？',
      skillDeleted: '技能已删除',
      skillContent: '技能内容',
      skillContentLoading: '正在加载技能内容…',
      skillContentFailed: '技能内容加载失败',
      skillContentEmpty: '技能内容为空',
      skillWhenToUse: '适用时机',
      skillDescription: '说明',
      skillName: '名称',
      skillScope: '作用域',
      skillSource: '来源',
      skillEvidence: '证据',
      skillSourceRetrospective: '复盘生成',
      skillSourceManual: '手动添加',
      skillProposedHint: '采用后会进入 DSH 技能目录，模型可按需加载。',
      skillView: '查看',
      skillHide: '收起',
      skillViewAria: '查看技能 {name}',
      skillAdoptFailed: '采用技能失败',
      skillActionFailed: '技能操作失败',
      skillsExplainer: '技能会出现在所有 DSH 会话的技能目录中，模型按需加载',
      skillsUnavailable: '当前 Harness 未提供技能服务',
      skillModeOff: '技能沉淀已在设置中关闭',
      skillModeOffHint: '模式为「关闭」时，复盘不会生成技能候选。',
      skillCandidateBadge: '有 {count} 个技能候选待采用',
      skillCandidateBadgeNone: '没有技能候选待采用',
      tabRetro: '复盘',
      tabLessons: '经验',
      tabSkills: '技能',
      tabLessonsAria: '经验规则，共 {count} 条',
      tabSkillsAria: '技能，{count} 个待采用',
      evolutionEnable: '启用自动复盘',
      evolutionEnableHint: '按设定的时间自动复盘任务进展',
      evolutionInterval: '复盘频率',
      intervalDaily: '每天',
      intervalWeekly: '每周',
      evolutionTime: '复盘时间',
      evolutionTimeHint: '24 小时制 HH:mm（00:00–23:59）',
      evolutionTimeInvalid: '复盘时间必须是 24 小时制 HH:mm（00:00–23:59）',
      evolutionWeekday: '星期',
      weekdaySun: '周日',
      weekdayMon: '周一',
      weekdayTue: '周二',
      weekdayWed: '周三',
      weekdayThu: '周四',
      weekdayFri: '周五',
      weekdaySat: '周六',
      evolutionSkillMode: '技能沉淀模式',
      skillModeOffLabel: '关闭',
      skillModeAsk: '生成候选',
      skillModeAuto: '自动启用',
      evolutionSkillModeHint: '候选需要手动采用；自动启用会直接进入技能目录。',
      evolutionDir: '复盘目录',
      evolutionDirHint: '复盘 Markdown 会写入这个目录，生成时自动创建。',
      evolutionSection: '复盘与沉淀',
      evolutionSectionSub: '复盘任务、沉淀经验与技能',
      evolutionLast: '最近复盘',
      evolutionLastPending: '尚未复盘',
      evolutionGenerating: '复盘中',
      evolutionGenerateNow: '立即复盘',
      enable: '启用',
      disable: '停用',
    }

    const en = {
      panelTitle: 'Task Butler',
      subtitle: 'You delegate; I keep watch',
      review: 'Review',
      reviewSub: 'Work logs, retrospectives, lessons and skills',
      todayBrief: 'Today’s brief',
      journalTab: 'Journal',
      briefSuggest: 'Today’s suggestions',
      briefJoin: 'Add to queue',
      briefJoined: 'Added “{title}” to the queue',
      todayFooterDone: '{count} done today',
      viewJournal: 'View work log',
      moreItems: '{count} more',
      briefYesterdayLog: 'View yesterday’s log',
// ---- v0.6: today view / briefs / notifications
      viewToday: 'Today',
      viewTasks: 'Tasks',
      viewSwitchAria: 'Primary views',
      greetingMorning: 'Good morning — leave it to me. You only decide what comes first.',
      onWatch: 'On watch',
      todayProcessed: '{count} handled today',
      todayNeedYouCount: '{count} need you',
      capturePlaceholder: 'Delegate something… press Enter to save',
      captureSubmit: 'Save',
      captureSaving: 'Saving…',
      captureSaved: 'Saved to Ideas',
      captureNoCwd: 'No workspace folder yet — pick one on the task board first.',
      briefCardTitle: 'Morning brief',
      briefView: 'View full text',
      briefGenerate: 'Generate now',
      briefGenerating: 'Generating brief…',
      briefNoToday: 'No brief yet today',
      briefOff: 'Morning brief is off',
      briefGoSettings: 'Open settings',
      briefNextAt: 'Next automatic run {time}',
      briefReady: 'Brief ready',
      briefUnsupported: 'This Host version does not support morning briefs',
      needsYou: 'Needs you',
      needsYouEmpty: 'Nothing needs you today — I keep watching.',
      waitBlocked: 'Waiting for you',
      waitBlockedHint: 'Waiting for your reply or approval · {duration}',
      waitPaused: 'Paused',
      waitPausedHint: 'Paused — choose Continue to resume',
      waitFailed: 'Failed, retry',
      waitFailedHint: 'Last run failed · {time}',
      waitSkillCandidates: '{count} skill candidates to adopt',
      waitSkillHint: 'Distilled from retrospectives; available to every session once adopted',
      waitViewCandidates: 'View candidates',
      todayFocus: 'Today’s focus',
      focusShuffle: 'Shuffle',
      focusEmpty: 'Nothing lined up. Save something above or open the task board.',
      focusReasonChain: 'Continues “{title}”',
      focusReasonPriority: 'High priority',
      focusReasonPending: 'Already queued',
      focusReasonIdea: 'Idea awaiting scheduling',
      focusRunNow: 'Run now',
      todayRunning: 'In progress',
      runningEmpty: 'Nothing running. The queue runs automatically in order.',
      todayDone: 'Done today',
      doneEmpty: 'Nothing finished today yet.',
      doneTotal: '{count} done today · View all',
      doneNoResult: 'No result summary',
      todayLedger: 'Today’s ledger',
      ledgerDone: 'Done',
      ledgerRunning: 'Running',
      ledgerWaiting: 'Needs you',
      ledgerTokens: 'Tokens today',
      ledgerWeek: '{count} done this week',
      shortcuts: 'Shortcuts',
      shortcutBoard: 'Task board',
      shortcutEvolution: 'Retrospectives',
      shortcutLessons: 'Lessons',
      webhookCardTitle: 'Push notifications',
      webhookEnabled: 'On',
      webhookDisabled: 'Off',
      webhookLog: 'View delivery log',
      notifications: 'Notifications',
      notificationsAria: 'Notifications',
      recentActivity: 'Recent activity',
      markAllRead: 'Mark all read',
      noActivity: 'Nothing new yet',
      notificationLogTitle: 'Delivery log',
      notificationLogSub: 'Last 20 webhook deliveries',
      notificationLogEmpty: 'No deliveries yet',
      notificationLogFailed: 'Could not load the delivery log',
      notificationLogRefresh: 'Refresh',
      notificationUnread: '{count} unread',
      notificationRead: 'All read',
      briefsTitle: 'Morning briefs',
      briefsSub: 'A daily AI digest of yesterday and today',
      briefsLoading: 'Loading briefs…',
      briefsEmpty: 'No briefs yet',
      briefsEmptyHint: 'Generate today’s brief; it will show up here.',
      briefsSelect: 'Select a brief on the left',
      briefsContentLoading: 'Loading brief…',
      briefsLoadFailed: 'Could not load briefs',
      briefsContentFailed: 'Could not load the brief',
      briefsGenerate: 'Generate today',
      briefsRegenerate: 'Regenerate',
      briefsGenerated: 'Brief generated',
      briefsGenerateFailed: 'Brief generation failed',
      briefsRefresh: 'Refresh',
      briefsToday: 'Today',
      briefsNoSelection: 'Select a brief',
      briefsEmptyContent: 'The brief is empty',
      briefLast: 'Latest status',
      briefLastDate: 'Latest date',
      briefErrorLabel: 'Latest error',
      briefGenerateNow: 'Generate now',
      briefGenerateDone: 'Brief generated',
      briefGenerateFail: 'Brief generation failed',
      briefSettingsTitle: 'Morning brief settings',
      briefSettingsSub: 'Scheduled generation and output folder',
      briefEnable: 'Enable morning brief',
      briefEnableHint: 'Generate a brief automatically at the configured time',
      briefTime: 'Run at',
      briefTimeHint: '24-hour clock, HH:mm (00:00–23:59)',
      briefTimeInvalid: 'The brief time must use 24-hour HH:mm',
      briefDir: 'Output folder',
      briefDirHint: 'Brief Markdown is written here; created on demand.',
      briefDirInvalid: 'Invalid brief folder',
      briefStatusIdle: 'Not generated yet',
      briefStatusRunning: 'Generating',
      briefStatusOk: 'Generated',
      briefStatusFailed: 'Generation failed',
      webhookEventMorningBrief: 'Morning brief',
      running: 'Running',
      runningPill: 'Running {running} / {limit}',
      autoStart: 'Auto-run',
      autoStartHint: 'Queued tasks start automatically in order',
      settings: 'Settings',
      settingsTitle: 'Settings',
      settingsSub: 'Execution, alerts, push, work logs and retrospectives',
      publish: 'New task',
      reportsTitle: 'Work log',
      reportsSub: 'A daily digest of real task and session work',
      reportsLoading: 'Loading work logs…',
      reportsEmpty: 'No work logs yet',
      reportsEmptyHint: 'Generate today’s work log and it will appear here.',
      reportsSelect: 'Choose a work log on the left',
      reportsContentLoading: 'Loading work log…',
      reportsLoadFailed: 'Loading work logs failed',
      reportsContentFailed: 'Loading the work log failed',
      reportGenerate: 'Generate today',
      reportRegenerating: 'Regenerate',
      reportGenerating: 'Generating…',
      reportGenerated: 'Work log generated',
      reportGenerateFailed: 'Generating the work log failed',
      reportRefresh: 'Refresh',
      reportToday: 'Today',
      reportStatusIdle: 'Not generated',
      reportStatusRunning: 'Generating',
      reportStatusOk: 'Succeeded',
      reportStatusFailed: 'Failed',
      reportLastStatus: 'Last status',
      reportLastDate: 'Last date',
      reportDir: 'Output directory',
      reportDirHint: 'The work log Markdown file is written here; the folder is created on demand.',
      reportTime: 'Run at',
      reportTimeHint: '24-hour clock, HH:mm (00:00–23:59)',
      reportTimeInvalid: 'The run time must use 24-hour HH:mm (00:00–23:59)',
      reportEnable: 'Work log',
      reportEnableHint: 'Generate a work log automatically at the configured time',
      reportSettingsTitle: 'Work log settings',
      reportSettingsSub: 'Schedule and output directory',
      reportGenerateNow: 'Generate now',
      reportError: 'Last error',
      reportNoSelection: 'Select a work log',
      reportBytes: '{size}',
      reportDate: 'Date',
      reportSaved: 'Work log settings saved',
      kpiPending: 'Queue',
      kpiRunning: 'Running',
      kpiDone: 'Done',
      kpiFailed: 'Failed',
      kpiIdea: 'Ideas',
      kpiProcessing: 'In progress',
      kpiIdeaSub: 'Ideas and not yet scheduled',
      kpiAutoStartOn: 'Auto-run on',
      kpiAutoStartOff: 'Auto-run off',
      kpiConcurrency: 'Concurrency {running} / {limit}',
      kpiTodayPlus: 'Today +{count}',
      kpiTodayNone: 'None',
      kpiGroupLabel: 'Statistics',
      kpiModuleAria: '{label}: {value}',
      columnPending: 'Queue',
      columnClaimed: 'In progress',
      columnEnded: 'Finished',
      columnPendingHint: 'The queue runs automatically in order — or run one now',
      columnPendingDragHint: 'Drag to reorder · Alt+↑↓',
      columnClaimedHint: 'Running / paused / waiting for you',
      columnEndedHint: 'Finished, failed and cancelled records',
      emptyPendingColumn: 'No queued tasks',
      emptyPendingColumnHint: 'New tasks show up here',
      emptyClaimedColumn: 'Nothing in progress',
      emptyClaimedColumnHint: 'Tasks appear here once they start running',
      emptyEndedColumn: 'Nothing finished yet',
      emptyEndedColumnHint: 'Finished, failed or cancelled tasks stay here',
      filterEmptyTitle: 'No matching tasks',
      filterEmptyHint: 'Try another keyword or filter.',
      filterReset: 'Clear filters',
      filterAll: 'All',
      filterLabel: 'Status filter',
      dropHere: 'Drop here',
      dragHandle: 'Drag to reorder',
      position: 'Position {index}',
      openTask: 'Open task details',
      openSession: 'Open session',
      run: 'Run',
      runNext: 'Run next',
      moveUp: 'Move up',
      moveDown: 'Move down',
      retry: 'Retry',
      pause: 'Pause',
      resume: 'Resume',
      interrupt: 'Stop this run',
      delete: 'Delete',
      deleteTask: 'Delete task',
      edit: 'Edit',
      view: 'View',
      statusPending: 'Queued',
      statusRunning: 'Running',
      statusPaused: 'Paused',
      statusBlocked: 'Waiting for you',
      statusDone: 'Done',
      statusFailed: 'Failed',
      statusCancelled: 'Cancelled',
      badgeBlocked: 'Waiting for you',
      blockedNote: 'Waiting for your reply or approval',
      badgeSession: 'DSH session',
      runningFor: 'Running {duration}',
      durationChip: 'Duration {duration}',
      tokensChip: '{tokens} tokens',
      chainShort: 'Chained',
      chainTitle: 'Continues "{title}"',
      chainFromLabel: 'Previously chained',
      chainFromNone: 'Not chained',
      justNow: 'just now',
      minutesAgo: '{count}m ago',
      hoursAgo: '{count}h ago',
      daysAgo: '{count}d ago',
      overview: 'Overview',
      taskPrompt: 'Description',
      resultTitle: 'Result',
      resultRunning: 'The final answer appears here when the task finishes.',
      resultEmpty: 'No result yet.',
      resultCopy: 'Copy result',
      copied: 'Copied',
      copyFailed: 'Copy failed',
      errorLabel: 'Error',
      cwd: 'Working directory',
      model: 'Model',
      noModel: 'Not set',
      status: 'Status',
      sourceLabel: 'Source',
      createdAt: 'Created',
      startedAt: 'Started',
      endedAt: 'Ended',
      duration: 'Duration',
      turns: 'Turns',
      tokens: 'Tokens',
      tokensUsage: 'In {input} · Out {output}',
      tokensUsageCache: 'In {input} · Out {output} · Cache {cache}',
      chat: 'Task chat',
      chatPlaceholder: 'Continue the conversation…',
      send: 'Send',
      sending: 'Sending…',
      chatDisabled: 'Chat unlocks once the task starts.',
      chatReadOnly: 'Imported DSH sessions are read-only; open the session to continue.',
      chatEmpty: 'No messages yet.',
      transcriptLoading: 'Loading conversation…',
      transcriptEmptyTask: 'The execution log appears here once the task starts.',
      transcriptFailed: 'Loading the conversation failed',
      chatFailed: 'Sending failed',
      chatReviveHint: 'Sending a message restarts the task and moves it back to In progress; if the session is gone it is re-queued',
      chatContinueHint: 'Sending a message continues the task',
      chatRevivedRunning: 'Task restarted and moved back to “In progress”',
      chatRevivedPending: 'Task queued again; it will run automatically',
      roleUser: 'User',
      roleAssistant: 'Assistant',
      confirming: 'Confirm delete',
      backToList: 'Back to list',
      close: 'Close',
      dismiss: 'Dismiss',
      saving: 'Saving…',
      publishTitle: 'New task',
      publishSubtitle: 'New tasks start as ideas; add one to the queue when you are ready.',
      modeSingle: 'Single',
      modeBatch: 'Batch',
      fieldTitle: 'Title',
      fieldTitlePlaceholder: 'e.g. Fix the sign-in page styles',
      fieldPrompt: 'Description',
      fieldPromptPlaceholder: 'Describe the work, constraints, and acceptance criteria…',
      fieldCwd: 'Working directory',
      fieldCwdPlaceholder: 'Absolute path, e.g. /Users/me/project',
      chooseDirectory: 'Choose folder',
      choosing: 'Choosing…',
      batchLabel: 'Task list',
      batchPlaceholder: 'One task per line as "title | description"\nFor example:\nFix sign-in styles | Fix the mobile offset\nAdd unit tests',
      batchHint: 'One task per line; separate title and description with "|"',
      batchCount: '{count} tasks',
      batchOverflow: 'At most {max} tasks per batch',
      chainSwitch: "Use the previous task's result",
      chainHint: 'Will continue "{title}"',
      chainHintBatch: 'Chain the whole batch in order; each task continues the previous one',
      chainHintNone: 'No task to continue yet',
      required: 'Title, description and working directory are required',
      batchRequired: 'Add at least one task',
      titleTooLong: 'Title must be at most {max} characters',
      cwdInvalid: 'The working directory must be an absolute path',
      submit: 'Create',
      submitting: 'Creating…',
      cancel: 'Cancel',
      publishSuccess: 'Created {count} tasks',
      publishSuccessOne: 'Created 1 task',
      editTitle: 'Edit task',
      editSubtitle: 'Change the title, description, directory or chain.',
      editSubmit: 'Save changes',
      editSubmitting: 'Saving…',
      editSuccess: 'Task updated',
      editRunning: 'Running tasks cannot be edited; pause it first.',
      fieldChain: 'Continue a task',
      concurrency: 'Concurrency',
      concurrencyHint: 'Tasks that may run at once (1–10)',
      defaultModel: 'Default model',
      reasoningEffort: 'Reasoning effort',
      effortDefault: 'Model default',
      notifyOnDone: 'Completion notifications',
      notifyOnDoneHint: 'Notify when the queue drains',
      notifyDenied: 'Browser notifications are blocked; in-app toasts are used instead.',
      notifyUnsupported: 'This environment has no system notifications; in-app toasts are used instead.',
      provider: 'Provider',
      modelId: 'Model id',
      modelsLoading: 'Loading models…',
      modelsUnavailable: 'Model catalog unavailable',
      modelsUnavailableHint: 'You can still enter a provider and model id manually.',
      current: 'Current',
      loadFailed: 'Load failed',
      loadingState: 'Loading tasks…',
      stateLoadFailed: 'Refreshing state failed',
      publishFailed: 'Creating the task failed',
      settingsFailed: 'Saving settings failed',
      actionFailed: 'Action failed',
      reorderFailed: 'Saving the order failed',
      reorderSaving: 'Saving order…',
      modelsLoadFailed: 'Loading the model catalog failed',
      modelsInvalid: 'The model catalog returned invalid data',
      pickFailed: 'Choosing a folder failed',
      openSessionFailed: 'Opening the session failed',
      notifyTitle: 'Task Butler · tasks finished',
      notifyBody: '{done} done · {failed} failed',
      notifyToast: 'Tasks finished: {done} done · {failed} failed',
      runStarted: 'Started "{title}"',
      pausedToast: 'Paused "{title}"',
      resumedToast: 'Resumed "{title}"',
      interruptedToast: 'Stopped “{title}”',
      retriedToast: 'Requeued "{title}"',
      blockedHint: 'Waiting for you: answer in the session and the task continues.',
      pausedHint: 'Paused: resuming posts “continue this task” to the session.',
      noTasksYet: 'No tasks',
      queued: 'Queued',
      emptyTitle: 'No tasks yet',
      emptyHint: 'Write down what needs doing and I will line it up — one at a time, or paste a whole batch.',
      emptyCta: 'New task',
      emptyCtaBatch: 'Batch create',
      crashTitle: 'The Task Butler panel hit an error',
      crashHint: 'Switch pages or reload and try again. If it keeps happening, report the console error to the plugin author.',
      searchPlaceholder: 'Search all tasks…',
      searchClear: 'Clear search',
      showSessions: 'DSH sessions',
      unknownError: 'Unknown error',

      /* v4: awaiting-start lane + priority + settings dialog + cross-column drag */
      statusIdea: 'Idea',
      columnIdeas: 'Ideas',
      columnIdeasHint: 'Ideas and not-yet-scheduled tasks — drag one to the queue when ready',
      emptyIdeasColumn: 'No ideas yet',
      emptyIdeasColumnHint: 'Ideas and not-yet-scheduled tasks live here',
      emptyIdeasColumnAction: 'Save one',
      ideaHint: 'Idea tasks never run automatically — drag one to Queue or choose “Add to queue”.',
      badgeIdea: 'Idea',
      priorityLabel: 'Priority',
      priorityUrgent: 'Urgent',
      priorityHigh: 'High',
      priorityNormal: 'Normal',
      priorityLow: 'Low',
      priorityAll: 'All priorities',
      filterPriorityLabel: 'Filter by priority',
      fieldStatus: 'Place in',
      fieldStatusHint: 'Idea tasks do not run automatically; add one to the queue when ready',
      statusOptionIdea: 'Idea',
      statusOptionPending: 'Queue',
      promote: 'Add to queue',
      demote: 'Back to ideas',
      promotedToast: 'Added “{title}” to the queue',
      demotedToast: 'Moved “{title}” back to ideas',
      dragToPending: 'Drop into queue',
      dragToIdeas: 'Drop into ideas',
      dragNotAllowed: 'This column does not accept that task',
      createdChip: 'Created {time}',
      updatedChip: 'Updated {time}',
      updatedAt: 'Updated',
      settingsSectionExecution: 'Execution',
      settingsExecutionSub: 'Concurrency, default model and auto-run',
      settingsSectionNotify: 'Desktop alerts',
      settingsNotifySub: 'How to be notified when tasks finish',
      settingsSectionReport: 'Work log',
      settingsReportSub: 'Schedule and output directory',
      settingsDone: 'Done',
      settingsAutoSave: 'Changes save immediately',
      settingsSectionBackup: 'Data backups',
      settingsSectionWebhook: 'Push notifications',
      webhookSub: 'Key task, work-log and brief updates pushed to your webhook (Markdown)',
      webhookEnableLabel: 'Enable push notifications',
      webhookEnableHint: 'Notifications are only pushed while on; you can configure and send a test while off',
      webhookUrl: 'Webhook URL',
      webhookUrlPlaceholder: 'https://example.com/webhook',
      webhookUrlRequired: 'Fill in the Webhook URL before enabling',
      webhookUrlInvalid: 'Webhook URL must be an http(s) URL',
      webhookFormat: 'Message format',
      webhookFormatHint: 'Pick the payload shape for your receiver',
      webhookFormatGeneric: 'Generic JSON',
      webhookFormatFeishu: 'Feishu',
      webhookFormatWecom: 'WeCom',
      webhookFormatDingtalk: 'DingTalk',
      webhookFormatSlack: 'Slack',
      webhookEvents: 'Events',
      webhookEventClaimed: 'Task started',
      webhookEventSucceeded: 'Task succeeded',
      webhookEventBlocked: 'Task waiting for you',
      webhookEventFailed: 'Task failed',
      webhookEventDailyReport: 'Work log generated',
      webhookEventRetrospective: 'Retrospective generated',
      webhookEventTest: 'Test notification',
      webhookTest: 'Send test notification',
      webhookTesting: 'Sending…',
      webhookTestSent: 'Test notification sent',
      webhookTestFailed: 'Sending the test notification failed',
      webhookTestHint: 'Fill in a valid Webhook URL to send a test',
      webhookLastLine: 'Last: {status} · {time} · {event}',
      webhookLastLineIdle: 'Last: no record yet',
      webhookStatusOk: 'success',
      webhookStatusFailed: 'failed',
      webhookSectionAria: 'Push notification settings',
      backupSub: 'Automatically saved recovery points you can restore anytime',
      backupLoading: 'Loading backups…',
      backupEmpty: 'No backups yet',
      backupSummary: 'Auto backups: latest {count} · most recent {time} ({tasks} tasks)',
      backupRefresh: 'Refresh',
      backupRefreshing: 'Refreshing…',
      backupRestore: 'Restore',
      backupRestoreConfirm: 'Confirm',
      backupRestoreCancel: 'Cancel',
      backupConfirmPrompt: 'Restore this backup?',
      backupRestoreWarning: 'Restoring overwrites the current tasks and settings with this backup; the current data is saved as a new backup first, so you can restore it again.',
      backupRestoring: 'Restoring…',
      backupRestored: 'Restored the backup from {time}',
      backupLoadFailed: 'Loading backups failed',
      backupRestoreFailed: 'Restore failed',
      backupTaskCount: '{count} tasks',
      backupRefreshAria: 'Refresh backup list',
      backupRestoreAria: 'Restore the backup from {time}',
      publishIdeaSuccess: 'Saved {count} ideas',
      publishIdeaSuccessOne: 'Saved 1 idea',

      /* v6: per-column search/filter + 24h time + uniform card zones */
      columnFilterLabel: 'Filter {column}',
      filterStatus: 'Status',
      filterPriority: 'Priority',
      filterSource: 'Source',
      sourceQueue: 'Queue tasks',
      sourceSession: 'DSH sessions',
      sourceSessionDisabled: 'This column has no DSH sessions',
      filterClear: 'Clear filters',
      filterEmptyHint: 'Try another keyword or filter.',
      filterEmptyClear: 'Clear filters/search',
      turnsChip: '{count} turns',
      contextEmpty: '—',

      /* v9: self-evolution / retrospectives / lessons / skills */
      evolution: 'Retrospective & lessons',
      evolutionTitle: 'Retrospective & lessons',
      evolutionSub: 'Review task progress and distil lessons and reusable skills',
      evolutionButton: 'Retrospective',
      retrospective: 'Retrospective',
      retrospectives: 'Retrospectives',
      retrospectiveNow: 'Run retrospective',
      retrospectiveGenerating: 'Retrospective running…',
      retrospectiveEmpty: 'No retrospectives yet',
      retrospectiveEmptyHint: 'One runs automatically at the scheduled time; you can also generate one now.',
      retrospectiveSelect: 'Pick a retrospective on the left',
      retrospectiveLoading: 'Loading retrospectives…',
      retrospectiveEmptyContent: 'The retrospective is empty',
      retrospectiveContentLoading: 'Loading the retrospective…',
      retrospectiveLoadFailed: 'Loading retrospectives failed',
      retrospectiveContentFailed: 'Loading the retrospective failed',
      retrospectiveGenerated: 'Retrospective generated',
      retrospectiveGenerateFailed: 'Generating the retrospective failed',
      retrospectiveSkipped: 'Nothing to review in this period',
      retrospectiveNothing: 'Nothing to review',
      retrospectiveRefresh: 'Refresh retrospective list',
      retrospectiveLastStatus: 'Last status',
      retrospectiveLastDate: 'Last retrospective',
      retrospectiveError: 'Last error',
      retrospectiveTabAria: 'Retrospectives, {count} in total',
      evolutionLoading: 'Loading retrospective data…',
      evolutionLoadFailed: 'Could not load retrospective data',
      evolutionStatusIdle: 'Not run yet',
      evolutionStatusRunning: 'Running',
      evolutionStatusOk: 'Succeeded',
      evolutionStatusFailed: 'Failed',
      lessonTab: 'Lessons',
      lessons: 'Lessons',
      lessonEmpty: 'No lessons yet; they will be distilled here after a retrospective',
      lessonEmptyHint: 'Run a retrospective or add one manually and the rule appears here.',
      lessonAdd: 'Add lesson',
      lessonText: 'Lesson',
      lessonTextPlaceholder: 'e.g. Run tests in this repo with node tests/static-check.mjs, not npm test',
      lessonTextRequired: 'Enter the lesson text',
      lessonTextTooLong: 'A lesson must be at most {max} characters',
      lessonCategory: 'Category',
      lessonScope: 'Scope',
      lessonProject: 'Project directory',
      lessonProjectRequired: 'A project-scoped lesson needs an absolute directory',
      lessonEvidence: 'Evidence',
      lessonSource: 'Source',
      lessonSourceRetrospective: 'From retrospective',
      lessonSourceManual: 'Added manually',
      lessonActive: 'Active',
      lessonInactive: 'Disabled',
      lessonEnable: 'Enable',
      lessonDisable: 'Disable',
      lessonDelete: 'Delete lesson',
      lessonDeleteConfirm: 'Delete this lesson?',
      lessonAdded: 'Lesson added',
      lessonUpdated: 'Lesson updated',
      lessonDeleted: 'Lesson deleted',
      lessonCount: '{count} lessons',
      lessonAddFailed: 'Adding the lesson failed',
      lessonUpdateFailed: 'Updating the lesson failed',
      lessonDeleteFailed: 'Deleting the lesson failed',
      lessonFormHint: 'Lessons are archived for reference only — never injected into task prompts.',
      categoryCorrection: 'Correction',
      categoryError: 'Error',
      categoryPreference: 'Preference',
      categoryProcess: 'Process',
      categoryOther: 'Other',
      scopeGlobal: 'Global',
      scopeProject: 'Project',
      skillTab: 'Skills',
      skills: 'Skills',
      skillCandidates: 'Skill candidates',
      skillEmpty: 'No skills yet',
      skillEmptyHint: 'When a retrospective spots a repeatable pattern, a skill candidate appears here.',
      skillStatusProposed: 'Proposed',
      skillStatusActive: 'Active',
      skillStatusDisabled: 'Disabled',
      skillAdopt: 'Adopt',
      skillAdopted: 'Skill adopted',
      skillEnable: 'Enable',
      skillDisable: 'Disable',
      skillEnabled: 'Skill enabled',
      skillDisabled: 'Skill disabled',
      skillDelete: 'Delete skill',
      skillDeleteConfirm: 'Delete this skill?',
      skillDeleted: 'Skill deleted',
      skillContent: 'Skill content',
      skillContentLoading: 'Loading the skill content…',
      skillContentFailed: 'Loading the skill content failed',
      skillContentEmpty: 'The skill content is empty',
      skillWhenToUse: 'When to use',
      skillDescription: 'Description',
      skillName: 'Name',
      skillScope: 'Scope',
      skillSource: 'Source',
      skillEvidence: 'Evidence',
      skillSourceRetrospective: 'From retrospective',
      skillSourceManual: 'Added manually',
      skillProposedHint: 'Adopting puts it in the DSH skill catalog; the model loads it on demand.',
      skillView: 'View',
      skillHide: 'Hide',
      skillViewAria: 'View skill {name}',
      skillAdoptFailed: 'Adopting the skill failed',
      skillActionFailed: 'The skill action failed',
      skillsExplainer: 'Skills appear in the skill catalog of every DSH session and are loaded on demand',
      skillsUnavailable: 'This Harness does not provide a skill service',
      skillModeOff: 'Skill distillation is turned off in settings',
      skillModeOffHint: 'While the mode is set to off, retrospectives do not produce skill candidates.',
      skillCandidateBadge: '{count} skill candidates waiting to be adopted',
      skillCandidateBadgeNone: 'No skill candidates waiting',
      tabRetro: 'Retrospectives',
      tabLessons: 'Lessons',
      tabSkills: 'Skills',
      tabLessonsAria: 'Lessons, {count} in total',
      tabSkillsAria: 'Skills, {count} proposed',
      evolutionEnable: 'Automatic retrospectives',
      evolutionEnableHint: 'Review task progress automatically at the configured time',
      evolutionInterval: 'Frequency',
      intervalDaily: 'Daily',
      intervalWeekly: 'Weekly',
      evolutionTime: 'Run at',
      evolutionTimeHint: '24-hour clock, HH:mm (00:00–23:59)',
      evolutionTimeInvalid: 'The retrospective time must use 24-hour HH:mm (00:00–23:59)',
      evolutionWeekday: 'Weekday',
      weekdaySun: 'Sunday',
      weekdayMon: 'Monday',
      weekdayTue: 'Tuesday',
      weekdayWed: 'Wednesday',
      weekdayThu: 'Thursday',
      weekdayFri: 'Friday',
      weekdaySat: 'Saturday',
      evolutionSkillMode: 'Skill distillation mode',
      skillModeOffLabel: 'Off',
      skillModeAsk: 'Propose candidates',
      skillModeAuto: 'Auto-enable',
      evolutionSkillModeHint: 'Candidates need manual adoption; auto-enable puts them straight into the skill catalog.',
      evolutionDir: 'Retrospective directory',
      evolutionDirHint: 'Retrospective Markdown files are written here; the folder is created on demand.',
      evolutionSection: 'Retrospective & lessons',
      evolutionSectionSub: 'Review tasks, distil lessons and skills',
      evolutionLast: 'Last retrospective',
      evolutionLastPending: 'Not run yet',
      evolutionGenerating: 'Running',
      evolutionGenerateNow: 'Run retrospective',
      enable: 'Enable',
      disable: 'Disable',
    }

    // ------------------------------------------------------------------ styles

    const CSS = [
      '.dsh-ps-panel{--ps-violet:#8b5cf6;--ps-violet-deep:#7c3aed;--ps-violet-soft:#a78bfa;--ps-indigo:#6366f1;--ps-blue:#3b82f6;--ps-blue-soft:#60a5fa;--ps-mint:#10b981;--ps-mint-soft:#34d399;--ps-amber:#f59e0b;--ps-amber-soft:#fbbf24;--ps-rose:#f43f5e;--ps-rose-soft:#fb7185;--ps-white:#ffffff;position:relative;display:flex;flex-direction:column;box-sizing:border-box;height:100%;min-height:0;overflow:hidden;background:radial-gradient(70% 48% at 8% -6%,color-mix(in srgb,var(--ps-violet) 12%,transparent),transparent 62%),radial-gradient(62% 42% at 96% 0%,color-mix(in srgb,var(--ps-blue) 10%,transparent),transparent 64%),linear-gradient(170deg,color-mix(in srgb,var(--ps-violet) 7%,var(--dsw-alias-bg-base)) 0%,color-mix(in srgb,var(--ps-blue) 5%,var(--dsw-alias-bg-base)) 48%,color-mix(in srgb,var(--ps-violet) 5%,var(--dsw-alias-bg-base)) 100%);color:var(--dsw-alias-label-primary);font-size:15px}',
      '.dsh-ps-page{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;box-sizing:border-box;padding:calc(22px + var(--dsh-frame-top-clearance,0px)) max(24px,calc(var(--dsh-frame-leading-clearance,0px) + 18px)) 44px;scrollbar-gutter:auto}',
      '.dsh-ps-page::-webkit-scrollbar{width:10px;height:10px}',
      '.dsh-ps-page::-webkit-scrollbar-track{background:transparent}',
      '.dsh-ps-page::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);border:3px solid transparent;border-radius:999px;background-clip:padding-box}',
      '.dsh-ps-page-inner{display:flex;flex-direction:column;gap:18px;width:100%;max-width:1440px;margin-inline:auto}',
      '.dsh-ps-page[data-view="today"] .dsh-ps-page-inner{max-width:1040px}',
      '.dsh-ps-page[data-view="tasks"] .dsh-ps-page-inner{max-width:1440px}',
      '.dsh-ps-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
      '.dsh-ps-header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:nowrap;padding:2px 0}',
      '.dsh-ps-header-main{display:flex;flex-direction:column;gap:5px;min-width:0;flex:0 1 auto}',
      '.dsh-ps-title-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-width:0}',
      '.dsh-ps-title{margin:0;font-size:24px;font-weight:700;line-height:1.2;letter-spacing:-.02em;white-space:nowrap}',
      '.dsh-ps-subtitle{margin:0;font-size:13px;line-height:19px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-header-actions{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;margin-left:auto;padding-top:0}',
      '.dsh-ps-switch-row{display:inline-flex;align-items:center;gap:9px;height:38px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dsh-ps-switch{position:relative;flex:none;box-sizing:border-box;width:42px;height:24px;padding:0;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,var(--dsw-alias-bg-layer-1));cursor:pointer;transition:background-color 200ms ease-out,border-color 200ms ease-out,opacity 200ms ease-out}',
      '.dsh-ps-switch[aria-checked="true"]{background:linear-gradient(135deg,var(--ps-violet),var(--ps-indigo));border-color:transparent;box-shadow:0 4px 12px -6px color-mix(in srgb,var(--ps-violet) 55%,transparent)}',
      '.dsh-ps-switch:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 60%,transparent);outline-offset:2px}',
      '.dsh-ps-switch:disabled{cursor:not-allowed;opacity:.45}',
      '.dsh-ps-switch-thumb{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:var(--ps-white);box-shadow:0 2px 5px color-mix(in srgb,var(--dsw-alias-label-primary) 26%,transparent);transition:transform 200ms ease-out}',
      '.dsh-ps-switch[aria-checked="true"] .dsh-ps-switch-thumb{transform:translateX(18px)}',
      '.dsh-ps-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;box-sizing:border-box;height:38px;padding:0 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:600;line-height:1;white-space:nowrap;cursor:pointer;box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent),0 10px 22px -18px color-mix(in srgb,var(--dsw-alias-label-primary) 26%,transparent);transition:transform 200ms ease-out,background-color 200ms ease-out,border-color 200ms ease-out,box-shadow 200ms ease-out,opacity 200ms ease-out}',
      '.dsh-ps-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-layer-1));border-color:var(--dsw-alias-border-l2);transform:translateY(-1px);box-shadow:0 2px 4px color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent),0 16px 30px -20px color-mix(in srgb,var(--dsw-alias-label-primary) 32%,transparent)}',
      '.dsh-ps-btn:active:not(:disabled){transform:translateY(0)}',
      '.dsh-ps-btn:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:2px}',
      '.dsh-ps-btn:disabled{cursor:not-allowed;opacity:.45}',
      '.dsh-ps-btn-primary{border:0;border-radius:999px;background:linear-gradient(135deg,var(--ps-violet) 0%,var(--ps-indigo) 100%);color:var(--ps-white);font-weight:600;box-shadow:0 12px 26px -12px color-mix(in srgb,var(--ps-violet) 58%,transparent),0 2px 6px color-mix(in srgb,var(--ps-indigo) 26%,transparent)}',
      '.dsh-ps-btn-primary:hover:not(:disabled){background:linear-gradient(135deg,var(--ps-violet) 0%,var(--ps-indigo) 100%);filter:brightness(1.06);transform:translateY(-1px);box-shadow:0 16px 32px -12px color-mix(in srgb,var(--ps-violet) 62%,transparent),0 3px 8px color-mix(in srgb,var(--ps-indigo) 30%,transparent)}',
      '.dsh-ps-btn-primary:active:not(:disabled){transform:translateY(0);filter:brightness(.98)}',
      '.dsh-ps-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary);box-shadow:none}',
      '.dsh-ps-btn-ghost:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);border-color:transparent;color:var(--dsw-alias-label-primary);box-shadow:none;transform:none}',
      '.dsh-ps-btn-danger{color:var(--ps-rose);border-color:color-mix(in srgb,var(--ps-rose) 24%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--ps-rose) 8%,var(--dsw-alias-bg-layer-1))}',
      '.dsh-ps-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--ps-rose) 13%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--ps-rose) 40%,var(--dsw-alias-border-l1))}',
      '.dsh-ps-btn-sm{height:30px;padding:0 12px;font-size:12.5px;border-radius:10px}',
      '.dsh-ps-btn-icon{width:38px;padding:0}',
      '.dsh-ps-spinner{display:inline-block;flex:none;width:14px;height:14px;border:2px solid color-mix(in srgb,var(--dsw-alias-label-secondary) 22%,transparent);border-top-color:color-mix(in srgb,var(--ps-violet) 75%,var(--dsw-alias-label-primary));border-radius:50%;animation:dsh-ps-spin 720ms linear infinite}',
      '.dsh-ps-banner{display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border:1px solid color-mix(in srgb,var(--ps-rose) 20%,var(--dsw-alias-border-l1));border-radius:16px;background:color-mix(in srgb,var(--ps-rose) 8%,var(--dsw-alias-bg-layer-1));color:color-mix(in srgb,var(--ps-rose) 62%,var(--dsw-alias-label-primary));font-size:13px;line-height:19px;box-shadow:0 10px 24px -20px color-mix(in srgb,var(--ps-rose) 45%,transparent);animation:dsh-ps-fade-in 200ms ease-out}',
      '.dsh-ps-banner-icon{flex:none;margin-top:1px}',
      '.dsh-ps-banner-text{flex:1;min-width:0;overflow-wrap:anywhere}',
      '.dsh-ps-banner-dismiss{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;padding:0;border:0;border-radius:7px;background:transparent;color:inherit;cursor:pointer}',
      '.dsh-ps-banner-dismiss:hover{background:color-mix(in srgb,var(--ps-rose) 14%,transparent)}',
      '.dsh-ps-banner-dismiss:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-rose) 60%,transparent);outline-offset:1px}',
      '.dsh-ps-kpi[data-tone="idea"]{--ps-tone:var(--ps-violet-soft)}',
      '.dsh-ps-kpi[data-tone="pending"]{--ps-tone:var(--ps-blue)}',
      '.dsh-ps-kpi[data-tone="processing"]{--ps-tone:var(--ps-violet)}',
      '.dsh-ps-kpi[data-tone="done"]{--ps-tone:var(--ps-mint)}',
      '.dsh-ps-kpi[data-tone="failed"]{--ps-tone:var(--ps-rose)}',
      '.dsh-ps-kpi{--ps-tone:var(--ps-violet-soft);position:relative;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;min-width:0;min-height:126px;padding:16px 16px 15px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:22px;background:radial-gradient(95% 95% at 100% 0%,color-mix(in srgb,var(--ps-tone) 15%,transparent),transparent 66%),linear-gradient(180deg,color-mix(in srgb,var(--ps-tone) 3%,transparent),transparent 58%),var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent),0 18px 38px -24px color-mix(in srgb,var(--ps-tone) 22%,var(--dsw-alias-label-primary) 16%,transparent);transition:transform 200ms ease-out,box-shadow 200ms ease-out,border-color 200ms ease-out}',
      '.dsh-ps-kpi:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--ps-tone) 20%,var(--dsw-alias-border-l1));box-shadow:0 2px 5px color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent),0 24px 44px -24px color-mix(in srgb,var(--ps-tone) 34%,transparent)}',
      '.dsh-ps-kpi[data-tone="processing"]{border-color:transparent;background:linear-gradient(135deg,var(--ps-violet) 0%,var(--ps-indigo) 100%);box-shadow:0 18px 38px -16px color-mix(in srgb,var(--ps-violet) 55%,transparent),inset 0 1px 0 color-mix(in srgb,var(--ps-white) 18%,transparent)}',
      '.dsh-ps-kpi[data-tone="processing"]:hover{box-shadow:0 24px 48px -16px color-mix(in srgb,var(--ps-violet) 60%,transparent),inset 0 1px 0 color-mix(in srgb,var(--ps-white) 22%,transparent)}',
      '.dsh-ps-kpi-top{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}',
      '.dsh-ps-kpi-tile{display:inline-flex;align-items:center;justify-content:center;flex:none;width:38px;height:38px;border:1px solid color-mix(in srgb,var(--ps-tone) 16%,transparent);border-radius:13px;background:color-mix(in srgb,var(--ps-tone) 14%,var(--dsw-alias-bg-layer-1));color:color-mix(in srgb,var(--ps-tone) 58%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-kpi-tile-icon{display:inline-flex;align-items:center;justify-content:center;line-height:1}',
      '.dsh-ps-kpi[data-tone="processing"] .dsh-ps-kpi-tile{border-color:color-mix(in srgb,var(--ps-white) 26%,transparent);background:color-mix(in srgb,var(--ps-white) 18%,transparent);color:var(--ps-white)}',
      '.dsh-ps-kpi-pulse{position:relative;flex:none;width:8px;height:8px;border-radius:50%;background:var(--ps-white);box-shadow:0 0 0 4px color-mix(in srgb,var(--ps-white) 18%,transparent)}',
      '.dsh-ps-kpi-pulse::after{content:"";position:absolute;inset:-4px;border:1px solid color-mix(in srgb,var(--ps-white) 50%,transparent);border-radius:50%;animation:dsh-ps-kpi-breathe 2.4s ease-out infinite}',
      '.dsh-ps-kpi-numbers{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dsh-ps-kpi-number{color:var(--dsw-alias-label-primary);font-size:27px;font-weight:700;line-height:1.05;letter-spacing:-.02em;font-variant-numeric:tabular-nums}',
      '.dsh-ps-kpi-label{color:var(--dsw-alias-label-secondary);font-size:12.5px;font-weight:600;line-height:16px;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-ps-kpi-sub{display:flex;align-items:center;gap:6px;margin-top:auto;min-width:0;color:color-mix(in srgb,var(--ps-tone) 52%,var(--dsw-alias-label-secondary));font-size:11.5px;line-height:16px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-ps-kpi[data-tone="processing"] .dsh-ps-kpi-number{color:var(--ps-white)}',
      '.dsh-ps-kpi[data-tone="processing"] .dsh-ps-kpi-label{color:color-mix(in srgb,var(--ps-white) 88%,transparent)}',
      '.dsh-ps-kpi[data-tone="processing"] .dsh-ps-kpi-sub{color:color-mix(in srgb,var(--ps-white) 82%,transparent)}',
      '.dsh-ps-kpi-bar{position:relative;height:6px;overflow:hidden;border-radius:999px;background:color-mix(in srgb,var(--ps-white) 26%,transparent)}',
      '.dsh-ps-kpi-bar-fill{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,color-mix(in srgb,var(--ps-white) 96%,transparent),color-mix(in srgb,var(--ps-white) 74%,transparent))}',
      '.dsh-ps-kpi-bar[data-active="true"] .dsh-ps-kpi-bar-fill{animation:dsh-ps-kpi-glow 2.6s ease-in-out infinite}',
      '.dsh-ps-settings{border:1px solid var(--dsw-alias-border-l1);border-radius:20px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent);overflow:hidden;animation:dsh-ps-fade-in 200ms ease-out}',
      '.dsh-ps-field{display:flex;flex-direction:column;gap:7px;min-width:0}',
      '.dsh-ps-field-label{font-size:12.5px;font-weight:600;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-field-hint{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-field-error{font-size:12px;line-height:17px;color:color-mix(in srgb,var(--ps-rose) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-field-fallback{display:flex;flex-direction:column;gap:9px;min-width:0}',
      '.dsh-ps-input,.dsh-ps-textarea,.dsh-ps-select{box-sizing:border-box;width:100%;min-width:0;color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-layer-1));border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:9px 13px;font:inherit;font-size:13px;line-height:20px;transition:border-color 200ms ease-out,box-shadow 200ms ease-out,background-color 200ms ease-out,opacity 200ms ease-out}',
      '.dsh-ps-textarea{resize:vertical;min-height:96px;line-height:21px}',
      '.dsh-ps-select{cursor:pointer}',
      '.dsh-ps-input::placeholder,.dsh-ps-textarea::placeholder{color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-input:hover:not(:disabled),.dsh-ps-textarea:hover:not(:disabled),.dsh-ps-select:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}',
      '.dsh-ps-input:focus-visible,.dsh-ps-textarea:focus-visible,.dsh-ps-select:focus-visible{outline:none;border-color:color-mix(in srgb,var(--ps-violet) 40%,var(--dsw-alias-border-l1));box-shadow:0 0 0 4px color-mix(in srgb,var(--ps-violet) 12%,transparent);background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-ps-input:disabled,.dsh-ps-select:disabled,.dsh-ps-textarea:disabled{opacity:.55;cursor:not-allowed}',
      '.dsh-ps-dir-row{display:flex;align-items:center;gap:9px;min-width:0}',
      '.dsh-ps-dir-row .dsh-ps-input{flex:1;min-width:0}',
      '.dsh-ps-time-input{max-width:150px;font-variant-numeric:tabular-nums;letter-spacing:.03em}',
      '.dsh-ps-stepper{display:inline-flex;align-items:center;width:max-content;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-layer-1))}',
      '.dsh-ps-stepper button{width:36px;height:40px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:16px;line-height:1;cursor:pointer;transition:background-color 200ms ease-out}',
      '.dsh-ps-stepper button:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}',
      '.dsh-ps-stepper button:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:-2px}',
      '.dsh-ps-stepper button:disabled{cursor:not-allowed;opacity:.35}',
      '.dsh-ps-stepper input{box-sizing:border-box;width:50px;height:40px;padding:0;border:0;border-left:1px solid var(--dsw-alias-border-l1);border-right:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);text-align:center;font:inherit;font-size:13px;font-variant-numeric:tabular-nums;-moz-appearance:textfield}',
      '.dsh-ps-stepper input::-webkit-outer-spin-button,.dsh-ps-stepper input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}',
      '.dsh-ps-stepper input:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:-2px}',
      '.dsh-ps-switch-inline{display:flex;align-items:center;gap:11px;min-height:38px}',
      '.dsh-ps-settings-saving{display:inline-flex;align-items:center;gap:8px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-settings-dialog{width:min(720px,100%)}',
      '.dsh-ps-settings-dialog .dsh-ps-dialog-head{padding:24px 28px 14px}',
      '.dsh-ps-settings-dialog .dsh-ps-dialog-body{gap:20px;padding:4px 28px 12px}',
      '.dsh-ps-settings-dialog .dsh-ps-dialog-foot{padding:18px 28px 22px}',
      '.dsh-ps-settings-group{display:flex;flex-direction:column;gap:18px;padding:22px 24px;border:1px solid var(--dsw-alias-border-l1);border-radius:20px;background:linear-gradient(135deg,color-mix(in srgb,var(--ps-violet) 4%,var(--dsw-alias-bg-layer-1)) 0%,color-mix(in srgb,var(--dsw-alias-bg-layer-2) 50%,var(--dsw-alias-bg-layer-1)) 100%);box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 3%,transparent),0 14px 30px -26px color-mix(in srgb,var(--ps-violet) 22%,var(--dsw-alias-label-primary) 16%,transparent)}',
      '.dsh-ps-settings-group-head{display:flex;align-items:flex-start;gap:13px;min-width:0}',
      '.dsh-ps-settings-group-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:38px;height:38px;border:1px solid color-mix(in srgb,var(--ps-violet) 14%,transparent);border-radius:12px;background:color-mix(in srgb,var(--ps-violet) 10%,var(--dsw-alias-bg-layer-1));color:color-mix(in srgb,var(--ps-violet-deep) 58%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-settings-group-titles{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}',
      '.dsh-ps-settings-group-title{margin:0;font-size:15px;font-weight:600;line-height:21px;letter-spacing:-.01em}',
      
      '.dsh-ps-settings-group-sub{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-ps-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 24px;align-items:start}',
      '.dsh-ps-settings-span-2{grid-column:1/-1;min-width:0}',
      '.dsh-ps-settings-row{display:flex;align-items:flex-start;gap:14px;min-width:0;padding:1px 0}',
      '.dsh-ps-settings-row-text{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}',
      '.dsh-ps-settings-row-label{font-size:13px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary)}',
      '.dsh-ps-settings-row-hint{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-settings-row .dsh-ps-switch{margin-top:2px}',
      '.dsh-ps-settings-status{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.dsh-ps-settings-status-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:40px}',
      '.dsh-ps-settings-status-date{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dsh-ps-settings-status-grow{flex:1;min-width:8px}',
      '.dsh-ps-settings-grid[data-span="2"]{grid-template-columns:minmax(0,1fr)}',
      '.dsh-ps-settings-save-state{display:inline-flex;align-items:center;gap:8px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-settings-save-state[data-tone="error"]{color:color-mix(in srgb,var(--ps-rose) 60%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-report-status-line{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-height:20px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-report-status-chip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 10px;border-radius:999px;font-size:11.5px;font-weight:600;line-height:1;white-space:nowrap;background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-report-status-chip[data-tone="running"]{background:color-mix(in srgb,var(--ps-violet) 12%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-report-status-chip[data-tone="ok"]{background:color-mix(in srgb,var(--ps-mint) 13%,transparent);color:color-mix(in srgb,var(--ps-mint) 55%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-report-status-chip[data-tone="failed"]{background:color-mix(in srgb,var(--ps-rose) 12%,transparent);color:color-mix(in srgb,var(--ps-rose) 60%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-two-col{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px}',
      '.dsh-ps-segmented{display:inline-flex;align-items:center;gap:2px;box-sizing:border-box;width:max-content;padding:3px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}',
      '.dsh-ps-segment{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:32px;padding:0 17px;border:1px solid transparent;border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;font-weight:600;line-height:1;cursor:pointer;transition:background-color 200ms ease-out,border-color 200ms ease-out,color 200ms ease-out}',
      '.dsh-ps-segment:hover:not([aria-pressed="true"]){color:var(--dsw-alias-label-primary)}',
      '.dsh-ps-segment[aria-pressed="true"]{background:color-mix(in srgb,var(--ps-violet) 12%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--ps-violet) 24%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary));box-shadow:0 1px 2px color-mix(in srgb,var(--ps-violet) 14%,transparent)}',
      '.dsh-ps-segment:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:1px}',
      '.dsh-ps-option{display:flex;align-items:flex-start;gap:13px;padding:12px 13px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 2%,transparent)}',
      '.dsh-ps-option-body{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}',
      '.dsh-ps-option-title{font-size:13px;font-weight:600;line-height:18px}',
      '.dsh-ps-option-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px}',
      '.dsh-ps-option .dsh-ps-switch{margin-top:1px}',
      '.dsh-ps-batch-bar{display:flex;align-items:center;justify-content:space-between;gap:9px;min-width:0}',
      '.dsh-ps-batch-count{display:inline-flex;align-items:center;height:24px;padding:0 10px;border-radius:999px;background:color-mix(in srgb,var(--ps-violet) 10%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary));font-size:11.5px;font-weight:600;line-height:1;font-variant-numeric:tabular-nums}',
      '.dsh-ps-batch-textarea{min-height:140px;max-height:280px}',
      '.dsh-ps-dialog-note{display:flex;align-items:flex-start;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:16px}',
      '.dsh-ps-board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;align-items:start}',
      '.dsh-ps-column[data-column="idea"]{--ps-col:var(--ps-violet-soft)}',
      '.dsh-ps-column[data-column="pending"]{--ps-col:var(--ps-blue)}',
      '.dsh-ps-column[data-column="claimed"]{--ps-col:var(--ps-violet)}',
      '.dsh-ps-column[data-column="ended"]{--ps-col:var(--ps-mint)}',
      '.dsh-ps-column{--ps-col:var(--ps-violet);position:relative;display:flex;flex-direction:column;min-width:0;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:24px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 78%,transparent);box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent),0 22px 44px -30px color-mix(in srgb,var(--ps-violet) 22%,var(--dsw-alias-label-primary) 18%,transparent);transition:border-color 200ms ease-out,box-shadow 200ms ease-out,background-color 200ms ease-out}',
      '.dsh-ps-column[data-drop="allowed"]{border-color:color-mix(in srgb,var(--ps-violet) 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--ps-violet) 5%,var(--dsw-alias-bg-layer-1));box-shadow:0 0 0 4px color-mix(in srgb,var(--ps-violet) 12%,transparent),0 18px 36px -30px color-mix(in srgb,var(--dsw-alias-label-primary) 32%,transparent)}',
      '.dsh-ps-column[data-drop="forbidden"]{border-color:color-mix(in srgb,var(--ps-rose) 38%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--ps-rose) 4%,var(--dsw-alias-bg-layer-1));cursor:not-allowed}',
      '.dsh-ps-column[data-drag-active="true"] .dsh-ps-column-body{cursor:grabbing}',
      '.dsh-ps-column-top{position:relative;display:flex;flex-direction:column;gap:10px;min-width:0;padding:2px 2px 10px}',
      '.dsh-ps-column-head{display:flex;align-items:center;gap:8px;min-width:0;padding:0}',
      '.dsh-ps-col-dot{position:relative;flex:none;width:10px;height:10px;border-radius:50%;background:var(--ps-col);box-shadow:0 0 0 4px color-mix(in srgb,var(--ps-col) 16%,transparent)}',
      '.dsh-ps-col-dot[data-status="idea"]{background:var(--ps-violet-soft)}',
      '.dsh-ps-col-dot[data-status="running"]{background:var(--ps-violet)}',
      '.dsh-ps-col-dot[data-status="claimed"]{background:var(--ps-violet)}',
      '.dsh-ps-col-dot[data-status="done"]{background:var(--ps-mint)}',
      '.dsh-ps-column-title{margin:0;font-size:14px;font-weight:600;line-height:19px;letter-spacing:-.01em;white-space:nowrap}',
      '.dsh-ps-column-count{display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:24px;height:23px;padding:0 8px;border-radius:999px;background:color-mix(in srgb,var(--ps-col) 12%,var(--dsw-alias-bg-layer-1));color:color-mix(in srgb,var(--ps-col) 52%,var(--dsw-alias-label-primary));font-size:12.5px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}',
      '.dsh-ps-column-count[data-filtered="true"]{background:color-mix(in srgb,var(--ps-col) 20%,var(--dsw-alias-bg-layer-1));color:color-mix(in srgb,var(--ps-col) 48%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-column-grow{flex:1;min-width:0}',
      '.dsh-ps-column-hint{min-width:0;font-size:12.5px;line-height:17px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-ps-column-tools{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dsh-ps-column-body{display:flex;flex-direction:column;gap:12px;min-width:0;min-height:0;padding:0 1px 4px}',
      '.dsh-ps-column-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:30px 16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:20px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 1.5%,transparent);text-align:center;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-column-empty-icon{color:color-mix(in srgb,var(--ps-violet) 40%,var(--dsw-alias-label-secondary));opacity:.9}',
      '.dsh-ps-column-empty-title{margin:0;font-size:12.5px;font-weight:600;line-height:17px;color:var(--dsw-alias-label-primary)}',
      '.dsh-ps-column-empty-hint{margin:0;font-size:12.5px;line-height:17px}',
      '.dsh-ps-funnel{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;box-sizing:border-box;width:36px;height:36px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:50%;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent);transition:background-color 200ms ease-out,border-color 200ms ease-out,color 200ms ease-out,transform 200ms ease-out}',
      '.dsh-ps-funnel:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);transform:translateY(-1px)}',
      '.dsh-ps-funnel:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:2px}',
      '.dsh-ps-funnel[data-active="true"]{color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary));border-color:color-mix(in srgb,var(--ps-violet) 22%,transparent);background:color-mix(in srgb,var(--ps-violet) 10%,var(--dsw-alias-bg-layer-1))}',
      '.dsh-ps-funnel-dot{position:absolute;top:7px;right:7px;width:6px;height:6px;border-radius:50%;background:var(--ps-violet);box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1)}',
      '.dsh-ps-col-popover{position:absolute;top:calc(100% + 6px);right:0;z-index:45;display:flex;flex-direction:column;gap:12px;box-sizing:border-box;width:min(276px,calc(100vw - 40px));max-height:min(440px,68vh);overflow-y:auto;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:20px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 24px 60px -28px color-mix(in srgb,var(--dsw-alias-label-primary) 42%,transparent),0 2px 8px color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);animation:dsh-ps-pop-in 200ms ease-out}',
      '.dsh-ps-col-popover:focus-visible{outline:none}',
      '.dsh-ps-col-popover::-webkit-scrollbar{width:8px}',
      '.dsh-ps-col-popover::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);border:2px solid transparent;border-radius:999px;background-clip:padding-box}',
      '.dsh-ps-col-filter-section{display:flex;flex-direction:column;gap:7px;min-width:0}',
      '.dsh-ps-col-filter-label{font-size:11px;font-weight:600;line-height:14px;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}',
      '.dsh-ps-col-filter-options{display:flex;flex-wrap:wrap;gap:6px;min-width:0}',
      '.dsh-ps-col-filter-options[data-layout="list"]{flex-direction:column;flex-wrap:nowrap;align-items:stretch}',
      '.dsh-ps-col-filter-option{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:30px;padding:0 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;transition:background-color 200ms ease-out,border-color 200ms ease-out,color 200ms ease-out}',
      '.dsh-ps-col-filter-options[data-layout="list"] .dsh-ps-col-filter-option{justify-content:flex-start;width:100%;border-radius:12px;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-ps-col-filter-option:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}',
      '.dsh-ps-col-filter-option:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:1px}',
      '.dsh-ps-col-filter-option[aria-pressed="true"]{background:color-mix(in srgb,var(--ps-violet) 12%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--ps-violet) 22%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary));font-weight:600}',
      '.dsh-ps-col-filter-option:disabled{cursor:not-allowed;opacity:.4}',
      '.dsh-ps-col-filter-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dsh-ps-col-filter-meta{font-size:11px;line-height:14px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-ps-col-filter-clear{display:inline-flex;align-items:center;gap:5px;flex:none;height:28px;padding:0 11px;border:0;border-radius:999px;background:color-mix(in srgb,var(--ps-violet) 10%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary));font:inherit;font-size:12px;font-weight:600;line-height:1;white-space:nowrap;cursor:pointer;transition:background-color 200ms ease-out}',
      '.dsh-ps-col-filter-clear:hover:not(:disabled){background:color-mix(in srgb,var(--ps-violet) 16%,transparent)}',
      '.dsh-ps-col-filter-clear:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:1px}',
      '.dsh-ps-col-filter-clear:disabled{cursor:not-allowed;opacity:.4}',
      '.dsh-ps-dropzone{display:flex;align-items:center;justify-content:center;gap:7px;box-sizing:border-box;flex:none;height:44px;border:1.5px dashed var(--dsw-alias-border-l2);border-radius:16px;color:var(--dsw-alias-label-secondary);font-size:12px;transition:border-color 200ms ease-out,background-color 200ms ease-out,color 200ms ease-out}',
      '.dsh-ps-dropzone[data-active="true"]{border-color:color-mix(in srgb,var(--ps-violet) 45%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--ps-violet) 6%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-card[data-status="idea"]{--ps-status:var(--ps-violet-soft)}',
      '.dsh-ps-card[data-status="pending"]{--ps-status:var(--ps-blue)}',
      '.dsh-ps-card[data-status="running"]{--ps-status:var(--ps-violet)}',
      '.dsh-ps-card[data-status="paused"]{--ps-status:var(--ps-amber)}',
      '.dsh-ps-card[data-status="blocked"]{--ps-status:var(--ps-amber)}',
      '.dsh-ps-card[data-status="done"]{--ps-status:var(--ps-mint)}',
      '.dsh-ps-card[data-status="failed"]{--ps-status:var(--ps-rose)}',
      '.dsh-ps-card[data-status="cancelled"]{--ps-status:var(--dsw-alias-state-idle-primary)}',
      '.dsh-ps-card{--ps-status:var(--ps-violet);position:relative;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;min-width:0;min-height:140px;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:20px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent),0 16px 34px -22px color-mix(in srgb,var(--ps-violet) 26%,var(--dsw-alias-label-primary) 18%,transparent);cursor:pointer;text-align:left;overflow:hidden;transition:transform 200ms ease-out,box-shadow 200ms ease-out,border-color 200ms ease-out,opacity 200ms ease-out}',
      '.dsh-ps-card::before{content:"";position:absolute;left:0;top:16px;bottom:16px;width:3px;border-radius:0 3px 3px 0;background:color-mix(in srgb,var(--ps-status) 55%,transparent)}',
      '.dsh-ps-card:hover{transform:translateY(-3px);border-color:color-mix(in srgb,var(--ps-status) 18%,var(--dsw-alias-border-l1));box-shadow:0 4px 10px color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent),0 26px 48px -24px color-mix(in srgb,var(--ps-status) 30%,var(--dsw-alias-label-primary) 20%,transparent)}',
      '.dsh-ps-card:focus-within{border-color:var(--dsw-alias-border-l2)}',
      '.dsh-ps-card[data-status="cancelled"]{opacity:.72}',
      '.dsh-ps-card[data-source="session"]{border-style:dashed;border-color:color-mix(in srgb,var(--ps-blue) 20%,var(--dsw-alias-border-l1))}',
      '.dsh-ps-card[draggable="true"]{cursor:grab}',
      '.dsh-ps-card[draggable="true"]:active{cursor:grabbing}',
      '.dsh-ps-card[data-dragging="true"]{opacity:.55;transform:scale(.985) rotate(-.4deg);box-shadow:0 20px 40px -22px color-mix(in srgb,var(--ps-status) 45%,transparent)}',
      '.dsh-ps-card[data-drop="before"]{box-shadow:0 -3px 0 0 color-mix(in srgb,var(--ps-violet) 70%,transparent)}',
      '.dsh-ps-card[data-drop="after"]{box-shadow:0 3px 0 0 color-mix(in srgb,var(--ps-violet) 70%,transparent)}',
      '.dsh-ps-card-top{display:flex;align-items:flex-start;gap:6px;min-width:0;min-height:40px;padding-right:2px}',
      '.dsh-ps-card-identity{align-items:flex-start}',
      '.dsh-ps-grip{display:inline-flex;align-items:center;justify-content:center;flex:none;width:12px;height:20px;color:var(--dsw-alias-label-secondary);opacity:.45;cursor:grab}',
      '.dsh-ps-card:hover .dsh-ps-grip{opacity:.9}',
      '.dsh-ps-rank{display:inline-flex;align-items:center;justify-content:center;flex:none;height:20px;padding:0 7px;border-radius:999px;background:color-mix(in srgb,var(--ps-violet) 10%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary));font-size:10.5px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dsh-ps-card-title{display:-webkit-box;flex:1;min-width:0;margin:0;padding:0;border:0;background:transparent;overflow:hidden;color:var(--dsw-alias-label-primary);font:inherit;font-size:15.5px;font-weight:600;line-height:21px;letter-spacing:-.01em;text-align:left;overflow-wrap:anywhere;cursor:pointer;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.dsh-ps-card-title:hover{color:color-mix(in srgb,var(--ps-violet-deep) 30%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-card-title:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:2px;border-radius:8px}',
      '.dsh-ps-card-context{display:-webkit-box;box-sizing:border-box;height:35px;min-height:35px;margin:0;min-width:0;max-width:100%;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:17.5px;white-space:normal;overflow:hidden;overflow-wrap:anywhere;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.dsh-ps-card-context[data-empty="true"]{opacity:.7}',
      '.dsh-ps-card-meta{display:flex;align-items:center;gap:5px;min-width:0;max-width:100%;overflow:hidden;white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.dsh-ps-card-meta-primary{height:21px}',
      '.dsh-ps-card-meta-secondary{height:20px}',
      '.dsh-ps-card-meta-item{display:inline-flex;align-items:center;gap:4px;flex:none;box-sizing:border-box;height:24px;padding:0 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);color:var(--dsw-alias-label-secondary);font-size:12.5px;font-weight:500;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}',
      '.dsh-ps-card-meta-secondary .dsh-ps-card-meta-item{height:24px;font-size:12.5px;padding:0 8px}',
      '.dsh-ps-card-meta-secondary .dsh-ps-card-meta-item[data-meta="model"]{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-ps-card-meta-item[data-meta="group"]{background:color-mix(in srgb,var(--ps-violet) 10%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 58%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-card-meta-item[data-meta="folder"]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent)}',
      '.dsh-ps-card-meta-item[data-meta="model"]{background:color-mix(in srgb,var(--ps-blue) 10%,transparent);color:color-mix(in srgb,var(--ps-blue) 52%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-card-meta-icon{vertical-align:-2px;margin-right:0;opacity:.7}',
      '.dsh-ps-card-meta-sep{display:none}',
      '.dsh-ps-card-meta-live{color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary));font-weight:600}',
      '.dsh-ps-card-tag{display:inline-flex;align-items:center;gap:3px;flex:none;box-sizing:border-box;height:24px;padding:0 8px;border:0;border-radius:999px;background:color-mix(in srgb,var(--ps-blue) 9%,transparent);color:color-mix(in srgb,var(--ps-blue) 48%,var(--dsw-alias-label-primary));font-size:12.5px;font-weight:600;line-height:1;white-space:nowrap}',
      '.dsh-ps-card-session{display:inline-flex;flex:none;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:color-mix(in srgb,var(--ps-blue) 10%,transparent);color:color-mix(in srgb,var(--ps-blue) 52%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-card-live{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:17px;font-variant-numeric:tabular-nums}',
      '.dsh-ps-priority{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:20px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);line-height:1}',
      '.dsh-ps-priority[data-priority="urgent"]{color:color-mix(in srgb,var(--ps-rose) 70%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-priority[data-priority="high"]{color:color-mix(in srgb,var(--ps-amber) 72%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-priority[data-priority="normal"]{color:var(--dsw-alias-label-secondary);opacity:.75}',
      '.dsh-ps-priority[data-priority="low"]{color:var(--dsw-alias-label-secondary);opacity:.42}',
      '.dsh-ps-drawer-badges .dsh-ps-priority,.dsh-ps-drawer-badges .dsh-ps-chip{display:inline-flex;align-items:center;gap:4px;width:auto;height:22px;padding:0 9px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;line-height:1;white-space:nowrap;opacity:1}',
      '.dsh-ps-badge{display:inline-flex;align-items:center;height:24px;padding:0 9px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);color:var(--dsw-alias-label-secondary);font-size:12.5px;font-weight:600;line-height:1;white-space:nowrap}',
      '.dsh-ps-card-status{flex:none;align-self:flex-start;height:24px;margin-top:0;padding:0 9px;border-radius:999px;font-size:12.5px;letter-spacing:.01em}',
      '.dsh-ps-badge[data-status="running"]{background:color-mix(in srgb,var(--ps-violet) 13%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 65%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-badge[data-status="paused"]{background:color-mix(in srgb,var(--ps-amber) 15%,transparent);color:color-mix(in srgb,var(--ps-amber) 55%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-badge[data-status="blocked"]{background:color-mix(in srgb,var(--ps-amber) 17%,transparent);color:color-mix(in srgb,var(--ps-amber) 52%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-badge[data-status="done"]{background:color-mix(in srgb,var(--ps-mint) 13%,transparent);color:color-mix(in srgb,var(--ps-mint) 52%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-badge[data-status="failed"]{background:color-mix(in srgb,var(--ps-rose) 12%,transparent);color:color-mix(in srgb,var(--ps-rose) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-badge[data-status="cancelled"]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-badge[data-status="pending"]{background:color-mix(in srgb,var(--ps-blue) 11%,transparent);color:color-mix(in srgb,var(--ps-blue) 52%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-badge[data-status="idea"]{background:color-mix(in srgb,var(--ps-violet-soft) 15%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 55%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-card-actions{position:absolute;bottom:8px;right:8px;z-index:2;display:flex;align-items:center;gap:1px;padding:3px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 94%,transparent);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);box-shadow:0 12px 28px -16px color-mix(in srgb,var(--dsw-alias-label-primary) 40%,transparent);opacity:0;transform:translateY(4px);transform-origin:100% 100%;pointer-events:none;transition:opacity 200ms ease-out,transform 200ms ease-out}',
      '.dsh-ps-card:hover .dsh-ps-card-actions,.dsh-ps-card:focus-within .dsh-ps-card-actions{opacity:1;transform:none;pointer-events:auto}',
      '.dsh-ps-card-action{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:26px;height:26px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color 200ms ease-out,color 200ms ease-out}',
      '.dsh-ps-card-action:hover:not(:disabled){background:color-mix(in srgb,var(--ps-violet) 12%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-card-action[data-tone="brand"]:hover:not(:disabled){background:color-mix(in srgb,var(--ps-violet) 14%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-card-action[data-tone="warn"]:hover:not(:disabled){background:color-mix(in srgb,var(--ps-amber) 15%,transparent);color:color-mix(in srgb,var(--ps-amber) 55%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-card-action[data-tone="danger"]:hover:not(:disabled){background:color-mix(in srgb,var(--ps-rose) 13%,transparent);color:color-mix(in srgb,var(--ps-rose) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-card-action[data-busy="true"]{opacity:.75}',
      '.dsh-ps-card-action:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:-1px}',
      '.dsh-ps-card-action:disabled{cursor:not-allowed;opacity:.3}',
      '.dsh-ps-card-progress{position:absolute;top:0;left:14px;right:14px;height:3px;overflow:hidden;border-radius:999px;background:color-mix(in srgb,var(--ps-violet) 14%,transparent)}',
      '.dsh-ps-card-progress-fill{display:block;width:34%;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--ps-violet),var(--ps-indigo));animation:dsh-ps-progress 2.4s ease-in-out infinite}',
      '.dsh-ps-chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;min-width:0;height:22px;padding:0 9px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}',
      '.dsh-ps-chip-path{max-width:150px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}',
      '.dsh-ps-chip-brand{background:color-mix(in srgb,var(--ps-violet) 11%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-chip-success{background:color-mix(in srgb,var(--ps-mint) 12%,transparent);color:color-mix(in srgb,var(--ps-mint) 52%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-chip-error{background:color-mix(in srgb,var(--ps-rose) 11%,transparent);color:color-mix(in srgb,var(--ps-rose) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-chip-warn{background:color-mix(in srgb,var(--ps-amber) 13%,transparent);color:color-mix(in srgb,var(--ps-amber) 55%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-chip-idle{background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-chip-session{background:color-mix(in srgb,var(--ps-blue) 9%,transparent);color:color-mix(in srgb,var(--ps-blue) 48%,var(--dsw-alias-label-primary));border:0}',
      '.dsh-ps-dot{position:relative;flex:none;width:8px;height:8px;margin-top:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
      '.dsh-ps-dot[data-status="running"]{background:color-mix(in srgb,var(--ps-violet) 80%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-dot[data-status="running"]::after{content:"";position:absolute;inset:-4px;border:1px solid color-mix(in srgb,var(--ps-violet) 45%,transparent);border-radius:50%;animation:dsh-ps-pulse-soft 2.2s ease-out infinite}',
      '.dsh-ps-dot[data-status="paused"]{background:var(--ps-amber)}',
      '.dsh-ps-dot[data-status="blocked"]{background:var(--ps-amber)}',
      '.dsh-ps-dot[data-status="done"]{background:var(--ps-mint)}',
      '.dsh-ps-dot[data-status="failed"]{background:var(--ps-rose)}',
      '.dsh-ps-dot[data-status="cancelled"],.dsh-ps-dot[data-status="pending"],.dsh-ps-dot[data-status="idea"]{background:var(--dsw-alias-state-idle-primary)}',
      '.dsh-ps-drawer-layer{position:absolute;inset:0;z-index:40;display:flex;justify-content:flex-end}',
      '.dsh-ps-drawer-mask{position:absolute;inset:0;padding:0;margin:0;border:0;background:color-mix(in srgb,var(--dsw-alias-label-primary) 32%,transparent);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:dsh-ps-fade-in 200ms ease-out;cursor:pointer}',
      '.dsh-ps-drawer{position:relative;display:flex;flex-direction:column;box-sizing:border-box;width:min(680px,100%);height:100%;min-width:0;overflow:hidden;border-left:1px solid var(--dsw-alias-border-l1);border-radius:24px 0 0 24px;background:var(--dsw-alias-bg-layer-1);box-shadow:-30px 0 80px -32px color-mix(in srgb,var(--dsw-alias-label-primary) 45%,transparent);animation:dsh-ps-slide-in 220ms ease-out}',
      '.dsh-ps-drawer:focus-visible{outline:none}',
      '.dsh-ps-drawer-head{display:flex;align-items:flex-start;gap:13px;flex:none;padding:20px 22px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);background:linear-gradient(180deg,color-mix(in srgb,var(--ps-violet) 4%,transparent),transparent)}',
      '.dsh-ps-drawer-avatar{display:inline-flex;align-items:center;justify-content:center;flex:none;width:44px;height:44px;border-radius:16px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-drawer-avatar[data-status="idea"]{background:color-mix(in srgb,var(--ps-violet-soft) 16%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 55%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-drawer-avatar[data-status="pending"]{background:color-mix(in srgb,var(--ps-blue) 13%,transparent);color:color-mix(in srgb,var(--ps-blue) 52%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-drawer-avatar[data-status="running"]{background:color-mix(in srgb,var(--ps-violet) 14%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-drawer-avatar[data-status="paused"]{background:color-mix(in srgb,var(--ps-amber) 15%,transparent);color:color-mix(in srgb,var(--ps-amber) 55%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-drawer-avatar[data-status="blocked"]{background:color-mix(in srgb,var(--ps-amber) 16%,transparent);color:color-mix(in srgb,var(--ps-amber) 52%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-drawer-avatar[data-status="done"]{background:color-mix(in srgb,var(--ps-mint) 14%,transparent);color:color-mix(in srgb,var(--ps-mint) 52%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-drawer-avatar[data-status="failed"]{background:color-mix(in srgb,var(--ps-rose) 13%,transparent);color:color-mix(in srgb,var(--ps-rose) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-drawer-avatar[data-status="cancelled"]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-drawer-titles{display:flex;flex-direction:column;gap:7px;flex:1;min-width:0}',
      '.dsh-ps-drawer-title{margin:0;font-size:18px;font-weight:600;line-height:24px;overflow-wrap:anywhere}',
      '.dsh-ps-drawer-badges{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}',
      '.dsh-ps-drawer-body{display:flex;flex:1;flex-direction:column;gap:13px;min-height:0;overflow-y:auto;padding:18px 22px 22px}',
      '.dsh-ps-drawer-actions{display:flex;flex-wrap:wrap;gap:9px;padding:2px 0}',
      '.dsh-ps-section{display:flex;flex-direction:column;gap:11px;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:18px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 1.5%,transparent)}',
      '.dsh-ps-section-head{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dsh-ps-section-title{display:inline-flex;align-items:center;gap:7px;font-size:13.5px;font-weight:600;line-height:19px;color:var(--dsw-alias-label-primary);white-space:nowrap}',
      '.dsh-ps-section-grow{flex:1;min-width:0}',
      '.dsh-ps-section-hint{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-ps-section-empty{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsh-ps-meta-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px 20px}',
      '.dsh-ps-meta-cell{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.dsh-ps-meta-cell[data-span="2"]{grid-column:1/-1}',
      '.dsh-ps-meta-label{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px;letter-spacing:.02em}',
      '.dsh-ps-meta-value{color:var(--dsw-alias-label-primary);font-size:13px;line-height:19px;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}',
      '.dsh-ps-meta-value-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
      '.dsh-ps-meta-link{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:0;border:0;border-radius:6px;background:transparent;color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary));font:inherit;font-size:13px;line-height:19px;text-align:left;overflow-wrap:anywhere;cursor:pointer}',
      '.dsh-ps-meta-link:hover{text-decoration:underline}',
      '.dsh-ps-meta-link:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:1px}',
      '.dsh-ps-prompt-text{margin:0;max-height:22vh;overflow-y:auto;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.dsh-ps-result-text{margin:0;max-height:40vh;overflow-y:auto;padding:14px 15px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font-size:13px;line-height:21px;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.dsh-ps-result-placeholder{display:flex;align-items:center;justify-content:center;gap:9px;padding:16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:16px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px;text-align:center}',
      '.dsh-ps-result-error{margin:0;padding:11px 13px;border:1px solid color-mix(in srgb,var(--ps-rose) 20%,var(--dsw-alias-border-l1));border-radius:14px;background:color-mix(in srgb,var(--ps-rose) 8%,transparent);color:color-mix(in srgb,var(--ps-rose) 62%,var(--dsw-alias-label-primary));font-size:12.5px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.dsh-ps-hint-box{display:flex;align-items:flex-start;gap:9px;padding:12px 14px;border:1px solid color-mix(in srgb,var(--ps-amber) 20%,var(--dsw-alias-border-l1));border-radius:16px;background:color-mix(in srgb,var(--ps-amber) 8%,transparent);color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:18px;overflow-wrap:anywhere}',
      '.dsh-ps-transcript{display:flex;flex-direction:column;gap:13px;min-width:0}',
      '.dsh-ps-transcript-state{display:flex;align-items:center;justify-content:center;gap:9px;padding:24px 14px;border:1px dashed var(--dsw-alias-border-l2);border-radius:16px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;text-align:center}',
      '.dsh-ps-msg{display:flex;flex-direction:column;gap:5px;max-width:100%}',
      '.dsh-ps-msg-user{align-items:flex-end}',
      '.dsh-ps-msg-assistant{align-items:flex-start}',
      '.dsh-ps-msg-role{color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:14px}',
      '.dsh-ps-msg-bubble{max-width:88%;padding:10px 13px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.dsh-ps-msg-user .dsh-ps-msg-bubble{background:color-mix(in srgb,var(--ps-violet) 9%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--ps-violet) 16%,var(--dsw-alias-border-l1));border-top-right-radius:6px}',
      '.dsh-ps-msg-assistant .dsh-ps-msg-bubble{border-top-left-radius:6px}',
      '.dsh-ps-inline-error{color:color-mix(in srgb,var(--ps-rose) 62%,var(--dsw-alias-label-primary));font-size:12px;line-height:17px}',
      '.dsh-ps-composer{display:flex;flex-direction:column;gap:9px;flex:none;padding:14px 22px 18px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-ps-composer-row{display:flex;align-items:flex-end;gap:10px}',
      '.dsh-ps-composer-row .dsh-ps-textarea{flex:1;min-height:64px;max-height:160px;resize:none;border-radius:18px}',
      '.dsh-ps-composer-hint{display:flex;align-items:flex-start;gap:8px;margin:0;padding:9px 12px;border:1px solid color-mix(in srgb,var(--ps-violet) 16%,var(--dsw-alias-border-l1));border-radius:14px;background:color-mix(in srgb,var(--ps-violet) 7%,transparent);color:var(--dsw-alias-label-primary);font-size:12px;line-height:17px}',
      '.dsh-ps-composer-hint[data-tone="warn"]{border-color:color-mix(in srgb,var(--ps-amber) 22%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--ps-amber) 8%,transparent)}',
      '.dsh-ps-composer-hint-icon{flex:none;margin-top:1px;color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-composer-hint[data-tone="warn"] .dsh-ps-composer-hint-icon{color:color-mix(in srgb,var(--ps-amber) 55%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-chat-disabled{display:flex;align-items:center;gap:9px;margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsh-ps-dialog-layer{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:26px;box-sizing:border-box}',
      '.dsh-ps-dialog-mask{position:absolute;inset:0;background:color-mix(in srgb,var(--dsw-alias-label-primary) 30%,transparent);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:dsh-ps-fade-in 200ms ease-out}',
      '.dsh-ps-dialog{position:relative;display:flex;flex-direction:column;box-sizing:border-box;width:min(600px,100%);max-height:min(88vh,820px);overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:24px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 40px 100px -36px color-mix(in srgb,var(--dsw-alias-label-primary) 48%,transparent),0 4px 14px color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);animation:dsh-ps-dialog-in 220ms ease-out}',
      '.dsh-ps-dialog:focus-visible{outline:none}',
      '.dsh-ps-dialog-head{display:flex;align-items:flex-start;gap:13px;flex:none;padding:22px 24px 12px}',
      '.dsh-ps-dialog-titles{display:flex;flex-direction:column;gap:5px;flex:1;min-width:0}',
      '.dsh-ps-dialog-title{margin:0;font-size:19px;font-weight:600;line-height:25px;letter-spacing:-.01em}',
      '.dsh-ps-dialog-sub{margin:0;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px}',
      '.dsh-ps-dialog-body{display:flex;flex:1;flex-direction:column;gap:16px;min-height:0;overflow-y:auto;padding:4px 24px 8px}',
      '.dsh-ps-dialog-foot{display:flex;align-items:center;gap:10px;flex:none;padding:16px 24px 20px}',
      '.dsh-ps-dialog-foot-grow{flex:1;min-width:0}',
      '.dsh-ps-segmented .dsh-ps-segment{font-weight:600}',
      '.dsh-ps-dialog .dsh-ps-input,.dsh-ps-dialog .dsh-ps-textarea,.dsh-ps-dialog .dsh-ps-select{background:color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,var(--dsw-alias-bg-layer-1))}',
      '.dsh-ps-report-drawer{width:min(920px,100%)}',
      '.dsh-ps-report-body{display:flex;flex:1;min-height:0;overflow:hidden}',
      '.dsh-ps-report-list{display:flex;flex-direction:column;gap:6px;flex:none;box-sizing:border-box;width:232px;min-height:0;overflow-y:auto;padding:12px;border-right:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--ps-violet) 3%,transparent)}',
      '.dsh-ps-report-list::-webkit-scrollbar{width:8px}',
      '.dsh-ps-report-list::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);border:2px solid transparent;border-radius:999px;background-clip:padding-box}',
      '.dsh-ps-report-item{display:flex;flex-direction:column;gap:4px;box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid transparent;border-radius:14px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;transition:background-color 200ms ease-out,border-color 200ms ease-out}',
      '.dsh-ps-report-item:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}',
      '.dsh-ps-report-item[aria-current="true"]{background:color-mix(in srgb,var(--ps-violet) 10%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--ps-violet) 18%,transparent);box-shadow:0 6px 16px -14px color-mix(in srgb,var(--ps-violet) 40%,transparent)}',
      '.dsh-ps-report-item:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:-1px}',
      '.dsh-ps-report-item-date{font-size:12.5px;font-weight:600;line-height:17px;font-variant-numeric:tabular-nums}',
      '.dsh-ps-report-item-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-report-item-tag{display:inline-flex;align-items:center;gap:3px;color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-report-main{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0}',
      '.dsh-ps-report-main-head{display:flex;align-items:center;gap:9px;flex:none;flex-wrap:wrap;padding:12px 18px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dsh-ps-report-main-title{margin:0;font-size:14px;font-weight:600;line-height:20px;font-variant-numeric:tabular-nums}',
      '.dsh-ps-report-main-sub{margin:0;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-report-content-wrap{flex:1;min-height:0;overflow-y:auto;padding:16px 20px 24px}',
      '.dsh-ps-report-pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:21px}',
      '.dsh-ps-report-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;padding:38px 22px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px;text-align:center}',
      '.dsh-ps-report-empty-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap;justify-content:center;margin-top:4px}',
      '.dsh-ps-report-generating{display:inline-flex;align-items:center;gap:8px;font-size:12px;line-height:17px;color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-toasts{position:absolute;top:88px;right:24px;z-index:80;display:flex;flex-direction:column;align-items:flex-end;gap:9px;max-width:min(380px,calc(100% - 36px));pointer-events:none}',
      '.dsh-ps-toast{display:flex;align-items:center;gap:10px;box-sizing:border-box;max-width:100%;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 20px 48px -22px color-mix(in srgb,var(--dsw-alias-label-primary) 42%,transparent),0 2px 8px color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:18px;pointer-events:auto;animation:dsh-ps-toast-in 200ms ease-out}',
      '.dsh-ps-toast-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;border-radius:10px;background:color-mix(in srgb,var(--ps-violet) 10%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-toast[data-tone="success"] .dsh-ps-toast-icon{background:color-mix(in srgb,var(--ps-mint) 13%,transparent);color:color-mix(in srgb,var(--ps-mint) 52%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-toast[data-tone="error"] .dsh-ps-toast-icon{background:color-mix(in srgb,var(--ps-rose) 12%,transparent);color:color-mix(in srgb,var(--ps-rose) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-toast[data-tone="info"] .dsh-ps-toast-icon{background:color-mix(in srgb,var(--ps-blue) 11%,transparent);color:color-mix(in srgb,var(--ps-blue) 52%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-toast-text{flex:1;min-width:0;overflow-wrap:anywhere}',
      '.dsh-ps-toast-close{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color 200ms ease-out,color 200ms ease-out}',
      '.dsh-ps-toast-close:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);color:var(--dsw-alias-label-primary)}',
      '.dsh-ps-toast-close:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:1px}',
      '.dsh-ps-empty-hero{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:56px 26px 52px;border:1px solid var(--dsw-alias-border-l1);border-radius:24px;background:radial-gradient(90% 80% at 50% 0%,color-mix(in srgb,var(--ps-violet) 7%,transparent),transparent 62%),color-mix(in srgb,var(--dsw-alias-label-primary) 1.5%,var(--dsw-alias-bg-layer-1));box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent),0 24px 50px -34px color-mix(in srgb,var(--ps-violet) 30%,transparent);text-align:center}',
      '.dsh-ps-empty-illustration{color:color-mix(in srgb,var(--ps-violet) 45%,var(--dsw-alias-label-secondary));opacity:.9}',
      '.dsh-ps-empty-title{margin:0;font-size:17px;font-weight:600;line-height:23px}',
      '.dsh-ps-empty-hint{margin:0;max-width:460px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      '.dsh-ps-empty-actions{display:flex;align-items:center;justify-content:center;gap:9px;flex-wrap:wrap;margin-top:4px}',
      '.dsh-ps-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:13px;padding:74px 24px;color:var(--dsw-alias-label-secondary);font-size:13px}',
      '.dsh-ps-backup{display:flex;flex-direction:column;gap:10px;min-width:0}',
      '.dsh-ps-backup-summary{display:flex;align-items:center;gap:9px;min-width:0;flex-wrap:wrap;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-backup-summary-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-ps-backup-refresh{display:inline-flex;align-items:center;gap:6px;flex:none;box-sizing:border-box;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;font-weight:600;line-height:1;white-space:nowrap;cursor:pointer;box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent);transition:background-color 200ms ease-out,border-color 200ms ease-out,color 200ms ease-out,opacity 200ms ease-out}',
      '.dsh-ps-backup-refresh:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-layer-1))}',
      '.dsh-ps-backup-refresh:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:1px}',
      '.dsh-ps-backup-refresh:disabled{cursor:not-allowed;opacity:.45}',
      '.dsh-ps-backup-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;min-width:0}',
      '.dsh-ps-backup-row{display:flex;align-items:center;gap:10px;min-width:0;padding:7px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 1.5%,var(--dsw-alias-bg-layer-1))}',
      '.dsh-ps-backup-row-main{display:flex;align-items:baseline;gap:9px;flex:1;min-width:0;flex-wrap:wrap;font-size:12px;line-height:17px}',
      '.dsh-ps-backup-row-time{flex:none;color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}',
      '.dsh-ps-backup-row-meta{color:var(--dsw-alias-label-secondary);font-size:11.5px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-ps-backup-row-actions{display:flex;align-items:center;gap:6px;flex:none;flex-wrap:wrap;justify-content:flex-end}',
      '.dsh-ps-backup-confirm-prompt{font-size:11.5px;line-height:1;color:color-mix(in srgb,var(--ps-amber) 55%,var(--dsw-alias-label-primary));font-weight:600;white-space:nowrap}',
      '.dsh-ps-backup-warning{display:flex;align-items:flex-start;gap:8px;padding:10px 13px;border:1px solid color-mix(in srgb,var(--ps-amber) 22%,var(--dsw-alias-border-l1));border-radius:16px;background:color-mix(in srgb,var(--ps-amber) 8%,transparent);color:var(--dsw-alias-label-primary);font-size:11.5px;line-height:17px}',
      '.dsh-ps-backup-warning-icon{flex:none;margin-top:1px;color:color-mix(in srgb,var(--ps-amber) 55%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-backup-state{display:flex;align-items:center;gap:8px;padding:10px 2px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-webhook-events-wrap{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.dsh-ps-webhook-events{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 24px;min-width:0}',
      '.dsh-ps-webhook-event{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:38px;min-width:0;padding:0 2px}',
      '.dsh-ps-webhook-event-label{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-ps-webhook-event[data-disabled="true"] .dsh-ps-webhook-event-label{color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-webhook-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-width:0;min-height:38px}',
      '.dsh-ps-webhook-status{min-width:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere}',
      '.dsh-ps-webhook-notice{font-size:12px;line-height:17px;color:color-mix(in srgb,var(--ps-mint) 55%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-crash{margin:24px;padding:20px 22px;display:flex;flex-direction:column;gap:9px;border:1px solid color-mix(in srgb,var(--ps-rose) 20%,var(--dsw-alias-border-l1));border-radius:20px;background:color-mix(in srgb,var(--ps-rose) 7%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font-size:13px;line-height:19px}',
      '.dsh-ps-crash-title{font-size:14px;font-weight:600;line-height:20px}',
      '.dsh-ps-crash-hint{margin:0;color:var(--dsw-alias-label-secondary)}',
      /* v9: self-evolution drawer, lesson/skill cards and header badge */
      '.dsh-ps-evo-entry{position:relative}',
      '.dsh-ps-evo-entry-badge{position:absolute;top:-6px;right:-6px;display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:linear-gradient(135deg,var(--ps-violet),var(--ps-indigo));color:var(--ps-white);font-size:10px;font-weight:700;line-height:1;letter-spacing:.01em;box-shadow:0 3px 8px color-mix(in srgb,var(--ps-violet) 48%,transparent);pointer-events:none}',
      '.dsh-ps-evo-drawer{width:min(960px,100%)}',
      '.dsh-ps-evo-head-actions{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap;justify-content:flex-end;margin-left:auto}',
      '.dsh-ps-evo-tabs{display:flex;align-items:center;gap:2px;flex:none;padding:8px 18px 0;border-bottom:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--ps-violet) 2%,transparent)}',
      '.dsh-ps-evo-tab{position:relative;display:inline-flex;align-items:center;gap:7px;box-sizing:border-box;height:40px;padding:0 15px;border:1px solid transparent;border-bottom:2px solid transparent;border-radius:12px 12px 0 0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:600;line-height:1;cursor:pointer;transition:background-color 200ms ease-out,color 200ms ease-out,border-color 200ms ease-out}',
      '.dsh-ps-evo-tab:hover:not([aria-selected="true"]){color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}',
      '.dsh-ps-evo-tab[aria-selected="true"]{color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary));background:color-mix(in srgb,var(--ps-violet) 9%,var(--dsw-alias-bg-layer-1));border-color:var(--dsw-alias-border-l1);border-bottom-color:color-mix(in srgb,var(--ps-violet) 55%,transparent)}',
      '.dsh-ps-evo-tab:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:-2px}',
      '.dsh-ps-evo-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);color:var(--dsw-alias-label-secondary);font-size:10.5px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}',
      '.dsh-ps-evo-tab[aria-selected="true"] .dsh-ps-evo-count{background:color-mix(in srgb,var(--ps-violet) 16%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-evo-panel{display:flex;flex:1;flex-direction:column;min-height:0;animation:dsh-ps-fade-in 200ms ease-out}',
      '.dsh-ps-evo-panel:focus-visible{outline:none}',
      '.dsh-ps-evo-split{display:flex;flex:1;min-height:0;overflow:hidden}',
      '.dsh-ps-evo-list{display:flex;flex-direction:column;gap:6px;flex:none;box-sizing:border-box;width:236px;min-height:0;overflow-y:auto;padding:12px;border-right:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--ps-violet) 3%,transparent)}',
      '.dsh-ps-evo-list::-webkit-scrollbar{width:8px}',
      '.dsh-ps-evo-list::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);border:2px solid transparent;border-radius:999px;background-clip:padding-box}',
      '.dsh-ps-evo-item{display:flex;flex-direction:column;gap:4px;box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid transparent;border-radius:14px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;transition:background-color 200ms ease-out,border-color 200ms ease-out}',
      '.dsh-ps-evo-item:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}',
      '.dsh-ps-evo-item[aria-current="true"]{background:color-mix(in srgb,var(--ps-violet) 10%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--ps-violet) 18%,transparent)}',
      '.dsh-ps-evo-item:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:-1px}',
      '.dsh-ps-evo-item-date{font-size:12.5px;font-weight:600;line-height:17px;font-variant-numeric:tabular-nums}',
      '.dsh-ps-evo-item-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-evo-main{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0}',
      '.dsh-ps-evo-main-head{display:flex;align-items:center;gap:9px;flex:none;flex-wrap:wrap;padding:12px 18px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dsh-ps-evo-main-title{margin:0;font-size:14px;font-weight:600;line-height:20px;font-variant-numeric:tabular-nums}',
      '.dsh-ps-evo-main-sub{margin:0;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-evo-content-wrap{flex:1;min-height:0;overflow-y:auto;padding:16px 20px 24px}',
      '.dsh-ps-evo-pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:21px}',
      '.dsh-ps-evo-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;padding:38px 22px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px;text-align:center}',
      '.dsh-ps-evo-state-actions{display:flex;align-items:center;justify-content:center;gap:9px;flex-wrap:wrap;margin-top:4px}',
      '.dsh-ps-evo-scroll{display:flex;flex:1;flex-direction:column;gap:14px;min-height:0;overflow-y:auto;padding:16px 20px 24px}',
      '.dsh-ps-evo-form{display:flex;flex-direction:column;gap:13px;padding:16px 18px;border:1px solid color-mix(in srgb,var(--ps-violet) 16%,var(--dsw-alias-border-l1));border-radius:18px;background:linear-gradient(135deg,color-mix(in srgb,var(--ps-violet) 4%,var(--dsw-alias-bg-layer-1)) 0%,color-mix(in srgb,var(--ps-violet) 2%,var(--dsw-alias-bg-layer-1)) 100%)}',
      '.dsh-ps-evo-form-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;min-width:0}',
      '.dsh-ps-evo-form-title{display:inline-flex;align-items:center;gap:7px;font-size:13.5px;font-weight:600;line-height:19px;white-space:nowrap}',
      '.dsh-ps-evo-form-hint{flex:1;min-width:0;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-evo-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px 18px;align-items:start}',
      '.dsh-ps-evo-span{grid-column:1/-1;min-width:0}',
      '.dsh-ps-evo-form-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}',
      '.dsh-ps-evo-notice{display:flex;align-items:flex-start;gap:9px;padding:11px 13px;border:1px solid color-mix(in srgb,var(--ps-violet) 16%,var(--dsw-alias-border-l1));border-radius:14px;background:color-mix(in srgb,var(--ps-violet) 6%,transparent);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
      '.dsh-ps-evo-notice[data-tone="warn"]{border-color:color-mix(in srgb,var(--ps-amber) 24%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--ps-amber) 8%,transparent)}',
      '.dsh-ps-evo-notice-icon{flex:none;margin-top:1px;color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-evo-notice[data-tone="warn"] .dsh-ps-evo-notice-icon{color:color-mix(in srgb,var(--ps-amber) 55%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-evo-card{display:flex;flex-direction:column;gap:9px;padding:13px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 1.5%,var(--dsw-alias-bg-layer-1));box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 3%,transparent);animation:dsh-ps-pop-in 180ms ease-out}',
      '.dsh-ps-evo-card[data-inactive="true"]{opacity:.7}',
      '.dsh-ps-evo-card-head{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;min-width:0}',
      '.dsh-ps-evo-card-title{flex:1;min-width:0;margin:0;font-size:13.5px;font-weight:600;line-height:20px;overflow-wrap:anywhere}',
      '.dsh-ps-evo-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;font-weight:700;letter-spacing:-.01em}',
      '.dsh-ps-evo-text{margin:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.dsh-ps-evo-evidence{margin:0;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:17px;overflow-wrap:anywhere}',
      '.dsh-ps-evo-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
      '.dsh-ps-evo-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}',
      '.dsh-ps-evo-actions-grow{flex:1;min-width:0}',
      '.dsh-ps-evo-confirm{font-size:11.5px;font-weight:600;line-height:1;white-space:nowrap;color:color-mix(in srgb,var(--ps-amber) 55%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-evo-status{display:inline-flex;align-items:center;gap:5px;flex:none;height:22px;padding:0 9px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;line-height:1;white-space:nowrap}',
      '.dsh-ps-evo-status[data-status="running"]{background:color-mix(in srgb,var(--ps-violet) 13%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 65%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-evo-status[data-status="ok"],.dsh-ps-evo-status[data-status="active"]{background:color-mix(in srgb,var(--ps-mint) 13%,transparent);color:color-mix(in srgb,var(--ps-mint) 52%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-evo-status[data-status="failed"]{background:color-mix(in srgb,var(--ps-rose) 12%,transparent);color:color-mix(in srgb,var(--ps-rose) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-evo-status[data-status="proposed"]{background:color-mix(in srgb,var(--ps-amber) 14%,transparent);color:color-mix(in srgb,var(--ps-amber) 55%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-evo-status[data-status="disabled"],.dsh-ps-evo-status[data-status="idle"]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-evo-generating{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;line-height:16px;color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-evo-skill-content{margin:0;max-height:300px;overflow-y:auto;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:19px}',
      '@keyframes dsh-ps-spin{to{transform:rotate(360deg)}}',
      '@keyframes dsh-ps-pulse-soft{0%{opacity:.55;transform:scale(.72)}70%,100%{opacity:0;transform:scale(1.5)}}',
      '@keyframes dsh-ps-kpi-breathe{0%{opacity:.55;transform:scale(.85)}70%,100%{opacity:0;transform:scale(1.4)}}',
      '@keyframes dsh-ps-kpi-glow{0%,100%{opacity:.9}50%{opacity:1}}',
      '@keyframes dsh-ps-progress{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}',
      '@keyframes dsh-ps-fade-in{from{opacity:.5}to{opacity:1}}',
      '@keyframes dsh-ps-pop-in{from{opacity:.4;transform:translateY(-4px) scale(.985)}to{opacity:1;transform:none}}',
      '@keyframes dsh-ps-slide-in{from{transform:translateX(26px);opacity:.6}to{transform:none;opacity:1}}',
      '@keyframes dsh-ps-dialog-in{from{transform:translateY(10px) scale(.99);opacity:.6}to{transform:none;opacity:1}}',
      '@keyframes dsh-ps-toast-in{from{transform:translateX(14px);opacity:0}to{transform:none;opacity:1}}',
      '@media (max-width: 1180px){.dsh-ps-board{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '@media (max-width: 820px){.dsh-ps-board{grid-template-columns:minmax(0,1fr)}}',
      '@media (max-width: 720px){.dsh-ps-report-body{flex-direction:column}.dsh-ps-report-list{width:100%;max-height:180px;flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsh-ps-report-item{width:auto;min-width:150px}}',
      '@media (max-width: 640px){.dsh-ps-page{padding-left:14px;padding-right:14px;padding-bottom:30px}.dsh-ps-title{font-size:19px}.dsh-ps-header{gap:6px}.dsh-ps-header-actions{gap:5px}.dsh-ps-view-btn{height:26px;padding:0 9px;font-size:12px}.dsh-ps-column-hint{display:none}.dsh-ps-meta-grid{grid-template-columns:minmax(0,1fr)}.dsh-ps-dialog-layer{padding:12px}.dsh-ps-dialog-head{padding:18px 18px 10px}.dsh-ps-dialog-body{padding:4px 18px 8px}.dsh-ps-dialog-foot{padding:14px 18px 18px}.dsh-ps-drawer-body{padding:16px 18px 20px}.dsh-ps-composer{padding:12px 18px 16px}.dsh-ps-two-col{grid-template-columns:minmax(0,1fr)}.dsh-ps-settings-grid{grid-template-columns:minmax(0,1fr)}}',
      '@media (pointer: coarse){.dsh-ps-card-actions{opacity:1;transform:none;pointer-events:auto}.dsh-ps-grip{opacity:.9}}',
      '@media (prefers-reduced-motion: reduce){.dsh-ps-card,.dsh-ps-card::before,.dsh-ps-btn,.dsh-ps-switch,.dsh-ps-switch-thumb,.dsh-ps-segment,.dsh-ps-dropzone,.dsh-ps-card-actions,.dsh-ps-kpi,.dsh-ps-funnel,.dsh-ps-col-filter-option,.dsh-ps-col-search-clear,.dsh-ps-col-filter-clear,.dsh-ps-report-item,.dsh-ps-backup-refresh,.dsh-ps-toast-close{transition:none}.dsh-ps-spinner,.dsh-ps-dot[data-status="running"]::after,.dsh-ps-card-progress-fill,.dsh-ps-kpi-pulse::after,.dsh-ps-kpi-bar[data-active="true"] .dsh-ps-kpi-bar-fill,.dsh-ps-drawer,.dsh-ps-dialog,.dsh-ps-toast,.dsh-ps-drawer-mask,.dsh-ps-dialog-mask,.dsh-ps-banner,.dsh-ps-settings,.dsh-ps-col-popover,.dsh-ps-toast-stack{animation:none}.dsh-ps-card:hover,.dsh-ps-kpi:hover,.dsh-ps-funnel:hover:not(:disabled),.dsh-ps-btn-primary:hover:not(:disabled),.dsh-ps-btn:hover:not(:disabled){transform:none}}',
      '@media (prefers-reduced-motion: reduce){.dsh-ps-card::before{transition:none}}',
      '@media (max-width: 720px){.dsh-ps-evo-split{flex-direction:column}.dsh-ps-evo-list{width:100%;max-height:200px;flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsh-ps-evo-item{width:auto;min-width:160px}}',
      '@media (max-width: 640px){.dsh-ps-evo-form-grid{grid-template-columns:minmax(0,1fr)}.dsh-ps-evo-head-actions{width:100%;justify-content:flex-start;margin-left:0}.dsh-ps-evo-tabs{padding-left:12px;padding-right:12px}.dsh-ps-evo-tab{padding:0 11px}.dsh-ps-evo-scroll,.dsh-ps-evo-content-wrap{padding-left:14px;padding-right:14px}}',
      '@media (prefers-reduced-motion: reduce){.dsh-ps-evo-tab,.dsh-ps-evo-item,.dsh-ps-evo-card,.dsh-ps-evo-entry-badge{transition:none}.dsh-ps-evo-panel,.dsh-ps-evo-card{animation:none}.dsh-ps-evo-tab:hover{background:transparent}}',
      // ---- v0.6: view shell / today workbench / notifications -----------------
      '.dsh-ps-header-mid{display:flex;align-items:center;gap:8px;padding-top:0;min-width:0;flex:none}',
      '.dsh-ps-views{display:inline-flex;align-items:center;gap:2px;padding:3px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-layer-1))}',
      '.dsh-ps-view-btn{display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 14px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;font-weight:600;line-height:1;white-space:nowrap;cursor:pointer;transition:background-color 200ms ease-out,color 200ms ease-out,box-shadow 200ms ease-out}',
      '.dsh-ps-view-btn:hover:not([aria-selected="true"]){color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}',
      '.dsh-ps-view-btn[aria-selected="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent)}',
      '.dsh-ps-view-btn:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:2px}',
      '.dsh-ps-notif-wrap{position:relative;display:inline-flex;flex:none}',
      '.dsh-ps-bell{position:relative;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:38px;height:38px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color 200ms ease-out,border-color 200ms ease-out,color 200ms ease-out,transform 200ms ease-out}',
      '.dsh-ps-bell:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);transform:translateY(-1px)}',
      '.dsh-ps-bell[data-unread="true"]{color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary));border-color:color-mix(in srgb,var(--ps-violet) 24%,var(--dsw-alias-border-l1))}',
      '.dsh-ps-bell:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:2px}',
      '.dsh-ps-bell-badge{position:absolute;top:-5px;right:-5px;display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:17px;padding:0 4px;border-radius:999px;background:var(--ps-rose);color:var(--ps-white);font-size:10px;font-weight:700;line-height:17px;font-variant-numeric:tabular-nums;box-shadow:0 2px 6px color-mix(in srgb,var(--ps-rose) 45%,transparent)}',
      '.dsh-ps-notif-popover{position:absolute;top:calc(100% + 8px);right:0;z-index:70;display:flex;flex-direction:column;gap:2px;width:min(360px,calc(100vw - 40px));max-height:min(72vh,560px);overflow-y:auto;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:20px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 28px 70px -30px color-mix(in srgb,var(--dsw-alias-label-primary) 55%,transparent),0 4px 14px -6px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);animation:dsh-ps-pop-in 180ms ease-out}',
      '.dsh-ps-notif-head{display:flex;align-items:center;gap:8px;padding:0 2px 8px}',
      '.dsh-ps-notif-title{font-size:13.5px;font-weight:600;line-height:19px}',
      '.dsh-ps-notif-unread{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;background:color-mix(in srgb,var(--ps-rose) 12%,transparent);color:color-mix(in srgb,var(--ps-rose) 62%,var(--dsw-alias-label-primary));font-size:10.5px;font-weight:700;line-height:1}',
      '.dsh-ps-notif-section{padding:9px 0 2px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dsh-ps-notif-section-title{margin:0 0 5px;padding:0 2px;font-size:10.5px;font-weight:600;letter-spacing:.03em;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-notif-item{display:flex;align-items:center;gap:9px;width:100%;min-width:0;min-height:38px;padding:7px 8px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;transition:background-color 160ms ease-out}',
      '.dsh-ps-notif-item:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent)}',
      '.dsh-ps-notif-item:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:-1px}',
      '.dsh-ps-notif-item-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;line-height:18px;font-weight:600}',
      '.dsh-ps-notif-item-hint{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dsh-ps-notif-empty{margin:0;padding:16px 8px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);text-align:center}',
      '.dsh-ps-notif-foot{display:flex;justify-content:flex-end;padding-top:9px;margin-top:4px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dsh-ps-today{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:start}',
      '.dsh-ps-today-main{display:flex;flex-direction:column;gap:14px;min-width:0}',
      '.dsh-ps-today-side{display:flex;flex-direction:column;gap:14px;min-width:0}',
      '.dsh-ps-greet{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:2px 2px 0}',
      '.dsh-ps-greet-main{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dsh-ps-greet-date{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;line-height:17px;color:color-mix(in srgb,var(--ps-violet-deep) 60%,var(--dsw-alias-label-secondary));font-variant-numeric:tabular-nums}',
      '.dsh-ps-greet-line{margin:0;font-size:17px;font-weight:600;line-height:25px;letter-spacing:-.015em;overflow-wrap:anywhere}',
      '.dsh-ps-watch{display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid color-mix(in srgb,var(--ps-violet) 18%,var(--dsw-alias-border-l1));border-radius:16px;background:color-mix(in srgb,var(--ps-violet) 6%,var(--dsw-alias-bg-layer-1));box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent)}',
      '.dsh-ps-watch-label{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;white-space:nowrap;color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-watch-metrics{display:flex;align-items:center;gap:10px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.dsh-ps-capture{display:flex;align-items:center;gap:8px;min-width:0;height:42px;padding:0 4px 0 13px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);transition:border-color 200ms ease-out,box-shadow 200ms ease-out}',
      '.dsh-ps-capture:focus-within{border-color:color-mix(in srgb,var(--ps-violet) 38%,var(--dsw-alias-border-l1));box-shadow:0 0 0 4px color-mix(in srgb,var(--ps-violet) 10%,transparent)}',
      '.dsh-ps-capture-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:11px;background:color-mix(in srgb,var(--ps-violet) 10%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-capture-input{flex:1;min-width:0;height:40px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13.5px;line-height:20px;outline:none}',
      '.dsh-ps-capture-input::placeholder{color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-capture-submit{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:34px;padding:0 14px;border:0;border-radius:999px;background:linear-gradient(135deg,var(--ps-violet) 0%,var(--ps-indigo) 100%);color:var(--ps-white);font:inherit;font-size:12.5px;font-weight:600;line-height:1;white-space:nowrap;cursor:pointer;box-shadow:0 10px 22px -12px color-mix(in srgb,var(--ps-violet) 58%,transparent);transition:filter 160ms ease-out,transform 160ms ease-out,opacity 160ms ease-out}',
      '.dsh-ps-capture-submit:hover:not(:disabled){filter:brightness(1.05);transform:translateY(-1px)}',
      '.dsh-ps-capture-submit:disabled{cursor:not-allowed;opacity:.45;transform:none}',
      '.dsh-ps-capture-submit:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:2px}',
      '.dsh-ps-today-section{display:flex;flex-direction:column;gap:10px;min-width:0;padding:15px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:22px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 90%,transparent);box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent)}',
      '.dsh-ps-today-sec-head{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dsh-ps-today-sec-icon{display:inline-flex;flex:none;color:color-mix(in srgb,var(--ps-violet-deep) 56%,var(--dsw-alias-label-secondary))}',
      '.dsh-ps-today-sec-title{margin:0;font-size:14px;font-weight:600;line-height:20px;letter-spacing:-.01em;white-space:nowrap}',
      '.dsh-ps-today-sec-count{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:23px;padding:0 8px;border-radius:999px;background:color-mix(in srgb,var(--ps-violet) 11%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary));font-size:12.5px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}',
      '.dsh-ps-today-sec-grow{flex:1;min-width:4px}',
      '.dsh-ps-today-empty{margin:0;padding:12px 4px 6px;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary);text-align:center}',
      '.dsh-ps-today-list{display:flex;flex-direction:column;gap:8px;min-width:0;margin:0;padding:0;list-style:none}',
      '.dsh-ps-today-row{display:flex;align-items:center;gap:10px;min-width:0;padding:9px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:15px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-ps-today-row[data-clickable="true"]{cursor:pointer;transition:border-color 160ms ease-out,background-color 160ms ease-out}',
      '.dsh-ps-today-row[data-clickable="true"]:hover{border-color:var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-label-primary) 2%,var(--dsw-alias-bg-layer-1))}',
      '.dsh-ps-today-row[data-kind="blocked"]{border-left:3px solid color-mix(in srgb,var(--ps-amber) 62%,transparent);padding-left:9px}',
      '.dsh-ps-today-row[data-kind="paused"]{border-left:3px solid color-mix(in srgb,var(--ps-amber) 40%,transparent);padding-left:9px}',
      '.dsh-ps-today-row[data-kind="failed"]{border-left:3px solid color-mix(in srgb,var(--ps-rose) 55%,transparent);padding-left:9px}',
      '.dsh-ps-today-main-col{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}',
      '.dsh-ps-today-title{font-size:13px;font-weight:600;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-ps-today-hint{font-size:12.5px;line-height:17px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-ps-today-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:none;justify-content:flex-end}',
      '.dsh-ps-today-time{flex:none;min-width:46px;font-size:12.5px;line-height:17px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dsh-ps-today-done-body{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}',
      '.dsh-ps-today-result{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-ps-today-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:2px}',
      '.dsh-ps-today-foot-text{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dsh-ps-brief-card{background:radial-gradient(120% 120% at 100% 0%,color-mix(in srgb,var(--ps-violet) 9%,transparent),transparent 62%),color-mix(in srgb,var(--dsw-alias-bg-layer-1) 92%,transparent)}',
      '.dsh-ps-brief-card[data-state="unsupported"]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 2%,var(--dsw-alias-bg-layer-1));border-style:dashed}',
      '.dsh-ps-brief-snippet{margin:0;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary);display:-webkit-box;overflow:hidden;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}',
      '.dsh-ps-brief-meta{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dsh-ps-brief-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsh-ps-brief-actions .dsh-ps-btn{height:36px}',
      '.dsh-ps-side-card{padding:14px 16px}',
      '.dsh-ps-ledger-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
      '.dsh-ps-ledger-cell{display:flex;flex-direction:column;gap:2px;min-width:0;padding:9px 11px;border-radius:14px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}',
      '.dsh-ps-ledger-value{font-size:18px;font-weight:700;line-height:23px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}',
      '.dsh-ps-ledger-label{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);font-weight:500}',
      '.dsh-ps-side-hint{margin:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-shortcuts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
      '.dsh-ps-shortcut{display:inline-flex;align-items:center;justify-content:flex-start;gap:7px;height:38px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;font-weight:600;white-space:nowrap;cursor:pointer;transition:border-color 160ms ease-out,background-color 160ms ease-out,transform 160ms ease-out}',
      '.dsh-ps-shortcut:hover{border-color:var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-layer-1));transform:translateY(-1px)}',
      '.dsh-ps-shortcut:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:2px}',
      '.dsh-ps-shortcut span{overflow:hidden;text-overflow:ellipsis}',
      '.dsh-ps-webhook-line{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-webhook-line strong{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dsh-ps-today-shell{display:flex;flex-direction:column;gap:14px;min-width:0}',
      '.dsh-ps-today .dsh-ps-btn,.dsh-ps-today .dsh-ps-btn-sm{height:36px}',
      '.dsh-ps-brief-drawer{width:min(720px,100%)}',
      '.dsh-ps-log-list{display:flex;flex-direction:column;gap:7px;max-height:min(58vh,540px);overflow-y:auto;padding:2px}',
      '.dsh-ps-log-row{display:flex;align-items:flex-start;gap:10px;min-width:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-ps-log-main{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}',
      '.dsh-ps-log-event{font-size:12.5px;font-weight:600;line-height:18px}',
      '.dsh-ps-log-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dsh-ps-log-error{margin:0;font-size:11.5px;line-height:17px;color:color-mix(in srgb,var(--ps-rose) 62%,var(--dsw-alias-label-primary));overflow-wrap:anywhere}',
      '.dsh-ps-log-state{display:inline-flex;align-items:center;flex:none;height:20px;padding:0 8px;border-radius:999px;font-size:10.5px;font-weight:700;line-height:1}',
      '.dsh-ps-log-state[data-ok="true"]{background:color-mix(in srgb,var(--ps-mint) 13%,transparent);color:color-mix(in srgb,var(--ps-mint) 55%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-log-state[data-ok="false"]{background:color-mix(in srgb,var(--ps-rose) 12%,transparent);color:color-mix(in srgb,var(--ps-rose) 62%,var(--dsw-alias-label-primary))}',
      '@media (max-width: 1000px){.dsh-ps-today{grid-template-columns:minmax(0,1fr)}.dsh-ps-today-side{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));align-items:start}}',
      '@media (max-width: 1000px){.dsh-ps-title{font-size:22px}.dsh-ps-subtitle{font-size:12.5px}.dsh-ps-view-btn{height:28px;padding:0 11px}.dsh-ps-header-actions .dsh-ps-btn{padding:0 11px}}',
      '@media (max-width: 900px){.dsh-ps-header-actions .dsh-ps-btn-label{display:none}.dsh-ps-header-actions .dsh-ps-btn{width:36px;height:36px;padding:0;justify-content:center}.dsh-ps-header-actions .dsh-ps-btn-primary{width:36px}.dsh-ps-subtitle{display:none}.dsh-ps-title{font-size:20px}}',
      '@media (max-width: 640px){.dsh-ps-today-section{padding:13px 13px}.dsh-ps-today-row{flex-wrap:wrap}.dsh-ps-today-actions{width:100%;justify-content:flex-start}.dsh-ps-capture{height:42px;padding:0 3px 0 11px}}',
      '@media (prefers-reduced-motion: reduce){.dsh-ps-view-btn,.dsh-ps-bell,.dsh-ps-capture,.dsh-ps-capture-submit,.dsh-ps-today-row,.dsh-ps-shortcut,.dsh-ps-notif-item{transition:none}.dsh-ps-notif-popover{animation:none}}',
      // ---- v0.7: minimal today page, task status bar, merged review drawer --
      '.dsh-ps-today-page{display:flex;flex-direction:column;gap:14px;width:100%;max-width:none;min-width:0;margin:0}',
      '.dsh-ps-greet-row{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding:2px 2px 0;min-width:0}',
      '.dsh-ps-greet-row .dsh-ps-greet-date{flex:none;font-weight:600}',
      '.dsh-ps-greet-line{margin:0;font-size:15px;font-weight:500;line-height:23px;color:var(--dsw-alias-label-secondary);min-width:0}',
      '.dsh-ps-brief-lines{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none}',
      '.dsh-ps-brief-line{margin:0;font-size:13.5px;line-height:21px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
      '.dsh-ps-brief-line::before{content:"·";margin-right:7px;color:color-mix(in srgb,var(--ps-violet-deep) 45%,var(--dsw-alias-label-secondary))}',
      '.dsh-ps-brief-suggest{display:flex;flex-direction:column;gap:7px;margin-top:2px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);min-width:0}',
      '.dsh-ps-brief-suggest-title{margin:0;font-size:12.5px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary);letter-spacing:.01em}',
      '.dsh-ps-brief-suggest-row{display:flex;align-items:center;gap:10px;min-width:0;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 2%,var(--dsw-alias-bg-layer-1))}',
      '.dsh-ps-brief-suggest-text{flex:1;min-width:0;font-size:13px;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-ps-brief-suggest-text strong{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsh-ps-brief-suggest-reason{color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-brief-suggest .dsh-ps-btn{height:32px;flex:none}',
      '.dsh-ps-today-page .dsh-ps-today-section{padding:14px 16px}',
      '.dsh-ps-today-page .dsh-ps-today-sec-title{font-size:14px}',
      '.dsh-ps-today-page .dsh-ps-today-empty{padding:8px 4px 2px;font-size:12.5px}',
      '.dsh-ps-today-page .dsh-ps-today-row{padding:8px 11px}',
      '.dsh-ps-today-page .dsh-ps-today-title{font-size:13.5px;line-height:19px}',
      '.dsh-ps-today-page .dsh-ps-today-actions .dsh-ps-btn{height:32px}',
      '.dsh-ps-today-more{margin:2px 0 0;padding:2px 2px 0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-today-tag{display:inline-flex;align-items:center;flex:none;height:22px;padding:0 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);color:var(--dsw-alias-label-secondary);font-size:12.5px;font-weight:600;line-height:1;white-space:nowrap}',
      '.dsh-ps-today-tag[data-kind="blocked"],.dsh-ps-today-tag[data-kind="paused"]{background:color-mix(in srgb,var(--ps-amber) 14%,transparent);color:color-mix(in srgb,var(--ps-amber) 55%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-today-tag[data-kind="failed"]{background:color-mix(in srgb,var(--ps-rose) 12%,transparent);color:color-mix(in srgb,var(--ps-rose) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-today-tag[data-kind="skills"]{background:color-mix(in srgb,var(--ps-violet) 11%,transparent);color:color-mix(in srgb,var(--ps-violet-deep) 62%,var(--dsw-alias-label-primary))}',
      '.dsh-ps-today-foot{display:flex;align-items:center;justify-content:flex-start;gap:6px;flex-wrap:wrap;padding:2px 4px 6px;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-today-foot-sep{color:color-mix(in srgb,var(--dsw-alias-label-primary) 28%,transparent)}',
      '.dsh-ps-foot-link{display:inline-flex;align-items:center;gap:4px;padding:0;border:0;background:transparent;color:var(--dsw-alias-link);font:inherit;font-size:12.5px;line-height:19px;cursor:pointer}',
      '.dsh-ps-foot-link:hover{text-decoration:underline}',
      '.dsh-ps-foot-link:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:2px;border-radius:6px}',
      '.dsh-ps-taskbar{display:flex;align-items:center;gap:14px;min-width:0;height:44px;min-height:44px;max-height:44px;padding:0 2px;flex-wrap:nowrap;overflow:hidden}',
      '.dsh-ps-taskbar-counts{display:flex;align-items:center;gap:14px;min-width:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.dsh-ps-taskbar-counts strong{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsh-ps-taskbar-grow{flex:1;min-width:8px}',
      '.dsh-ps-taskbar-switch{display:inline-flex;align-items:center;gap:8px;flex:none;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dsh-ps-taskbar-search{position:relative;display:flex;align-items:center;flex:1 1 200px;min-width:120px;height:32px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-layer-1));transition:border-color 180ms ease-out,box-shadow 180ms ease-out}',
      '.dsh-ps-taskbar-search:focus-within{border-color:color-mix(in srgb,var(--ps-violet) 38%,var(--dsw-alias-border-l1));box-shadow:0 0 0 3px color-mix(in srgb,var(--ps-violet) 10%,transparent)}',
      '.dsh-ps-taskbar-search-icon{position:absolute;left:11px;display:inline-flex;color:var(--dsw-alias-label-secondary);pointer-events:none}',
      '.dsh-ps-taskbar-input{width:100%;height:30px;padding:0 30px 0 32px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;outline:none}',
      '.dsh-ps-taskbar-input::placeholder{color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-taskbar-clear{position:absolute;right:5px;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dsh-ps-taskbar-clear:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);color:var(--dsw-alias-label-primary)}',
      '.dsh-ps-review-drawer{width:min(960px,100%)}',
      '.dsh-ps-review-tabs{display:flex;align-items:center;gap:2px;flex:none;padding:0 20px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto}',
      '.dsh-ps-review-tab{display:inline-flex;align-items:center;gap:6px;height:42px;padding:0 14px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:600;white-space:nowrap;cursor:pointer;transition:color 160ms ease-out,border-color 160ms ease-out}',
      '.dsh-ps-review-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);border-bottom-color:color-mix(in srgb,var(--ps-violet) 65%,transparent)}',
      '.dsh-ps-review-tab:hover:not([aria-selected="true"]){color:var(--dsw-alias-label-primary)}',
      '.dsh-ps-review-tab:focus-visible{outline:2px solid color-mix(in srgb,var(--ps-violet) 55%,transparent);outline-offset:-2px}',
      '.dsh-ps-review-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--ps-rose) 12%,transparent);color:color-mix(in srgb,var(--ps-rose) 60%,var(--dsw-alias-label-primary));font-size:10.5px;font-weight:700;line-height:1}',
      '.dsh-ps-review-body{display:flex;flex:1;min-height:0;overflow:hidden}',
      '.dsh-ps-review-embedded{display:flex;flex:1;flex-direction:column;min-height:0;overflow:hidden}',
      '.dsh-ps-review-embedded .dsh-ps-report-body{flex:1;min-height:0}',
      '.dsh-ps-review-embedded .dsh-ps-evo-panel{flex:1;min-height:0;overflow:hidden}',
      '.dsh-ps-review-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:none;padding:10px 20px;border-bottom:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-primary) 2%,transparent)}',
      '.dsh-ps-review-toolbar-status{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-ps-review-toolbar-grow{flex:1;min-width:6px}',
      '@media (max-width: 900px){.dsh-ps-taskbar{gap:8px}.dsh-ps-taskbar-counts{gap:9px}.dsh-ps-taskbar-switch span{display:none}}',
      '@media (max-width: 640px){.dsh-ps-today-page{gap:11px}.dsh-ps-today-page .dsh-ps-today-section{padding:12px 13px}.dsh-ps-review-tabs{padding:0 10px}.dsh-ps-review-tab{padding:0 10px;height:38px}.dsh-ps-brief-suggest-row{flex-wrap:wrap}.dsh-ps-brief-suggest-text{white-space:normal}.dsh-ps-today-row{flex-wrap:wrap}.dsh-ps-today-actions{width:100%;justify-content:flex-start}}',
      '@media (prefers-reduced-motion: reduce){.dsh-ps-taskbar-search,.dsh-ps-taskbar-clear,.dsh-ps-review-tab,.dsh-ps-foot-link{transition:none}}',
      // ---- v0.7.1: dark theme readability / calmer wide-screen glow -----------
      'body[data-ds-dark-theme] .dsh-ps-panel{background:radial-gradient(58% 40% at 8% -6%,color-mix(in srgb,var(--ps-violet) 6%,transparent),transparent 60%),radial-gradient(50% 34% at 96% 0%,color-mix(in srgb,var(--ps-blue) 5%,transparent),transparent 62%),linear-gradient(180deg,color-mix(in srgb,var(--ps-violet) 2.5%,var(--dsw-alias-bg-base)) 0%,var(--dsw-alias-bg-base) 58%,color-mix(in srgb,var(--ps-violet) 1.5%,var(--dsw-alias-bg-base)) 100%)}',
      'body[data-ds-dark-theme] .dsh-ps-today-section,body[data-ds-dark-theme] .dsh-ps-card,body[data-ds-dark-theme] .dsh-ps-section{border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,var(--dsw-alias-bg-base))}',
      'body[data-ds-dark-theme] .dsh-ps-column{border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,var(--dsw-alias-bg-base))}',
      'body[data-ds-dark-theme] .dsh-ps-today-hint,body[data-ds-dark-theme] .dsh-ps-today-more,body[data-ds-dark-theme] .dsh-ps-greet-line,body[data-ds-dark-theme] .dsh-ps-today-result,body[data-ds-dark-theme] .dsh-ps-today-foot,body[data-ds-dark-theme] .dsh-ps-brief-meta,body[data-ds-dark-theme] .dsh-ps-card-context,body[data-ds-dark-theme] .dsh-ps-card-meta-item,body[data-ds-dark-theme] .dsh-ps-column-hint,body[data-ds-dark-theme] .dsh-ps-subtitle,body[data-ds-dark-theme] .dsh-ps-section-hint{color:color-mix(in srgb,var(--dsw-alias-label-secondary) 55%,var(--dsw-alias-label-primary))}',
      'body[data-ds-dark-theme] .dsh-ps-today-row[data-clickable="true"]:hover,body[data-ds-dark-theme] .dsh-ps-brief-suggest-row{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base))}',
      // shared readability tweaks (both themes)
      '.dsh-ps-brief-line{font-size:14px;line-height:22px}',
      '.dsh-ps-capture-input::placeholder,.dsh-ps-taskbar-input::placeholder{color:color-mix(in srgb,var(--dsw-alias-label-primary) 62%,transparent)}',
      '.dsh-ps-today-foot{font-size:12.5px}'
    ].join('\n')

    // ------------------------------------------------------------------ helpers

    function pad2(value) {
      return value < 10 ? '0' + value : String(value)
    }

    function formatTime(value) {
      if (typeof value !== 'number' || !isFinite(value) || value <= 0) return '—'
      const date = new Date(value)
      if (isNaN(date.getTime())) return '—'
      return pad2(date.getMonth() + 1) + '/' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
    }

    function formatFullTime(value) {
      if (typeof value !== 'number' || !isFinite(value) || value <= 0) return '—'
      const date = new Date(value)
      if (isNaN(date.getTime())) return '—'
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
    }

    function formatDuration(ms) {
      if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '0s'
      const totalSeconds = Math.floor(ms / 1000)
      const seconds = totalSeconds % 60
      const minutes = Math.floor(totalSeconds / 60) % 60
      const hours = Math.floor(totalSeconds / 3600)
      if (hours > 0) return hours + 'h ' + pad2(minutes) + 'm'
      if (minutes > 0) return minutes + 'm ' + pad2(seconds) + 's'
      return seconds + 's'
    }

    function formatRelativeTime(t, value, now) {
      if (typeof value !== 'number' || !isFinite(value) || value <= 0) return '—'
      const current = typeof now === 'number' && isFinite(now) ? now : Date.now()
      const diff = Math.max(0, current - value)
      if (diff < 60 * 1000) return t('justNow')
      if (diff < 60 * 60 * 1000) return t('minutesAgo', { count: Math.floor(diff / (60 * 1000)) })
      if (diff < 24 * 60 * 60 * 1000) return t('hoursAgo', { count: Math.floor(diff / (60 * 60 * 1000)) })
      if (diff < 7 * 24 * 60 * 60 * 1000) return t('daysAgo', { count: Math.floor(diff / (24 * 60 * 60 * 1000)) })
      return formatTime(value)
    }

    function formatNumber(value) {
      if (typeof value !== 'number' || !isFinite(value)) return '0'
      const rounded = Math.round(value)
      return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    function formatTokens(value) {
      if (typeof value !== 'number' || !isFinite(value) || value <= 0) return '0'
      if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M'
      if (value >= 1000) return (value / 1000).toFixed(1) + 'k'
      return String(Math.round(value))
    }

    // Card meta needs a very short stamp: clock for today, M/D otherwise.
    function formatCompactStamp(t, value, now) {
      if (typeof value !== 'number' || !isFinite(value) || value <= 0) return '—'
      const date = new Date(value)
      if (isNaN(date.getTime())) return '—'
      if (isSameLocalDay(value, now)) return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
      return (date.getMonth() + 1) + '/' + date.getDate()
    }

    function formatBytes(value) {
      if (typeof value !== 'number' || !isFinite(value) || value <= 0) return '0 B'
      if (value < 1024) return Math.round(value) + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / (1024 * 1024)).toFixed(1) + ' MB'
    }

    function dateKey(value) {
      const date = value instanceof Date ? value : new Date(value)
      if (isNaN(date.getTime())) return ''
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
    }

    function todayKey() {
      return dateKey(new Date())
    }

    // Local-calendar-day comparison for the KPI「今日 +N」sub-lines.
    function isSameLocalDay(value, reference) {
      if (typeof value !== 'number' || !isFinite(value) || value <= 0) return false
      const date = new Date(value)
      if (isNaN(date.getTime())) return false
      const ref = typeof reference === 'number' && isFinite(reference) ? new Date(reference) : new Date()
      return date.getFullYear() === ref.getFullYear() &&
        date.getMonth() === ref.getMonth() &&
        date.getDate() === ref.getDate()
    }

    function isAbsolutePath(value) {
      if (typeof value !== 'string') return false
      if (value.charAt(0) === '/') return true
      if (/^[A-Za-z]:[\\/]/.test(value)) return true
      return /^\\\\/.test(value)
    }

    function shortenPath(value) {
      if (typeof value !== 'string' || value === '') return ''
      const trimmed = value.replace(/[\\/]+$/, '')
      const parts = trimmed.split(/[\\/]/).filter(function (part) { return part !== '' })
      if (parts.length <= 2) return value
      return '…/' + parts.slice(parts.length - 2).join('/')
    }

    function basenameOf(value) {
      if (typeof value !== 'string' || value === '') return ''
      const trimmed = value.replace(/[\\/]+$/, '')
      const parts = trimmed.split(/[\\/]/).filter(function (part) { return part !== '' })
      if (parts.length === 0) return value
      return parts[parts.length - 1]
    }

    function statusLabel(t, status) {
      if (status === 'idea') return t('statusIdea')
      if (status === 'running') return t('statusRunning')
      if (status === 'paused') return t('statusPaused')
      if (status === 'blocked') return t('statusBlocked')
      if (status === 'done') return t('statusDone')
      if (status === 'failed') return t('statusFailed')
      if (status === 'cancelled') return t('statusCancelled')
      return t('statusPending')
    }

    function statusTone(status) {
      if (status === 'running') return 'brand'
      if (status === 'paused' || status === 'blocked') return 'warn'
      if (status === 'done') return 'success'
      if (status === 'failed') return 'error'
      return 'idle'
    }

    function normalizePriority(value) {
      return PRIORITY_VALUES.indexOf(value) >= 0 ? value : DEFAULT_PRIORITY
    }

    function priorityLabel(t, priority) {
      if (priority === 'urgent') return t('priorityUrgent')
      if (priority === 'high') return t('priorityHigh')
      if (priority === 'low') return t('priorityLow')
      return t('priorityNormal')
    }

    function priorityTone(priority) {
      if (priority === 'urgent') return 'error'
      if (priority === 'high') return 'warn'
      if (priority === 'low') return 'idle'
      return 'idle'
    }

    function isDraggableStatus(status) {
      return DRAGGABLE_STATUSES.indexOf(status) >= 0
    }

    function columnKeyOfStatus(status) {
      if (status === 'idea') return 'idea'
      if (status === 'pending') return 'pending'
      if (isClaimedStatus(status)) return 'claimed'
      return 'ended'
    }

    function isEndedStatus(status) {
      return ENDED_STATUSES.indexOf(status) >= 0
    }

    function isClaimedStatus(status) {
      return CLAIMED_STATUSES.indexOf(status) >= 0
    }

    function taskModelLabel(task) {
      if (!task || typeof task !== 'object') return ''
      const provider = typeof task.provider === 'string' ? task.provider : ''
      const model = typeof task.model === 'string' ? task.model : ''
      const effort = typeof task.reasoningEffort === 'string' && task.reasoningEffort !== '' ? task.reasoningEffort : ''
      let label = ''
      if (model !== '') label = model
      else if (provider !== '') label = provider
      if (label === '') return ''
      if (provider !== '' && model !== '' && provider !== model) label = provider + '/' + model
      if (effort !== '') label = label + ' · ' + effort
      return label
    }

    function taskDurationMs(task, now) {
      if (!task || typeof task !== 'object') return 0
      if (task.result && typeof task.result.durationMs === 'number' && task.result.durationMs > 0) return task.result.durationMs
      if (task.startedAt > 0) {
        let end = task.endedAt
        if (!end && (task.status === 'running' || task.status === 'blocked') && typeof now === 'number' && isFinite(now)) end = now
        if (end && end > task.startedAt) return Math.max(0, end - task.startedAt)
      }
      return 0
    }

    function taskTimestamp(task) {
      if (!task || typeof task !== 'object') return 0
      return task.endedAt || task.updatedAt || task.startedAt || task.createdAt || 0
    }

    function normalizeUsage(raw) {
      if (!raw || typeof raw !== 'object') return null
      const usage = {
        inputTokens: typeof raw.inputTokens === 'number' && isFinite(raw.inputTokens) ? raw.inputTokens : 0,
        outputTokens: typeof raw.outputTokens === 'number' && isFinite(raw.outputTokens) ? raw.outputTokens : 0,
        cacheReadTokens: typeof raw.cacheReadTokens === 'number' && isFinite(raw.cacheReadTokens) ? raw.cacheReadTokens : 0,
      }
      if (usage.inputTokens === 0 && usage.outputTokens === 0 && usage.cacheReadTokens === 0) return null
      return usage
    }

    function normalizeResult(raw) {
      if (!raw || typeof raw !== 'object') return null
      const finalAnswer = typeof raw.finalAnswer === 'string' ? raw.finalAnswer : ''
      const turns = typeof raw.turns === 'number' && isFinite(raw.turns) ? raw.turns : 0
      const durationMs = typeof raw.durationMs === 'number' && isFinite(raw.durationMs) ? raw.durationMs : 0
      const usage = normalizeUsage(raw.usage)
      if (finalAnswer === '' && turns === 0 && durationMs === 0 && usage === null) return null
      return { finalAnswer: finalAnswer, turns: turns, durationMs: durationMs, usage: usage }
    }

    function normalizeTask(task) {
      if (!task || typeof task !== 'object' || typeof task.id !== 'string' || task.id === '') return null
      const status = STATUS_VALUES.indexOf(task.status) >= 0 ? task.status : 'pending'
      const source = task.source === 'session' ? 'session' : 'queue'
      return {
        id: task.id,
        title: typeof task.title === 'string' && task.title !== '' ? task.title : task.id,
        prompt: typeof task.prompt === 'string' ? task.prompt : '',
        cwd: typeof task.cwd === 'string' ? task.cwd : '',
        status: status,
        priority: normalizePriority(task.priority),
        source: source,
        createdAt: typeof task.createdAt === 'number' ? task.createdAt : 0,
        updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : 0,
        startedAt: typeof task.startedAt === 'number' ? task.startedAt : 0,
        endedAt: typeof task.endedAt === 'number' ? task.endedAt : 0,
        sessionId: typeof task.sessionId === 'string' && task.sessionId !== '' ? task.sessionId : '',
        provider: typeof task.provider === 'string' ? task.provider : '',
        model: typeof task.model === 'string' ? task.model : '',
        reasoningEffort: typeof task.reasoningEffort === 'string' ? task.reasoningEffort : '',
        error: typeof task.error === 'string' ? task.error : '',
        lastMessage: typeof task.lastMessage === 'string' ? task.lastMessage : '',
        turns: typeof task.turns === 'number' && isFinite(task.turns) ? task.turns : 0,
        chainFrom: typeof task.chainFrom === 'string' ? task.chainFrom : '',
        result: normalizeResult(task.result),
      }
    }

    const REPORT_STATUSES = ['idle', 'running', 'ok', 'failed']

    function defaultDailyReportSettings() {
      return {
        enabled: true,
        time: '21:00',
        dir: '',
        lastDate: null,
        lastStatus: 'idle',
        lastError: '',
        lastGeneratedAt: 0,
        generatingDate: null,
      }
    }

    function normalizeDailyReportSettings(raw, previous) {
      const base = previous || defaultDailyReportSettings()
      if (!raw || typeof raw !== 'object') return base
      return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
        time: typeof raw.time === 'string' && raw.time !== '' ? raw.time : base.time,
        dir: typeof raw.dir === 'string' ? raw.dir : base.dir,
        lastDate: typeof raw.lastDate === 'string' && raw.lastDate !== '' ? raw.lastDate : null,
        lastStatus: REPORT_STATUSES.indexOf(raw.lastStatus) >= 0 ? raw.lastStatus : base.lastStatus,
        lastError: typeof raw.lastError === 'string' ? raw.lastError : '',
        lastGeneratedAt: typeof raw.lastGeneratedAt === 'number' && raw.lastGeneratedAt > 0 ? raw.lastGeneratedAt : 0,
        generatingDate: typeof raw.generatingDate === 'string' && raw.generatingDate !== '' ? raw.generatingDate : null,
      }
    }

    // ---- v9: evolution settings / data normalisation -------------------------

    function defaultEvolutionSettings() {
      return {
        enabled: true,
        interval: 'daily',
        time: '22:00',
        weekday: 1,
        dir: '',
        skillMode: 'ask',
        lastDate: null,
        lastStatus: 'idle',
        lastError: null,
        lastGeneratedAt: null,
        generatingDate: null,
        lastCoveredSince: null,
      }
    }

    function defaultEvolutionMeta() {
      return {
        enabled: true,
        interval: 'daily',
        time: '22:00',
        lastDate: null,
        lastStatus: 'idle',
        lastError: null,
        lastGeneratedAt: null,
        generatingDate: null,
        lessonCount: 0,
        activeSkillCount: 0,
        proposedSkillCount: 0,
      }
    }

    // Settings come back from /state and /settings. Missing or mistyped fields
    // fall back to the previous value (defaults on first load); an invalid
    // 24-hour time must never overwrite the last good time.
    function coerceEvolutionSettings(raw, previous) {
      const base = previous || defaultEvolutionSettings()
      if (!raw || typeof raw !== 'object') return Object.assign({}, base)
      return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
        interval: EVOLUTION_INTERVALS.indexOf(raw.interval) >= 0 ? raw.interval : base.interval,
        time: isValidReportTime(raw.time) ? raw.time : base.time,
        weekday: typeof raw.weekday === 'number' && isFinite(raw.weekday) && raw.weekday >= 0 && raw.weekday <= 6
          ? Math.round(raw.weekday)
          : base.weekday,
        dir: typeof raw.dir === 'string' ? raw.dir : base.dir,
        skillMode: EVOLUTION_SKILL_MODES.indexOf(raw.skillMode) >= 0 ? raw.skillMode : base.skillMode,
        lastDate: typeof raw.lastDate === 'string' && raw.lastDate !== '' ? raw.lastDate : null,
        lastStatus: EVOLUTION_STATUSES.indexOf(raw.lastStatus) >= 0 ? raw.lastStatus : base.lastStatus,
        lastError: typeof raw.lastError === 'string' && raw.lastError !== '' ? raw.lastError : null,
        lastGeneratedAt: typeof raw.lastGeneratedAt === 'number' && isFinite(raw.lastGeneratedAt) && raw.lastGeneratedAt > 0
          ? raw.lastGeneratedAt
          : null,
        generatingDate: typeof raw.generatingDate === 'string' && raw.generatingDate !== '' ? raw.generatingDate : null,
        lastCoveredSince: typeof raw.lastCoveredSince === 'number' && isFinite(raw.lastCoveredSince) && raw.lastCoveredSince > 0
          ? raw.lastCoveredSince
          : null,
      }
    }

    // Compact /state meta: used for the header badge and the settings status line.
    function normalizeEvolutionMeta(raw, previous) {
      const base = previous || defaultEvolutionMeta()
      if (!raw || typeof raw !== 'object') return base
      return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
        interval: EVOLUTION_INTERVALS.indexOf(raw.interval) >= 0 ? raw.interval : base.interval,
        time: isValidReportTime(raw.time) ? raw.time : base.time,
        lastDate: typeof raw.lastDate === 'string' && raw.lastDate !== '' ? raw.lastDate : null,
        lastStatus: EVOLUTION_STATUSES.indexOf(raw.lastStatus) >= 0 ? raw.lastStatus : base.lastStatus,
        lastError: typeof raw.lastError === 'string' && raw.lastError !== '' ? raw.lastError : null,
        lastGeneratedAt: typeof raw.lastGeneratedAt === 'number' && isFinite(raw.lastGeneratedAt) && raw.lastGeneratedAt > 0
          ? raw.lastGeneratedAt
          : null,
        generatingDate: typeof raw.generatingDate === 'string' && raw.generatingDate !== '' ? raw.generatingDate : null,
        lessonCount: typeof raw.lessonCount === 'number' && isFinite(raw.lessonCount) && raw.lessonCount > 0 ? Math.round(raw.lessonCount) : 0,
        activeSkillCount: typeof raw.activeSkillCount === 'number' && isFinite(raw.activeSkillCount) && raw.activeSkillCount > 0 ? Math.round(raw.activeSkillCount) : 0,
        proposedSkillCount: typeof raw.proposedSkillCount === 'number' && isFinite(raw.proposedSkillCount) && raw.proposedSkillCount > 0 ? Math.round(raw.proposedSkillCount) : 0,
      }
    }

    function normalizeLessonItem(raw) {
      if (!raw || typeof raw !== 'object') return null
      if (typeof raw.text !== 'string' || raw.text.trim() === '') return null
      const scope = EVOLUTION_SCOPES.indexOf(raw.scope) >= 0 ? raw.scope : 'global'
      const project = scope === 'project' && typeof raw.project === 'string' && raw.project !== '' ? raw.project : null
      return {
        id: typeof raw.id === 'string' ? raw.id : '',
        text: raw.text,
        category: EVOLUTION_LESSON_CATEGORIES.indexOf(raw.category) >= 0 ? raw.category : 'other',
        scope: scope,
        project: project,
        evidence: typeof raw.evidence === 'string' ? raw.evidence : '',
        source: raw.source === 'manual' ? 'manual' : 'retrospective',
        active: raw.active !== false,
        createdAt: typeof raw.createdAt === 'number' && isFinite(raw.createdAt) ? raw.createdAt : 0,
        updatedAt: typeof raw.updatedAt === 'number' && isFinite(raw.updatedAt) ? raw.updatedAt : 0,
      }
    }

    function normalizeSkillItem(raw) {
      if (!raw || typeof raw !== 'object') return null
      if (typeof raw.name !== 'string' || raw.name === '') return null
      if (typeof raw.description !== 'string') return null
      const scope = EVOLUTION_SCOPES.indexOf(raw.scope) >= 0 ? raw.scope : 'global'
      const project = scope === 'project' && typeof raw.project === 'string' && raw.project !== '' ? raw.project : null
      return {
        name: raw.name,
        description: raw.description,
        whenToUse: typeof raw.whenToUse === 'string' ? raw.whenToUse : '',
        content: typeof raw.content === 'string' ? raw.content : '',
        scope: scope,
        project: project,
        status: EVOLUTION_SKILL_STATUSES.indexOf(raw.status) >= 0 ? raw.status : 'proposed',
        source: raw.source === 'manual' ? 'manual' : 'retrospective',
        evidence: typeof raw.evidence === 'string' ? raw.evidence : '',
        createdAt: typeof raw.createdAt === 'number' && isFinite(raw.createdAt) ? raw.createdAt : 0,
        updatedAt: typeof raw.updatedAt === 'number' && isFinite(raw.updatedAt) ? raw.updatedAt : 0,
      }
    }

    function normalizeEvolutionSnapshot(raw) {
      const payload = raw && typeof raw === 'object' ? raw : {}
      const lessons = []
      if (Array.isArray(payload.lessons)) {
        for (let i = 0; i < payload.lessons.length; i += 1) {
          const lesson = normalizeLessonItem(payload.lessons[i])
          if (lesson) lessons.push(lesson)
        }
      }
      const skills = []
      if (Array.isArray(payload.skills)) {
        for (let i = 0; i < payload.skills.length; i += 1) {
          const skill = normalizeSkillItem(payload.skills[i])
          if (skill) skills.push(skill)
        }
      }
      return {
        settings: payload.settings && typeof payload.settings === 'object'
          ? coerceEvolutionSettings(payload.settings, null)
          : null,
        skillsAvailable: payload.skillsAvailable !== false,
        lessons: lessons,
        skills: skills,
        retrospectives: normalizeReportItems(payload.retrospectives),
        running: payload.running === true,
      }
    }

    function evolutionStatusText(t, settings) {
      const status = settings && typeof settings === 'object' ? settings.lastStatus : ''
      if (status === 'running') return t('evolutionStatusRunning')
      if (status === 'ok') return t('evolutionStatusOk')
      if (status === 'failed') return t('evolutionStatusFailed')
      return t('evolutionStatusIdle')
    }

    function evolutionStatusTone(settings) {
      const status = settings && typeof settings === 'object' ? settings.lastStatus : ''
      if (status === 'running') return 'running'
      if (status === 'ok') return 'ok'
      if (status === 'failed') return 'failed'
      return 'idle'
    }

    function isEvolutionGenerating(settings) {
      if (!settings || typeof settings !== 'object') return false
      return settings.lastStatus === 'running' || Boolean(settings.generatingDate)
    }

    function lessonCategoryLabel(t, value) {
      if (value === 'correction') return t('categoryCorrection')
      if (value === 'error') return t('categoryError')
      if (value === 'preference') return t('categoryPreference')
      if (value === 'process') return t('categoryProcess')
      return t('categoryOther')
    }

    function evolutionScopeLabel(t, value) {
      return value === 'project' ? t('scopeProject') : t('scopeGlobal')
    }

    function lessonSourceLabel(t, value) {
      return value === 'manual' ? t('lessonSourceManual') : t('lessonSourceRetrospective')
    }

    function skillSourceLabel(t, value) {
      return value === 'manual' ? t('skillSourceManual') : t('skillSourceRetrospective')
    }

    function skillStatusLabel(t, value) {
      if (value === 'active') return t('skillStatusActive')
      if (value === 'disabled') return t('skillStatusDisabled')
      return t('skillStatusProposed')
    }

    function weekdayLabel(t, value) {
      const index = typeof value === 'number' && value >= 0 && value <= 6 ? Math.round(value) : 1
      return t(WEEKDAY_KEYS[index])
    }

    function defaultWebhookSettings() {
      return {
        enabled: false,
        url: '',
        format: 'generic',
        secretHeader: 'Authorization',
        secret: '',
        events: { claimed: true, succeeded: true, blocked: true, failed: true, dailyReport: true, morningBrief: true, retrospective: true },
        lastStatus: 'idle',
        lastAt: null,
        lastEvent: null,
        lastError: null,
      }
    }

    function coerceWebhookSettings(raw, previous) {
      const base = previous || defaultWebhookSettings()
      if (!raw || typeof raw !== 'object') return { ...base, events: { ...base.events } }
      const events = { ...base.events }
      if (raw.events && typeof raw.events === 'object') {
        for (let i = 0; i < WEBHOOK_EVENT_KEYS.length; i += 1) {
          const key = WEBHOOK_EVENT_KEYS[i]
          if (key in raw.events) events[key] = raw.events[key] !== false
        }
      }
      let lastStatus = 'idle'
      if (raw.lastStatus === 'ok' || raw.lastStatus === 'failed') lastStatus = raw.lastStatus
      return {
        enabled: raw.enabled === true,
        url: typeof raw.url === 'string' ? raw.url : base.url,
        format: WEBHOOK_FORMATS.indexOf(raw.format) >= 0 ? raw.format : base.format,
        secretHeader: typeof raw.secretHeader === 'string' ? raw.secretHeader : base.secretHeader,
        secret: typeof raw.secret === 'string' ? raw.secret : base.secret,
        events: events,
        lastStatus: lastStatus,
        lastAt: typeof raw.lastAt === 'number' && isFinite(raw.lastAt) && raw.lastAt > 0 ? raw.lastAt : null,
        lastEvent: typeof raw.lastEvent === 'string' && raw.lastEvent !== '' ? raw.lastEvent : null,
        lastError: typeof raw.lastError === 'string' && raw.lastError !== '' ? raw.lastError : null,
      }
    }

    function isValidWebhookUrl(value) {
      if (typeof value !== 'string') return false
      const text = value.trim()
      if (!/^https?:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/i.test(text)) return false
      const host = text.replace(/^https?:\/\//i, '').split(/[/?#]/)[0]
      return host !== '' && host.indexOf(':') !== 0
    }

    function webhookEventLabel(t, key) {
      if (key === 'claimed') return t('webhookEventClaimed')
      if (key === 'succeeded') return t('webhookEventSucceeded')
      if (key === 'blocked') return t('webhookEventBlocked')
      if (key === 'failed') return t('webhookEventFailed')
      if (key === 'dailyReport') return t('webhookEventDailyReport')
      if (key === 'morningBrief') return t('webhookEventMorningBrief')
      if (key === 'retrospective') return t('webhookEventRetrospective')
      if (key === 'test') return t('webhookEventTest')
      return typeof key === 'string' && key !== '' ? key : t('webhookEventTest')
    }

    function normalizeReportItem(raw) {
      if (!raw || typeof raw !== 'object') return null
      const date = typeof raw.date === 'string' ? raw.date : ''
      if (date === '') return null
      return {
        date: date,
        path: typeof raw.path === 'string' ? raw.path : '',
        bytes: typeof raw.bytes === 'number' && isFinite(raw.bytes) ? raw.bytes : 0,
        updatedAt: typeof raw.updatedAt === 'number' && isFinite(raw.updatedAt) ? raw.updatedAt : 0,
      }
    }

    function normalizeReportItems(raw) {
      const items = []
      if (!Array.isArray(raw)) return items
      for (let i = 0; i < raw.length; i += 1) {
        const item = normalizeReportItem(raw[i])
        if (item) items.push(item)
      }
      items.sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0) })
      return items
    }

    function parseReportMeta(raw) {
      if (Array.isArray(raw)) return { items: normalizeReportItems(raw), settings: null }
      if (raw && typeof raw === 'object') {
        const items = Array.isArray(raw.reports) ? normalizeReportItems(raw.reports) : normalizeReportItems(raw.items)
        const settings = raw.settings && typeof raw.settings === 'object' ? normalizeDailyReportSettings(raw.settings, null) : null
        return { items: items, settings: settings }
      }
      return { items: [], settings: null }
    }


    // ---- v0.6: morning brief settings / meta. Mirrors the daily-report
    // normalisation so an older Host (no morningBrief field) keeps working.

    function defaultMorningBriefSettings() {
      return {
        enabled: true,
        time: '08:30',
        dir: '',
        lastDate: null,
        lastStatus: 'idle',
        lastError: null,
        lastGeneratedAt: null,
        generatingDate: null,
        lastSuggestions: [],
      }
    }

    function normalizeMorningBriefSettings(raw, previous) {
      const base = previous || defaultMorningBriefSettings()
      if (!raw || typeof raw !== 'object') return Object.assign({}, base)
      let lastStatus = base.lastStatus
      if (raw.lastStatus === 'idle' || raw.lastStatus === 'running' || raw.lastStatus === 'ok' || raw.lastStatus === 'failed') {
        lastStatus = raw.lastStatus
      }
      return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
        time: isValidReportTime(raw.time) ? raw.time : base.time,
        dir: typeof raw.dir === 'string' && raw.dir !== '' ? raw.dir : base.dir,
        lastDate: typeof raw.lastDate === 'string' && raw.lastDate !== '' ? raw.lastDate : null,
        lastStatus: lastStatus,
        lastError: typeof raw.lastError === 'string' && raw.lastError !== '' ? raw.lastError : null,
        lastGeneratedAt: typeof raw.lastGeneratedAt === 'number' && isFinite(raw.lastGeneratedAt) && raw.lastGeneratedAt > 0
          ? raw.lastGeneratedAt
          : null,
        generatingDate: typeof raw.generatingDate === 'string' && raw.generatingDate !== '' ? raw.generatingDate : null,
        lastSuggestions: raw.lastSuggestions !== undefined
          ? normalizeBriefSuggestions(raw.lastSuggestions)
          : (Array.isArray(base.lastSuggestions) ? base.lastSuggestions.slice() : []),
      }
    }

    function briefStatusText(t, settings) {
      if (!settings) return t('briefStatusIdle')
      if (settings.lastStatus === 'running') return t('briefStatusRunning')
      if (settings.lastStatus === 'ok') return t('briefStatusOk')
      if (settings.lastStatus === 'failed') return t('briefStatusFailed')
      return t('briefStatusIdle')
    }

    function briefStatusTone(settings) {
      if (!settings) return 'idle'
      if (settings.lastStatus === 'running') return 'running'
      if (settings.lastStatus === 'ok') return 'ok'
      if (settings.lastStatus === 'failed') return 'failed'
      return 'idle'
    }

    function normalizeBriefItem(raw) {
      if (!raw || typeof raw !== 'object') return null
      const date = typeof raw.date === 'string' ? raw.date : ''
      if (date === '') return null
      return {
        date: date,
        path: typeof raw.path === 'string' ? raw.path : '',
        bytes: typeof raw.bytes === 'number' && isFinite(raw.bytes) ? raw.bytes : 0,
        updatedAt: typeof raw.updatedAt === 'number' && isFinite(raw.updatedAt) ? raw.updatedAt : 0,
      }
    }

    function normalizeBriefItems(raw) {
      const items = []
      if (!Array.isArray(raw)) return items
      for (let i = 0; i < raw.length; i += 1) {
        const item = normalizeBriefItem(raw[i])
        if (item) items.push(item)
      }
      items.sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0) })
      return items
    }

    function parseBriefMeta(raw) {
      if (Array.isArray(raw)) return { items: normalizeBriefItems(raw), settings: null }
      if (raw && typeof raw === 'object') {
        const items = Array.isArray(raw.briefs) ? normalizeBriefItems(raw.briefs) : normalizeBriefItems(raw.items)
        const settings = raw.settings && typeof raw.settings === 'object' ? normalizeMorningBriefSettings(raw.settings, null) : null
        return { items: items, settings: settings }
      }
      return { items: [], settings: null }
    }

    // Morning-brief card: first two readable lines of the Markdown body.
    function taskResultOneLine(task, max) {
      if (!task || typeof task !== 'object') return ''
      const limit = typeof max === 'number' && max > 0 ? max : 80
      const result = task.result || null
      const candidates = [
        result && typeof result.finalAnswer === 'string' ? result.finalAnswer : '',
        typeof task.lastMessage === 'string' ? task.lastMessage : '',
        typeof task.error === 'string' ? task.error : '',
      ]
      for (let i = 0; i < candidates.length; i += 1) {
        const text = firstSentence(candidates[i], limit)
        if (text !== '') return text
      }
      return ''
    }

    function firstSentence(value, max) {
      if (typeof value !== 'string' || value.trim() === '') return ''
      const limit = typeof max === 'number' && max > 0 ? max : 80
      const flat = value.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim()
      let cut = flat.length
      const stops = ['。', '！', '？', '；', '. ', '! ', '? ', '; ']
      for (let i = 0; i < stops.length; i += 1) {
        const index = flat.indexOf(stops[i], 8)
        if (index >= 0 && index < cut) cut = index + stops[i].length
      }
      const text = flat.slice(0, cut).trim()
      if (text.length <= limit) return text
      return text.slice(0, limit).replace(/[，、；：,;:\s]+$/, '') + '…'
    }

    function normalizeWebhookLogItem(raw) {
      if (!raw || typeof raw !== 'object') return null
      const at = typeof raw.at === 'number' && isFinite(raw.at) && raw.at > 0 ? raw.at : 0
      if (at <= 0) return null
      return {
        at: at,
        event: typeof raw.event === 'string' && raw.event !== '' ? raw.event : 'test',
        ok: raw.ok === true,
        httpStatus: typeof raw.httpStatus === 'number' && isFinite(raw.httpStatus) ? raw.httpStatus : null,
        error: typeof raw.error === 'string' ? raw.error : '',
        responseSnippet: typeof raw.responseSnippet === 'string' ? raw.responseSnippet : '',
      }
    }

    function normalizeWebhookLog(raw) {
      const payload = raw && typeof raw === 'object' ? raw : {}
      const list = Array.isArray(payload.log) ? payload.log : (Array.isArray(payload.entries) ? payload.entries : [])
      const items = []
      for (let i = 0; i < list.length; i += 1) {
        const item = normalizeWebhookLogItem(list[i])
        if (item) items.push(item)
      }
      return items
    }

    function readLastSeenTime() {
      try {
        if (typeof localStorage === 'undefined') return 0
        const raw = localStorage.getItem(LAST_SEEN_KEY)
        const value = raw === null ? 0 : parseInt(raw, 10)
        return isFinite(value) && value > 0 ? value : 0
      } catch (error) {
        return 0
      }
    }

    function writeLastSeenTime(value) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(LAST_SEEN_KEY, String(value))
      } catch (error) {
        // storage may be unavailable in private contexts; read state stays usable
      }
    }


    // ---- v0.7: Markdown cleanup for card/row summaries. The board should never
    // show raw `#`, `**`, backticks or horizontal rules in a two-line snippet.
    function stripMarkdown(value) {
      if (typeof value !== 'string' || value === '') return ''
      let text = value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ')
      text = text.replace(/```[\s\S]*?```/g, ' ')
      text = text.replace(/`([^`]*)`/g, '$1')
      text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, '')
      text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, '')
      text = text.replace(/^[ \t]{0,3}([-*_])[ \t]*\1[ \t]*\1[ \t]*$/gm, ' ')
      text = text.replace(/^[ \t]{0,3}[-*+][ \t]+/gm, '')
      text = text.replace(/^[ \t]{0,3}\d+[.)][ \t]+/gm, '')
      text = text.replace(/(^|\s)#{1,6}\s+/g, '$1')
      text = text.replace(/(^|\s)(?:-{3,}|\*{3,}|_{3,})(?=\s|$)/g, '$1')
      text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
      text = text.replace(/__([^_]+)__/g, '$1')
      text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
      text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      text = text.replace(/<https?:\/\/[^>]+>/g, ' ')
      text = text.replace(/[ \t]+/g, ' ')
      text = text.replace(/\n{2,}/g, '\n')
      return text.trim()
    }

    function stripMarkdownInline(value) {
      return stripMarkdown(value).replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim()
    }

    // Suggestion rows rendered by the brief block; the Host writes them into
    // settings.morningBrief.lastSuggestions (v0.7+). Older snapshots simply
    // have none, so keep a tiny client-side fallback from pending / ideas.
    function normalizeBriefSuggestions(raw) {
      const list = []
      if (!Array.isArray(raw)) return list
      for (let i = 0; i < raw.length && list.length < 3; i += 1) {
        const item = raw[i]
        if (!item || typeof item !== 'object') continue
        const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
        let title = typeof item.title === 'string' ? item.title.trim() : ''
        if (title === '' && prompt !== '') title = firstSentence(prompt, 60)
        if (title === '') continue
        list.push({
          title: title,
          reason: typeof item.reason === 'string' ? item.reason.trim() : '',
          prompt: prompt !== '' ? prompt : title,
          priority: normalizePriority(item.priority),
        })
      }
      return list
    }

    function fallbackBriefSuggestions(tasks, t) {
      const list = []
      const pending = []
      const ideas = []
      if (Array.isArray(tasks)) {
        for (let i = 0; i < tasks.length; i += 1) {
          const task = tasks[i]
          if (task.status === 'pending' && pending.length < 2) pending.push(task)
          else if (task.status === 'idea') ideas.push(task)
        }
      }
      ideas.sort(function (left, right) { return (right.createdAt || 0) - (left.createdAt || 0) })
      const translate = typeof t === 'function' ? t : function (key) { return key }
      for (let i = 0; i < pending.length; i += 1) {
        list.push({
          title: pending[i].title,
          reason: translate('focusReasonPending'),
          prompt: pending[i].prompt !== '' ? pending[i].prompt : pending[i].title,
          priority: normalizePriority(pending[i].priority),
        })
      }
      if (ideas.length > 0) {
        list.push({
          title: ideas[0].title,
          reason: translate('focusReasonIdea'),
          prompt: ideas[0].prompt !== '' ? ideas[0].prompt : ideas[0].title,
          priority: normalizePriority(ideas[0].priority),
        })
      }
      return list.slice(0, 3)
    }

    // First section of a brief (e.g. 「一、昨天发生了什么」), Markdown stripped.
    // Renders up to three bullets for the today card without leaking the
    // suggestions section (that one is rendered as a separate action list).
    function briefSummaryLines(content, maxLines) {
      const limit = typeof maxLines === 'number' && maxLines > 0 ? maxLines : 3
      const out = []
      if (typeof content !== 'string' || content.trim() === '') return out
      const lines = content.replace(/\r\n?/g, '\n').split('\n')
      let start = -1
      let end = lines.length
      for (let i = 0; i < lines.length; i += 1) {
        if (/^[ \t]{0,3}##[ \t]+/.test(lines[i])) {
          if (start < 0) start = i + 1
          else { end = i; break }
        }
      }
      if (start < 0) start = 0
      for (let i = start; i < end && out.length < limit; i += 1) {
        const raw = lines[i].trim()
        if (raw === '' || raw.indexOf('```') === 0) continue
        if (/^[ \t]{0,3}([-*_])[ \t]*\1[ \t]*\1[ \t]*$/.test(raw)) continue
        if (/^[ \t]{0,3}>/.test(raw)) continue
        const text = stripMarkdownInline(raw
          .replace(/^[ \t]{0,3}[-*+][ \t]+/, '')
          .replace(/^[ \t]{0,3}\d+[.)][ \t]+/, ''))
        if (text === '' || text === '-' || text === '无') continue
        out.push(text)
      }
      return out
    }

    // Global task search (task view status bar): title / prompt / folder / result.
    function matchesGlobalSearch(task, term) {
      if (!task || term === '') return true
      const result = task.result && typeof task.result === 'object' ? task.result : null
      const haystack = [
        task.title,
        task.prompt,
        task.cwd,
        task.lastMessage,
        task.error,
        result && typeof result.finalAnswer === 'string' ? result.finalAnswer : '',
      ].join('\n').toLowerCase()
      return haystack.indexOf(term) >= 0
    }

    const MAX_BACKUP_ROWS = 5

    function normalizeBackupItem(raw) {
      if (!raw || typeof raw !== 'object') return null
      if (typeof raw.name !== 'string' || raw.name === '') return null
      const savedAt = typeof raw.savedAt === 'number' && isFinite(raw.savedAt) && raw.savedAt > 0 ? raw.savedAt : 0
      const bytes = typeof raw.bytes === 'number' && isFinite(raw.bytes) && raw.bytes > 0 ? raw.bytes : 0
      const taskCount = typeof raw.taskCount === 'number' && isFinite(raw.taskCount) && raw.taskCount > 0 ? Math.round(raw.taskCount) : 0
      const rev = typeof raw.rev === 'number' && isFinite(raw.rev) ? raw.rev : 0
      return { name: raw.name, savedAt: savedAt, bytes: bytes, taskCount: taskCount, rev: rev }
    }

    function normalizeBackupMeta(raw) {
      const items = []
      if (raw && Array.isArray(raw.backups)) {
        for (let i = 0; i < raw.backups.length && items.length < 20; i += 1) {
          const item = normalizeBackupItem(raw.backups[i])
          if (item) items.push(item)
        }
      }
      let latest = raw && raw.latest ? normalizeBackupItem(raw.latest) : null
      if (latest === null && items.length > 0) latest = items[0]
      return { items: items, latest: latest, total: items.length }
    }

    function findCatalogModel(catalog, provider, model) {
      if (!catalog || !Array.isArray(catalog.groups)) return null
      for (let i = 0; i < catalog.groups.length; i += 1) {
        const group = catalog.groups[i]
        if (!group || !Array.isArray(group.models)) continue
        for (let j = 0; j < group.models.length; j += 1) {
          const entry = group.models[j]
          if (!entry || typeof entry.id !== 'string') continue
          if (entry.id === model && (provider === undefined || provider === null || provider === '' || group.id === provider)) {
            return { group: group, model: entry }
          }
        }
      }
      return null
    }

    function modelValue(provider, model) {
      return JSON.stringify([String(provider || ''), String(model || '')])
    }

    function parseModelValue(value) {
      try {
        const parsed = JSON.parse(value)
        if (Array.isArray(parsed) && parsed.length === 2) {
          return { provider: String(parsed[0] || ''), model: String(parsed[1] || '') }
        }
      } catch (error) {
        // fall through: an unknown option value never changes the model
      }
      return null
    }

    function guessDefaultDirectory(ctx) {
      try {
        const service = ctx && ctx.uiWorkspace ? ctx.uiWorkspace : null
        if (!service) return ''
        const list = service.workspaces && service.workspaces.list ? service.workspaces.list : null
        const snapshot = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : null
        const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : null
        if (!items || items.length === 0) return ''
        const reference = service.mainReference
        const currentSessionId = reference && typeof reference.sessionId === 'string' ? reference.sessionId : ''
        let match = null
        if (currentSessionId !== '') {
          match = items.find(function (item) {
            return item && Array.isArray(item.sessionIds) && item.sessionIds.indexOf(currentSessionId) >= 0
          }) || null
        }
        if (!match) {
          match = items.find(function (item) { return item && typeof item.path === 'string' && item.path !== '' })
        }
        if (match && typeof match.path === 'string') return match.path
      } catch (error) {
        // Optional convenience only; an empty field is still valid input state.
      }
      return ''
    }

    function insertStyles(ctx, css) {
      let api = null
      try {
        if (typeof styles !== 'undefined' && styles && typeof styles.insert === 'function') api = styles
      } catch (error) {
        api = null
      }
      if (api === null) {
        try {
          const candidate = ctx && typeof ctx.get === 'function' ? ctx.get('styles') : null
          if (candidate && typeof candidate.insert === 'function') api = candidate
        } catch (error) {
          api = null
        }
      }
      if (api !== null) {
        const dispose = api.insert(css)
        ctx.effect(function () {
          return function () {
            if (typeof dispose === 'function') dispose()
          }
        }, 'dsh-personal-secretary: styles')
        return
      }
      if (typeof document === 'undefined' || !document.head) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-personal-secretary'
      tag.textContent = css
      document.head.appendChild(tag)
      ctx.effect(function () {
        return function () {
          if (tag.parentNode) tag.parentNode.removeChild(tag)
        }
      }, 'dsh-personal-secretary: styles')
    }

    function copyTextToClipboard(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          return Promise.resolve(navigator.clipboard.writeText(text))
        }
      } catch (error) {
        return Promise.reject(error)
      }
      return Promise.reject(new Error('clipboard is unavailable'))
    }

    // ------------------------------------------------------------------ icons

    function makeIcon(shape) {
      return function DshPersonalSecretaryIcon(props) {
        const size = props && typeof props.size === 'number' ? props.size : 16
        return h('svg', {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          className: props && props.className ? props.className : undefined,
        }, shape())
      }
    }

    const IconSecretary = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M4 8.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z' }),
        h('path', { key: 'b', d: 'M9 6.5V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v1.5' }),
        h('path', { key: 'c', d: 'M4 12h16' }),
        h('path', { key: 'd', d: 'M10.4 12l1.2 1.4 2.1-2.2' }),
      ]
    })

    const IconGrip = makeIcon(function () {
      return [
        h('circle', { key: 'g1', cx: 9, cy: 6, r: 1.15, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'g2', cx: 15, cy: 6, r: 1.15, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'g3', cx: 9, cy: 12, r: 1.15, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'g4', cx: 15, cy: 12, r: 1.15, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'g5', cx: 9, cy: 18, r: 1.15, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'g6', cx: 15, cy: 18, r: 1.15, fill: 'currentColor', stroke: 'none' }),
      ]
    })

    const IconPlus = makeIcon(function () {
      return [h('path', { key: 'v', d: 'M12 5v14' }), h('path', { key: 'h', d: 'M5 12h14' })]
    })

    const IconSliders = makeIcon(function () {
      return [
        h('path', { key: 'l1', d: 'M4 7h16' }),
        h('circle', { key: 'c1', cx: 9.5, cy: 7, r: 1.7, fill: 'currentColor', stroke: 'none' }),
        h('path', { key: 'l2', d: 'M4 17h16' }),
        h('circle', { key: 'c2', cx: 14.5, cy: 17, r: 1.7, fill: 'currentColor', stroke: 'none' }),
      ]
    })

    const IconClose = makeIcon(function () {
      return [h('path', { key: 'a', d: 'M6 6l12 12' }), h('path', { key: 'b', d: 'M18 6L6 18' })]
    })

    const IconFolder = makeIcon(function () {
      return [h('path', { key: 'a', d: 'M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z' })]
    })

    const IconOpenExternal = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M14 4h6v6' }),
        h('path', { key: 'b', d: 'M20 4l-9 9' }),
        h('path', { key: 'c', d: 'M18 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4.5' }),
      ]
    })

    const IconRetry = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M20 12a8 8 0 1 1-2.4-5.7' }),
        h('path', { key: 'b', d: 'M20 4.5V10h-5.5' }),
      ]
    })

    const IconStop = makeIcon(function () {
      return [h('rect', { key: 'a', x: 7, y: 7, width: 10, height: 10, rx: 2, fill: 'currentColor', stroke: 'none' })]
    })

    const IconTrash = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M4 7h16' }),
        h('path', { key: 'b', d: 'M9.5 7V5.2h5V7' }),
        h('path', { key: 'c', d: 'M6.5 7l.8 12h9.4l.8-12' }),
        h('path', { key: 'd', d: 'M10.5 10.5v5.5' }),
        h('path', { key: 'e', d: 'M13.5 10.5v5.5' }),
      ]
    })

    const IconSend = makeIcon(function () {
      return [h('path', { key: 'a', d: 'M5 12h13' }), h('path', { key: 'b', d: 'M13 6l6 6-6 6' })]
    })

    const IconChevronUp = makeIcon(function () {
      return [h('path', { key: 'a', d: 'M6.5 14.5L12 9l5.5 5.5' })]
    })

    const IconChevronDown = makeIcon(function () {
      return [h('path', { key: 'a', d: 'M6.5 9.5L12 15l5.5-5.5' })]
    })

    const IconArrowToTop = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M12 19V6' }),
        h('path', { key: 'b', d: 'M6.5 11.5L12 6l5.5 5.5' }),
        h('path', { key: 'c', d: 'M5 4h14' }),
      ]
    })

    const IconChat = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M4 6.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9.5L4 20z' }),
        h('path', { key: 'b', d: 'M8.5 9.5h7' }),
        h('path', { key: 'c', d: 'M8.5 12.5h4.5' }),
      ]
    })

    const IconAlert = makeIcon(function () {
      return [
        h('circle', { key: 'a', cx: 12, cy: 12, r: 8.5 }),
        h('path', { key: 'b', d: 'M12 7.8v5' }),
        h('path', { key: 'c', d: 'M12 16.2h.01' }),
      ]
    })

    const IconInbox = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M4 13l2.6-6.2A2 2 0 0 1 8.4 5.5h7.2a2 2 0 0 1 1.8 1.3L20 13' }),
        h('path', { key: 'b', d: 'M4 13v4.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V13' }),
        h('path', { key: 'c', d: 'M4 13h4.5l1.5 2.5h4L15.5 13H20' }),
      ]
    })

    const IconPlay = makeIcon(function () {
      return [h('path', { key: 'a', d: 'M8.5 5.5l10 6.5-10 6.5z', fill: 'currentColor', stroke: 'none' })]
    })

    const IconPause = makeIcon(function () {
      return [
        h('rect', { key: 'a', x: 7, y: 5.5, width: 3.4, height: 13, rx: 1.2, fill: 'currentColor', stroke: 'none' }),
        h('rect', { key: 'b', x: 13.6, y: 5.5, width: 3.4, height: 13, rx: 1.2, fill: 'currentColor', stroke: 'none' }),
      ]
    })

    const IconCheck = makeIcon(function () {
      return [h('path', { key: 'a', d: 'M5 12.5l4.5 4.5L19 7' })]
    })

    const IconCheckCircle = makeIcon(function () {
      return [
        h('circle', { key: 'a', cx: 12, cy: 12, r: 8.5 }),
        h('path', { key: 'b', d: 'M8.2 12.3l2.6 2.6 5-5.4' }),
      ]
    })

    const IconClock = makeIcon(function () {
      return [
        h('circle', { key: 'a', cx: 12, cy: 12, r: 8.5 }),
        h('path', { key: 'b', d: 'M12 7.5V12l3 2' }),
      ]
    })

    const IconBan = makeIcon(function () {
      return [
        h('circle', { key: 'a', cx: 12, cy: 12, r: 8.5 }),
        h('path', { key: 'b', d: 'M6.2 6.2l11.6 11.6' }),
      ]
    })

    const IconChain = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M9.5 14.5l5-5' }),
        h('path', { key: 'b', d: 'M8.3 11.8l-1.5 1.5a3.4 3.4 0 0 0 4.8 4.8l1.5-1.5' }),
        h('path', { key: 'c', d: 'M15.7 12.2l1.5-1.5a3.4 3.4 0 0 0-4.8-4.8l-1.5 1.5' }),
      ]
    })

    const IconCopy = makeIcon(function () {
      return [
        h('rect', { key: 'a', x: 9, y: 9, width: 11, height: 11, rx: 2 }),
        h('path', { key: 'b', d: 'M5 15V5a2 2 0 0 1 2-2h10' }),
      ]
    })

    const IconDownload = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M12 4v11' }),
        h('path', { key: 'b', d: 'M7.5 10.5L12 15l4.5-4.5' }),
        h('path', { key: 'c', d: 'M4.5 19.5h15' }),
      ]
    })

    const IconFileText = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M6.5 4.5h7l4 4v11a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5v-13.5a1.5 1.5 0 0 1 1.5-1.5z' }),
        h('path', { key: 'b', d: 'M13.5 4.5v4h4' }),
        h('path', { key: 'c', d: 'M9 12.5h6' }),
        h('path', { key: 'd', d: 'M9 16h4' }),
      ]
    })

    const IconLayers = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M12 4l8 4-8 4-8-4z' }),
        h('path', { key: 'b', d: 'M4 12l8 4 8-4' }),
        h('path', { key: 'c', d: 'M4 16l8 4 8-4' }),
      ]
    })

    const IconBell = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M6.5 10a5.5 5.5 0 0 1 11 0c0 4 1.5 5 1.5 5H5s1.5-1 1.5-5z' }),
        h('path', { key: 'b', d: 'M10 18.5a2 2 0 0 0 4 0' }),
      ]
    })

    const IconSpark = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M12 4l1.8 4.9L18.7 10l-4.9 1.8L12 16.7l-1.8-4.9L5.3 10l4.9-1.1z' }),
        h('path', { key: 'b', d: 'M18 16.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z' }),
      ]
    })

    const IconEdit = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M4 20h4.2l10-10a2.1 2.1 0 0 0-3-3l-10 10z' }),
        h('path', { key: 'b', d: 'M13.8 8.2l2 2' }),
      ]
    })

    const IconEye = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M2.8 12S6 6.8 12 6.8 21.2 12 21.2 12 18 17.2 12 17.2 2.8 12 2.8 12z' }),
        h('circle', { key: 'b', cx: 12, cy: 12, r: 2.6 }),
      ]
    })

    const IconRefresh = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M20 11a8 8 0 0 0-13.9-4.7L4 8.5' }),
        h('path', { key: 'b', d: 'M4 4v4.5h4.5' }),
        h('path', { key: 'c', d: 'M4 13a8 8 0 0 0 13.9 4.7L20 15.5' }),
        h('path', { key: 'd', d: 'M20 20v-4.5h-4.5' }),
      ]
    })

    const IconCalendar = makeIcon(function () {
      return [
        h('rect', { key: 'a', x: 4, y: 5.5, width: 16, height: 14.5, rx: 2 }),
        h('path', { key: 'b', d: 'M4 10h16' }),
        h('path', { key: 'c', d: 'M8 3.5v3.5' }),
        h('path', { key: 'd', d: 'M16 3.5v3.5' }),
      ]
    })

    const IconSearch = makeIcon(function () {
      return [
        h('circle', { key: 'a', cx: 11, cy: 11, r: 6.5 }),
        h('path', { key: 'b', d: 'M16 16l4.5 4.5' }),
      ]
    })

    const IconFlag = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M5 21V4.5' }),
        h('path', { key: 'b', d: 'M5 5h11.5l-1.8 3.6L16.5 12H5z' }),
      ]
    })

    // Solid priority flag — stays legible at 11px where the outline glyph reads
    // like a letter; only the card identity row uses it.
    const IconPriorityFlag = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M5.5 21V4.5' }),
        h('path', { key: 'b', d: 'M5.5 5h11l-1.7 3.5L16.5 12h-11z', fill: 'currentColor', stroke: 'none' }),
      ]
    })

    const IconFilter = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M4 5h16l-6.2 7.3v5.2L10.2 20v-7.7L4 5z' }),
      ]
    })

    const IconArrowRight = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M4 12h15' }),
        h('path', { key: 'b', d: 'M13 6l6 6-6 6' }),
      ]
    })

    const IconArrowLeft = makeIcon(function () {
      return [
        h('path', { key: 'a', d: 'M20 12H5' }),
        h('path', { key: 'b', d: 'M11 6l-6 6 6 6' }),
      ]
    })

    function SecretaryIllustration(props) {
      const size = props && typeof props.size === 'number' ? props.size : 180
      return h('svg', {
        viewBox: '0 0 200 140',
        width: size,
        height: Math.round(size * 0.7),
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        className: props && props.className ? props.className : undefined,
      },
      h('rect', { key: 'board', x: 22, y: 24, width: 156, height: 96, rx: 12, opacity: .35 }),
      h('path', { key: 'head', d: 'M22 44h156', opacity: .35 }),
      h('circle', { key: 'd1', cx: 34, cy: 34, r: 2.4, fill: 'currentColor', stroke: 'none', opacity: .5 }),
      h('circle', { key: 'd2', cx: 42, cy: 34, r: 2.4, fill: 'currentColor', stroke: 'none', opacity: .3 }),
      h('circle', { key: 'd3', cx: 50, cy: 34, r: 2.4, fill: 'currentColor', stroke: 'none', opacity: .18 }),
      h('path', { key: 'sep1', d: 'M74 44v76', opacity: .18 }),
      h('path', { key: 'sep2', d: 'M126 44v76', opacity: .18 }),
      h('rect', { key: 'p1', x: 32, y: 54, width: 34, height: 16, rx: 4, opacity: .55 }),
      h('rect', { key: 'p2', x: 32, y: 76, width: 34, height: 16, rx: 4, opacity: .38 }),
      h('rect', { key: 'p3', x: 32, y: 98, width: 34, height: 14, rx: 4, opacity: .2 }),
      h('rect', { key: 'r1', x: 84, y: 54, width: 34, height: 40, rx: 5, opacity: .75 }),
      h('path', { key: 'rbar', d: 'M86 56.5h30', opacity: .9, strokeWidth: 2 }),
      h('path', { key: 'rl1', d: 'M90 68h22', opacity: .5 }),
      h('path', { key: 'rl2', d: 'M90 75h14', opacity: .35 }),
      h('rect', { key: 'r2', x: 84, y: 100, width: 34, height: 12, rx: 4, opacity: .22 }),
      h('rect', { key: 'c1', x: 136, y: 54, width: 34, height: 18, rx: 4, opacity: .5 }),
      h('path', { key: 'check', d: 'M143 63l3.2 3.2 6-6', opacity: .9 }),
      h('rect', { key: 'c2', x: 136, y: 80, width: 34, height: 18, rx: 4, opacity: .28 }),
      h('path', { key: 'sp1', d: 'M166 118h12', opacity: .45 }),
      h('path', { key: 'sp2', d: 'M172 112v12', opacity: .45 }))
    }

    function StatusIcon(props) {
      const status = props.status
      const size = typeof props.size === 'number' ? props.size : 18
      if (status === 'running') return h(IconPlay, { size: size })
      if (status === 'paused') return h(IconPause, { size: size })
      if (status === 'blocked') return h(IconAlert, { size: size })
      if (status === 'done') return h(IconCheckCircle, { size: size })
      if (status === 'failed') return h(IconAlert, { size: size })
      if (status === 'cancelled') return h(IconBan, { size: size })
      return h(IconClock, { size: size })
    }

    // ------------------------------------------------------------------ primitive UI

    function Spinner() {
      return h('span', { className: 'dsh-ps-spinner', 'aria-hidden': 'true' })
    }

    function StatusDot(props) {
      return h('span', { className: 'dsh-ps-dot', 'data-status': props.status, 'aria-hidden': 'true' })
    }

    function StatusBadge(props) {
      return h('span', {
        className: 'dsh-ps-badge' + (props.className ? ' ' + props.className : ''),
        'data-status': props.status,
        title: props.title || undefined,
      }, props.label)
    }

    function Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        className: 'dsh-ps-switch',
        disabled: props.disabled === true,
        onClick: props.onChange,
      }, h('span', { className: 'dsh-ps-switch-thumb', 'aria-hidden': 'true' }))
    }

    function IconButton(props) {
      return h('button', {
        type: 'button',
        className: 'dsh-ps-btn dsh-ps-btn-ghost dsh-ps-btn-icon' + (props.className ? ' ' + props.className : ''),
        'aria-label': props.label,
        title: props.title || props.label,
        disabled: props.disabled === true,
        onClick: props.onClick,
      }, props.children)
    }

    function ErrorBanner(props) {
      if (!props.error || typeof props.error.text !== 'string') return null
      return h('div', { className: 'dsh-ps-banner', role: 'alert' },
        h(IconAlert, { size: 16, className: 'dsh-ps-banner-icon' }),
        h('div', { className: 'dsh-ps-banner-text' }, props.error.text),
        props.onDismiss
          ? h('button', {
            type: 'button',
            className: 'dsh-ps-banner-dismiss',
            'aria-label': props.dismissLabel || 'Dismiss',
            onClick: props.onDismiss,
          }, h(IconClose, { size: 14 }))
          : null)
    }

    function Field(props) {
      return h('div', { className: 'dsh-ps-field' },
        h('label', { className: 'dsh-ps-field-label', htmlFor: props.htmlFor }, props.label),
        props.children,
        props.hint ? h('div', { className: 'dsh-ps-field-hint' }, props.hint) : null,
        props.error ? h('div', { className: 'dsh-ps-field-error', role: 'alert' }, props.error) : null)
    }

    function MetaCell(props) {
      const className = 'dsh-ps-meta-value' + (props.mono ? ' dsh-ps-meta-value-code' : '')
      return h('div', { className: 'dsh-ps-meta-cell', 'data-span': props.span === 2 ? '2' : undefined },
        h('span', { className: 'dsh-ps-meta-label' }, props.label),
        h('span', { className: className, title: props.title }, props.children !== undefined ? props.children : props.value))
    }

    function ToastStack(props) {
      const toasts = props.toasts
      if (!toasts || toasts.length === 0) return null
      const nodes = []
      for (let i = 0; i < toasts.length; i += 1) {
        const toast = toasts[i]
        const icon = toast.tone === 'success' ? IconCheckCircle : (toast.tone === 'error' ? IconAlert : IconSpark)
        nodes.push(h('div', { key: toast.id, className: 'dsh-ps-toast', 'data-tone': toast.tone },
          h(icon, { size: 15, className: 'dsh-ps-toast-icon' }),
          h('span', { className: 'dsh-ps-toast-text' }, toast.text),
          h('button', {
            type: 'button',
            className: 'dsh-ps-toast-close',
            'aria-label': props.dismissLabel,
            onClick: function () { props.onDismiss(toast.id) },
          }, h(IconClose, { size: 12 }))))
      }
      return h('div', { className: 'dsh-ps-toasts', role: 'status', 'aria-live': 'polite' }, nodes)
    }

    // ------------------------------------------------------------------ hooks

    function useStoreSnapshot(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    }

    function useLocaleRerender(locale) {
      const [revision, setRevision] = React.useState(0)
      React.useEffect(function () {
        if (!locale || typeof locale.subscribe !== 'function') return undefined
        let dispose = null
        try {
          dispose = locale.subscribe(function () { setRevision(function (value) { return value + 1 }) })
        } catch (error) {
          return undefined
        }
        return function () {
          if (typeof dispose === 'function') dispose()
        }
      }, [locale])
      return revision
    }

    function useNow(active) {
      const [now, setNow] = React.useState(function () { return Date.now() })
      React.useEffect(function () {
        if (!active) {
          setNow(Date.now())
          return undefined
        }
        const timer = setInterval(function () { setNow(Date.now()) }, 1000)
        return function () { clearInterval(timer) }
      }, [active])
      return now
    }

    function useDialogA11y(dialogRef, onClose, active, initialFocusRef) {
      const closeRef = React.useRef(onClose)
      closeRef.current = onClose
      const focusRef = React.useRef(initialFocusRef)
      focusRef.current = initialFocusRef
      React.useEffect(function () {
        if (!active) return undefined
        if (typeof document === 'undefined') return undefined
        const previous = document.activeElement || null
        const node = dialogRef.current
        const preferred = focusRef.current && focusRef.current.current
        const target = preferred || node
        if (target && typeof target.focus === 'function') {
          try { target.focus() } catch (error) { /* focus is a progressive enhancement */ }
        }
        function onKeyDown(event) {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            if (typeof closeRef.current === 'function') closeRef.current()
            return
          }
          if (event.key !== 'Tab' || !node) return
          const focusables = node.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
          if (!focusables || focusables.length === 0) return
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return function () {
          document.removeEventListener('keydown', onKeyDown, true)
          if (previous && typeof previous.focus === 'function') {
            try { previous.focus() } catch (error) { /* the opener may be gone */ }
          }
        }
      }, [active, dialogRef])
    }

    function useToasts() {
      const [toasts, setToasts] = React.useState([])
      const seqRef = React.useRef(0)
      const timersRef = React.useRef([])
      const addToast = React.useCallback(function (text, tone) {
        if (typeof text !== 'string' || text === '') return
        seqRef.current += 1
        const id = seqRef.current
        const entry = { id: id, text: text, tone: tone || 'info' }
        setToasts(function (previous) {
          const next = previous.concat([entry])
          return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next
        })
        const timer = setTimeout(function () {
          setToasts(function (previous) {
            return previous.filter(function (item) { return item.id !== id })
          })
        }, TOAST_VISIBLE_MS)
        timersRef.current.push(timer)
      }, [])
      const dismissToast = React.useCallback(function (id) {
        setToasts(function (previous) {
          return previous.filter(function (item) { return item.id !== id })
        })
      }, [])
      React.useEffect(function () {
        return function () {
          for (let i = 0; i < timersRef.current.length; i += 1) clearTimeout(timersRef.current[i])
          timersRef.current = []
        }
      }, [])
      return { toasts: toasts, addToast: addToast, dismissToast: dismissToast }
    }

    // ------------------------------------------------------------------ store

    function createStore(ctx, t) {
      const initial = {
        phase: 'loading',
        rev: -1,
        settings: null,
        tasks: [],
        counts: { idea: 0, pending: 0, running: 0, paused: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 },
        runningCount: 0,
        reports: { phase: 'idle', items: [], settings: null, error: null },
        briefs: { phase: 'idle', items: [], settings: null, error: null, supported: true },
        evolution: null,
        error: null,
        models: null,
        modelsPhase: 'idle',
        modelsError: null,
      }
      let snap = initial
      const listeners = new Set()
      let disposed = false
      let refreshing = false
      let refreshQueued = false
      let reportsRefreshing = false
      let briefsRefreshing = false
      let pollTimer = null
      let errorTimer = null
      let lastErrorAt = 0
      let visibilityHandler = null
      let inFlight = null
      let reportsInFlight = null

      function emit() {
        const current = Array.from(listeners)
        for (let i = 0; i < current.length; i += 1) {
          try { current[i]() } catch (error) { /* a broken listener must not stop polling */ }
        }
      }

      function set(patch) {
        snap = Object.assign({}, snap, patch)
        emit()
      }

      function currentHidden() {
        return typeof document !== 'undefined' && document.hidden === true
      }

      function genericError(error) {
        if (error && typeof error.message === 'string' && error.message !== '') return error.message
        return t('unknownError')
      }

      function reportError(message) {
        const text = typeof message === 'string' && message !== '' ? message : t('unknownError')
        const now = Date.now()
        // A repeating poll failure keeps the banner alive; do not restart the
        // dismiss timer or repaint identical text within one visible window.
        if (snap.error !== null && snap.error.text === text && now - lastErrorAt < 3000) return
        lastErrorAt = now
        const errorObject = { text: text, at: now }
        set({ error: errorObject })
        if (errorTimer !== null) clearTimeout(errorTimer)
        errorTimer = setTimeout(function () {
          errorTimer = null
          if (disposed) return
          if (snap.error === errorObject) set({ error: null })
        }, ERROR_VISIBLE_MS)
      }

      function clearError() {
        if (errorTimer !== null) {
          clearTimeout(errorTimer)
          errorTimer = null
        }
        if (snap.error !== null) set({ error: null })
      }

      async function request(path, options) {
        const init = options || {}
        if (typeof fetch !== 'function') throw new Error('fetch is unavailable in this Client')
        const init2 = {
          method: init.method || 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
        }
        if (init.signal) init2.signal = init.signal
        if (init.body !== undefined) {
          init2.headers = { 'content-type': 'application/json' }
          init2.body = JSON.stringify(init.body)
        }
        const response = await fetch(API + path, init2)
        let payload = null
        try { payload = await response.json() } catch (error) { payload = null }
        if (!response.ok || payload === null || payload.ok !== true) {
          const message = payload && typeof payload.error === 'string' && payload.error !== ''
            ? payload.error
            : 'HTTP ' + response.status
          const failure = new Error(message)
          failure.status = response.status
          throw failure
        }
        return payload
      }

      function countOf(value) {
        return typeof value === 'number' && isFinite(value) && value > 0 ? value : 0
      }

      function coerceSettings(raw, previous) {
        if (!raw || typeof raw !== 'object') return previous
        const base = previous || {
          concurrency: 1,
          provider: '',
          model: '',
          reasoningEffort: null,
          autoStart: true,
          notifyOnDone: true,
          dailyReport: defaultDailyReportSettings(),
          morningBrief: defaultMorningBriefSettings(),
          webhook: defaultWebhookSettings(),
          evolution: defaultEvolutionSettings(),
        }
        return {
          concurrency: typeof raw.concurrency === 'number' ? raw.concurrency : base.concurrency,
          provider: typeof raw.provider === 'string' ? raw.provider : base.provider,
          model: typeof raw.model === 'string' ? raw.model : base.model,
          reasoningEffort: typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort : null,
          autoStart: typeof raw.autoStart === 'boolean' ? raw.autoStart : base.autoStart,
          notifyOnDone: typeof raw.notifyOnDone === 'boolean' ? raw.notifyOnDone : base.notifyOnDone,
          dailyReport: normalizeDailyReportSettings(raw.dailyReport, base.dailyReport),
          morningBrief: normalizeMorningBriefSettings(raw.morningBrief, base.morningBrief),
          webhook: coerceWebhookSettings(raw.webhook, base.webhook),
          evolution: coerceEvolutionSettings(raw.evolution, base.evolution),
        }
      }

      function normalizeTasks(raw) {
        const tasks = []
        if (!Array.isArray(raw)) return tasks
        for (let i = 0; i < raw.length; i += 1) {
          const task = normalizeTask(raw[i])
          if (task) tasks.push(task)
        }
        return tasks
      }

      function computeCounts(tasks) {
        const counts = { idea: 0, pending: 0, running: 0, paused: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 }
        for (let i = 0; i < tasks.length; i += 1) {
          const status = tasks[i].status
          if (counts[status] !== undefined) counts[status] += 1
        }
        return counts
      }

      function reportSettingsOf(snapshot) {
        if (snapshot.reports && snapshot.reports.settings) return snapshot.reports.settings
        if (snapshot.settings && snapshot.settings.dailyReport) return snapshot.settings.dailyReport
        return defaultDailyReportSettings()
      }

      function briefSettingsOf(snapshot) {
        if (snapshot.briefs && snapshot.briefs.settings) return snapshot.briefs.settings
        if (snapshot.settings && snapshot.settings.morningBrief) return snapshot.settings.morningBrief
        return defaultMorningBriefSettings()
      }

      function applyState(payload) {
        const rawTasks = Array.isArray(payload.tasks) ? payload.tasks : snap.tasks
        const tasks = normalizeTasks(rawTasks)
        const settings = coerceSettings(payload.settings, snap.settings) || snap.settings
        const computed = computeCounts(tasks)
        const rawCounts = payload.counts && typeof payload.counts === 'object' ? payload.counts : null
        const counts = {}
        for (let i = 0; i < STATUS_VALUES.length; i += 1) {
          const status = STATUS_VALUES[i]
          counts[status] = rawCounts ? countOf(rawCounts[status]) : computed[status]
        }
        let runningCount = typeof payload.runningCount === 'number' ? payload.runningCount : -1
        if (runningCount < 0) runningCount = computed.running
        const meta = parseReportMeta(payload.reports)
        let reports = snap.reports
        if (payload.reports !== undefined) {
          reports = {
            phase: 'ready',
            items: meta.items,
            settings: meta.settings || (settings ? settings.dailyReport : reports.settings),
            error: null,
          }
        }
        if (settings && payload.reports === undefined && reports.settings === null) {
          reports = {
            phase: reports.phase === 'idle' ? 'ready' : reports.phase,
            items: reports.items,
            settings: settings.dailyReport,
            error: reports.error,
          }
        }
        let briefs = snap.briefs
        if (payload.briefs !== undefined) {
          const briefMeta = parseBriefMeta(payload.briefs)
          const briefSettings = briefMeta.settings || (settings ? settings.morningBrief : briefs.settings) || null
          briefs = { phase: 'ready', items: briefMeta.items, settings: briefSettings, error: null, supported: true }
        } else if (settings && payload.settings !== undefined) {
          // Older Host: /state has no briefs field. Keep the state shape stable
          // and let the UI show its "Host does not support briefs" fallback.
          briefs = {
            phase: 'ready',
            items: snap.briefs.items,
            settings: null,
            error: null,
            supported: false,
          }
        }
        set({
          phase: 'ready',
          rev: typeof payload.rev === 'number' ? payload.rev : snap.rev,
          settings: settings,
          tasks: tasks,
          counts: counts,
          runningCount: runningCount,
          reports: reports,
          briefs: briefs,
          // /state only carries the compact evolution meta; a payload without it
          // (older Host) must not wipe the current value.
          evolution: payload.evolution && typeof payload.evolution === 'object'
            ? normalizeEvolutionMeta(payload.evolution, snap.evolution)
            : snap.evolution,
        })
      }

      async function refresh() {
        if (disposed) return
        if (currentHidden()) return
        if (refreshing) {
          // A write such as a chat revive asked for a fresh snapshot while a
          // poll request was already in flight: re-run once it settles so the
          // board/drawer do not stick with the older pre-write state.
          refreshQueued = true
          return
        }
        refreshing = true
        let controller = null
        try {
          if (typeof AbortController === 'function') controller = new AbortController()
        } catch (error) {
          controller = null
        }
        inFlight = controller
        try {
          const payload = await request('/state', controller ? { signal: controller.signal } : undefined)
          if (disposed) return
          applyState(payload)
        } catch (error) {
          if (disposed) return
          if (error && error.name === 'AbortError') return
          if (snap.phase !== 'ready') set({ phase: 'error' })
          reportError(t('stateLoadFailed') + ' — ' + genericError(error))
        } finally {
          if (inFlight === controller) inFlight = null
          refreshing = false
          if (refreshQueued) {
            refreshQueued = false
            if (!disposed) void refresh()
          }
        }
      }

      async function runWrite(action, failureLabel) {
        try {
          const result = await action()
          return { ok: true, data: result }
        } catch (error) {
          const message = genericError(error)
          reportError(failureLabel + ' — ' + message)
          return { ok: false, error: message }
        }
      }

      function applyTasksPayload(data) {
        if (!data || typeof data !== 'object') return false
        let changed = false
        if (Array.isArray(data.tasks)) {
          const tasks = normalizeTasks(data.tasks)
          set({ tasks: tasks, counts: computeCounts(tasks) })
          changed = true
        }
        if (typeof data.rev === 'number') {
          set({ rev: data.rev })
          changed = true
        }
        return changed
      }

      async function publish(input) {
        const result = await runWrite(function () {
          return request('/tasks', { method: 'POST', body: input })
        }, t('publishFailed'))
        if (result.ok && result.data) {
          if (!applyTasksPayload(result.data) || !Array.isArray(result.data.tasks)) {
            const task = normalizeTask(result.data.task)
            if (task && !snap.tasks.some(function (item) { return item.id === task.id })) {
              set({ tasks: snap.tasks.concat([task]) })
            }
          }
          void refresh()
        }
        return result
      }

      async function publishBatch(input) {
        const result = await runWrite(function () {
          return request('/tasks/batch', { method: 'POST', body: input })
        }, t('publishFailed'))
        if (result.ok && result.data) {
          applyTasksPayload(result.data)
          void refresh()
        }
        return result
      }

      async function updateTask(input) {
        const result = await runWrite(function () {
          return request('/tasks/update', { method: 'POST', body: input })
        }, t('actionFailed'))
        if (result.ok && result.data) {
          applyTasksPayload(result.data)
          void refresh()
        }
        return result
      }

      async function reorder(ids) {
        if (!Array.isArray(ids)) return { ok: false, error: t('reorderFailed') }
        const byId = new Map()
        for (let i = 0; i < snap.tasks.length; i += 1) byId.set(snap.tasks[i].id, snap.tasks[i])
        if (ids.length !== snap.tasks.length) return { ok: false, error: t('reorderFailed') }
        const optimistic = []
        for (let i = 0; i < ids.length; i += 1) {
          const task = byId.get(ids[i])
          if (!task) return { ok: false, error: t('reorderFailed') }
          optimistic.push(task)
        }
        set({ tasks: optimistic })
        const result = await runWrite(function () {
          return request('/tasks/reorder', { method: 'POST', body: { ids: ids } })
        }, t('reorderFailed'))
        if (result.ok && result.data) {
          applyTasksPayload(result.data)
        } else if (!result.ok) {
          void refresh()
        }
        return result
      }

      async function act(id, action) {
        const result = await runWrite(function () {
          return request('/tasks/action', { method: 'POST', body: { id: id, action: action } })
        }, t('actionFailed'))
        if (result.ok && result.data) {
          applyTasksPayload(result.data)
          void refresh()
        }
        return result
      }

      async function saveSettings(patch) {
        const result = await runWrite(function () {
          return request('/settings', { method: 'POST', body: patch })
        }, t('settingsFailed'))
        if (result.ok && result.data) {
          if (result.data.settings && typeof result.data.settings === 'object') {
            const next = coerceSettings(result.data.settings, snap.settings)
            set({
              settings: next,
              reports: {
                phase: snap.reports.phase,
                items: snap.reports.items,
                settings: next ? next.dailyReport : snap.reports.settings,
                error: snap.reports.error,
              },
              briefs: {
                phase: snap.briefs.phase,
                items: snap.briefs.items,
                settings: next ? next.morningBrief : snap.briefs.settings,
                error: snap.briefs.error,
                supported: snap.briefs.supported,
              },
            })
          }
          if (typeof result.data.rev === 'number') set({ rev: result.data.rev })
        }
        return result
      }

      // Webhook settings save + test errors stay inline in the settings dialog
      // (no global error banner), matching how the Host reports 400/502.
      async function saveWebhook(patch) {
        try {
          const payload = await request('/settings', { method: 'POST', body: { webhook: patch } })
          if (payload && payload.settings && typeof payload.settings === 'object') {
            const next = coerceSettings(payload.settings, snap.settings)
            set({
              settings: next,
              reports: {
                phase: snap.reports.phase,
                items: snap.reports.items,
                settings: next ? next.dailyReport : snap.reports.settings,
                error: snap.reports.error,
              },
              briefs: {
                phase: snap.briefs.phase,
                items: snap.briefs.items,
                settings: next ? next.morningBrief : snap.briefs.settings,
                error: snap.briefs.error,
                supported: snap.briefs.supported,
              },
            })
          }
          if (payload && typeof payload.rev === 'number') set({ rev: payload.rev })
          return { ok: true, data: payload }
        } catch (error) {
          return { ok: false, error: genericError(error) }
        }
      }

      async function testWebhook() {
        try {
          const payload = await request('/webhook/test', { method: 'POST', body: {} })
          return { ok: true, data: payload }
        } catch (error) {
          return { ok: false, error: genericError(error) }
        }
      }

      async function loadModels(force) {
        if (disposed) return
        if (!force && (snap.models !== null || snap.modelsPhase === 'loading')) return
        set({ modelsPhase: 'loading', modelsError: null })
        try {
          const payload = await request('/models')
          if (disposed) return
          const catalog = payload && payload.catalog
          if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.groups)) {
            throw new Error(t('modelsInvalid'))
          }
          set({ models: catalog, modelsPhase: 'ready', modelsError: null })
        } catch (error) {
          if (disposed) return
          const message = genericError(error)
          set({ modelsPhase: 'error', modelsError: message })
          reportError(t('modelsLoadFailed') + ' — ' + message)
        }
      }

      // The Host may revive a finished task on chat: { status, revived }. Return
      // the full JSON payload so the drawer can move the card immediately and
      // toast the revive outcome without waiting for the next poll.
      async function sendChat(sessionId, text) {
        const result = await runWrite(function () {
          return request('/chat', { method: 'POST', body: { sessionId: sessionId, text: text } })
        }, t('chatFailed'))
        if (!result.ok) return result
        const payload = result.data && typeof result.data === 'object' ? result.data : {}
        return Object.assign({}, payload, { ok: true, data: payload })
      }

      // Data backups (recovery points) — failures surface inline in the dialog,
      // not via the global error banner, so the user keeps context.
      async function loadBackups() {
        try {
          const payload = await request('/backups')
          return { ok: true, data: normalizeBackupMeta(payload) }
        } catch (error) {
          return { ok: false, error: genericError(error) }
        }
      }

      async function restoreBackup(name) {
        if (typeof name !== 'string' || name === '') {
          return { ok: false, error: t('backupRestoreFailed') }
        }
        try {
          const payload = await request('/backups/restore', { method: 'POST', body: { name: name } })
          return { ok: true, data: payload }
        } catch (error) {
          return { ok: false, error: genericError(error) }
        }
      }

      async function refreshReports() {
        if (disposed || reportsRefreshing) return { ok: false, error: null }
        reportsRefreshing = true
        let controller = null
        try {
          if (typeof AbortController === 'function') controller = new AbortController()
        } catch (error) {
          controller = null
        }
        reportsInFlight = controller
        try {
          const payload = await request('/reports', controller ? { signal: controller.signal } : undefined)
          if (disposed) return { ok: true, data: payload }
          const meta = parseReportMeta(payload)
          const settings = meta.settings || reportSettingsOf(snap)
          set({
            reports: { phase: 'ready', items: meta.items, settings: settings, error: null },
            settings: snap.settings ? Object.assign({}, snap.settings, { dailyReport: settings }) : snap.settings,
          })
          return { ok: true, data: payload }
        } catch (error) {
          if (disposed) return { ok: false, error: t('unknownError') }
          if (error && error.name === 'AbortError') return { ok: false, error: null }
          const message = genericError(error)
          set({
            reports: {
              phase: snap.reports.phase === 'idle' ? 'error' : snap.reports.phase,
              items: snap.reports.items,
              settings: snap.reports.settings,
              error: message,
            },
          })
          return { ok: false, error: message }
        } finally {
          if (reportsInFlight === controller) reportsInFlight = null
          reportsRefreshing = false
        }
      }

      function markReportGenerating(day) {
        const current = reportSettingsOf(snap)
        const next = normalizeDailyReportSettings(Object.assign({}, current, {
          lastStatus: 'running',
          generatingDate: day,
          lastError: '',
        }), current)
        set({
          reports: { phase: snap.reports.phase, items: snap.reports.items, settings: next, error: snap.reports.error },
          settings: snap.settings ? Object.assign({}, snap.settings, { dailyReport: next }) : snap.settings,
        })
      }

      async function generateReport(date) {
        const day = typeof date === 'string' && date !== '' ? date : todayKey()
        const result = await runWrite(function () {
          return request('/reports/generate', { method: 'POST', body: { date: day } })
        }, t('reportGenerateFailed'))
        if (result.ok) {
          markReportGenerating(result.data && typeof result.data.date === 'string' ? result.data.date : day)
          void refreshReports()
        }
        return result
      }

      async function loadReportContent(date) {
        if (typeof date !== 'string' || date === '') return { ok: false, error: t('reportNoSelection') }
        return runWrite(function () {
          return request('/reports/content?date=' + encodeURIComponent(date))
        }, t('reportsContentFailed'))
      }

      // ---- v0.6: morning briefs --------------------------------------------
      async function refreshBriefs() {
        if (disposed || briefsRefreshing) return { ok: false, error: null }
        briefsRefreshing = true
        try {
          const payload = await request('/briefs')
          if (disposed) return { ok: true, data: payload }
          const meta = parseBriefMeta(payload)
          const settingsNext = meta.settings || briefSettingsOf(snap)
          set({
            briefs: { phase: 'ready', items: meta.items, settings: settingsNext, error: null, supported: true },
            settings: snap.settings
              ? Object.assign({}, snap.settings, { morningBrief: settingsNext })
              : snap.settings,
          })
          return { ok: true, data: payload }
        } catch (error) {
          if (disposed) return { ok: false, error: t('briefsLoadFailed') }
          const message = genericError(error)
          set({
            briefs: {
              phase: snap.briefs.phase === 'idle' ? 'error' : snap.briefs.phase,
              items: snap.briefs.items,
              settings: snap.briefs.settings,
              error: message,
              supported: snap.briefs.supported !== false,
            },
          })
          return { ok: false, error: message }
        } finally {
          briefsRefreshing = false
        }
      }

      function markBriefGenerating(day) {
        const current = briefSettingsOf(snap)
        const next = normalizeMorningBriefSettings(Object.assign({}, current, {
          lastStatus: 'running',
          generatingDate: day,
          lastError: '',
        }), current)
        set({
          briefs: {
            phase: snap.briefs.phase,
            items: snap.briefs.items,
            settings: next,
            error: snap.briefs.error,
            supported: snap.briefs.supported,
          },
          settings: snap.settings ? Object.assign({}, snap.settings, { morningBrief: next }) : snap.settings,
        })
      }

      async function generateBrief(date) {
        const day = typeof date === 'string' && date !== '' ? date : todayKey()
        const result = await runWrite(function () {
          return request('/briefs/generate', { method: 'POST', body: { date: day } })
        }, t('briefsGenerateFailed'))
        if (result.ok) {
          markBriefGenerating(result.data && typeof result.data.date === 'string' ? result.data.date : day)
          void refreshBriefs()
        }
        return result
      }

      async function loadBriefContent(date) {
        if (typeof date !== 'string' || date === '') return { ok: false, error: t('briefsNoSelection') }
        return runWrite(function () {
          return request('/briefs/content?date=' + encodeURIComponent(date))
        }, t('briefsContentFailed'))
      }

      // Read-only webhook delivery diagnostics (GET /webhook/log). Kept out of
      // the global error banner: the delivery-log dialog shows failures inline.
      async function loadWebhookLog() {
        try {
          const payload = await request('/webhook/log')
          return { ok: true, data: { items: normalizeWebhookLog(payload) } }
        } catch (error) {
          return { ok: false, error: genericError(error) }
        }
      }

      // ---- v9: self-evolution. Detail requests live in the drawer; the 1.5s
      // /state poll keeps the compact meta (badge, settings status) fresh.
      async function loadEvolution() {
        return runWrite(function () {
          return request('/evolution')
        }, t('retrospectiveLoadFailed'))
      }

      async function generateRetrospective(date) {
        const body = typeof date === 'string' && date !== '' ? { date: date } : {}
        return runWrite(function () {
          return request('/evolution/generate', { method: 'POST', body: body })
        }, t('retrospectiveGenerateFailed'))
      }

      async function loadRetrospectiveContent(date) {
        if (typeof date !== 'string' || date === '') return { ok: false, error: t('retrospectiveSelect') }
        return runWrite(function () {
          return request('/evolution/content?date=' + encodeURIComponent(date))
        }, t('retrospectiveContentFailed'))
      }

      async function addLesson(input) {
        return runWrite(function () {
          return request('/evolution/lessons', { method: 'POST', body: input })
        }, t('lessonAddFailed'))
      }

      async function updateLesson(input) {
        return runWrite(function () {
          return request('/evolution/lessons/update', { method: 'POST', body: input })
        }, t('lessonUpdateFailed'))
      }

      async function deleteLesson(id) {
        return runWrite(function () {
          return request('/evolution/lessons/delete', { method: 'POST', body: { id: id } })
        }, t('lessonDeleteFailed'))
      }

      async function loadSkillContent(name) {
        if (typeof name !== 'string' || name === '') return { ok: false, error: t('skillActionFailed') }
        return runWrite(function () {
          return request('/evolution/skills/content?name=' + encodeURIComponent(name))
        }, t('skillContentFailed'))
      }

      async function skillAction(name, action) {
        if (typeof name !== 'string' || name === '' || typeof action !== 'string' || action === '') {
          return { ok: false, error: t('skillActionFailed') }
        }
        return runWrite(function () {
          return request('/evolution/skills/action', { method: 'POST', body: { name: name, action: action } })
        }, t('skillActionFailed'))
      }

      function startPolling() {
        if (disposed || pollTimer !== null) return
        pollTimer = setInterval(function () { void refresh() }, POLL_MS)
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          visibilityHandler = function () {
            if (!currentHidden()) void refresh()
          }
          document.addEventListener('visibilitychange', visibilityHandler)
        }
        void refresh()
      }

      function stopPolling() {
        if (pollTimer !== null) {
          clearInterval(pollTimer)
          pollTimer = null
        }
        if (visibilityHandler && typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
          document.removeEventListener('visibilitychange', visibilityHandler)
        }
        visibilityHandler = null
      }

      function dispose() {
        if (disposed) return
        disposed = true
        stopPolling()
        if (inFlight && typeof inFlight.abort === 'function') {
          try { inFlight.abort() } catch (error) { /* already settled */ }
        }
        inFlight = null
        refreshQueued = false
        if (reportsInFlight && typeof reportsInFlight.abort === 'function') {
          try { reportsInFlight.abort() } catch (error) { /* already settled */ }
        }
        reportsInFlight = null
        if (errorTimer !== null) {
          clearTimeout(errorTimer)
          errorTimer = null
        }
        listeners.clear()
      }

      return {
        getSnapshot: function () { return snap },
        subscribe: function (listener) {
          if (typeof listener !== 'function') return function () {}
          listeners.add(listener)
          if (listeners.size === 1) startPolling()
          return function () {
            listeners.delete(listener)
            if (listeners.size === 0) stopPolling()
          }
        },
        request: request,
        refresh: refresh,
        publish: publish,
        publishBatch: publishBatch,
        updateTask: updateTask,
        reorder: reorder,
        act: act,
        saveSettings: saveSettings,
        loadModels: loadModels,
        sendChat: sendChat,
        loadBackups: loadBackups,
        restoreBackup: restoreBackup,
        saveWebhook: saveWebhook,
        testWebhook: testWebhook,
        refreshReports: refreshReports,
        generateReport: generateReport,
        loadReportContent: loadReportContent,
        refreshBriefs: refreshBriefs,
        generateBrief: generateBrief,
        loadBriefContent: loadBriefContent,
        loadWebhookLog: loadWebhookLog,
        briefSettings: function () { return briefSettingsOf(snap) },
        briefGenerating: function () {
          const settings = briefSettingsOf(snap)
          return settings.lastStatus === 'running' || Boolean(settings.generatingDate)
        },
        reportSettings: function () { return reportSettingsOf(snap) },
        reportGenerating: function () { return reportSettingsOf(snap).lastStatus === 'running' || Boolean(reportSettingsOf(snap).generatingDate) },
        evolutionSettings: function () { return snap.settings && snap.settings.evolution ? snap.settings.evolution : defaultEvolutionSettings() },
        evolutionMeta: function () { return snap.evolution || defaultEvolutionMeta() },
        loadEvolution: loadEvolution,
        generateRetrospective: generateRetrospective,
        loadRetrospectiveContent: loadRetrospectiveContent,
        addLesson: addLesson,
        updateLesson: updateLesson,
        deleteLesson: deleteLesson,
        loadSkillContent: loadSkillContent,
        skillAction: skillAction,
        reportError: reportError,
        clearError: clearError,
        dispose: dispose,
      }
    }

    // ------------------------------------------------------------------ error boundary

    class PanelErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error, info) {
        try {
          console.error('[dsh-personal-secretary] panel render failed', error, info)
        } catch (ignored) {
          // logging must never throw out of the boundary
        }
      }

      render() {
        if (this.state && this.state.failed) {
          const t = this.props.t
          return h('div', { className: 'dsh-ps-crash', role: 'alert' },
            h(IconAlert, { size: 18 }),
            h('div', { className: 'dsh-ps-crash-title' }, t('crashTitle')),
            h('p', { className: 'dsh-ps-crash-hint' }, t('crashHint')))
        }
        return this.props.children
      }
    }

    // ------------------------------------------------------------------ task card

    function CardAction(props) {
      const busy = props.busy === true
      return h('button', {
        type: 'button',
        className: 'dsh-ps-card-action',
        'data-action': props.action,
        'data-tone': props.tone || undefined,
        'data-busy': busy ? 'true' : 'false',
        'aria-label': props.label,
        title: props.label,
        disabled: props.disabled === true || busy,
        onClick: function (event) {
          event.stopPropagation()
          if (props.disabled === true || busy) return
          props.onClick()
        },
      }, busy ? h(Spinner) : props.children)
    }

    // Card context helpers: the card face only shows the single most useful
    // line per row, so the full detail stays in tooltips / the drawer.
    function firstLineOfText(value) {
      if (typeof value !== 'string') return ''
      const lines = value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].replace(/\s+/g, ' ').trim()
        if (line !== '') return line
      }
      return ''
    }

    // The context zone renders a compact, whitespace-normalized snippet of the
    // most useful stored text; CSS clamps it to exactly two 17px lines.
    function snippetTextOf(value) {
      if (typeof value !== 'string') return ''
      const lines = value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').split('\n')
      const parts = []
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].replace(/\s+/g, ' ').trim()
        if (line !== '') parts.push(line)
      }
      return parts.join(' ').trim()
    }

    function isDuplicateText(value, reference) {
      const left = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
      const right = typeof reference === 'string' ? reference.replace(/\s+/g, ' ').trim() : ''
      if (left === '' || right === '') return false
      if (left === right) return true
      const shorter = left.length <= right.length ? left : right
      const longer = left.length <= right.length ? right : left
      return shorter.length >= 8 && longer.indexOf(shorter) === 0
    }

    function TaskCard(props) {
      const task = props.task
      const t = props.t
      const status = task.status
      const isIdea = status === 'idea'
      const isPending = status === 'pending'
      const isRunning = status === 'running'
      const isPaused = status === 'paused'
      const isBlocked = status === 'blocked'
      const isEnded = isEndedStatus(status)
      const isSession = task.source === 'session'
      const result = task.result
      const answer = result && typeof result.finalAnswer === 'string' ? result.finalAnswer : ''
      const titleText = typeof task.title === 'string' ? task.title : ''
      const modelShort = task.model !== '' ? task.model : (task.provider || '')
      const modelTitle = taskModelLabel(task)
      const durationMs = taskDurationMs(task, props.now)
      const usage = result && result.usage ? result.usage : null
      const totalTokens = usage ? Math.max(0, usage.inputTokens || 0) + Math.max(0, usage.outputTokens || 0) : 0
      const turns = result && typeof result.turns === 'number' && result.turns > 0 ? Math.round(result.turns) : 0
      const canDrag = isDraggableStatus(status) && !isSession && !props.moving
      const priority = normalizePriority(task.priority)
      const priorityText = priorityLabel(t, priority)
      const priorityHint = t('priorityLabel') + ': ' + priorityText
      const createdAt = typeof task.createdAt === 'number' && task.createdAt > 0 ? task.createdAt : 0
      const createdTitle = createdAt > 0 ? formatFullTime(createdAt) : ''
      const statusText = statusLabel(t, status)

      function busyFor(name) {
        return props.busyAction === task.id + ':' + name
      }

      /* ---- zone 2: context — exactly two lines, chosen by status ---- */
      let contextText = ''
      if (status === 'done') {
        contextText = snippetTextOf(answer) || snippetTextOf(task.lastMessage)
      } else if (status === 'failed') {
        contextText = snippetTextOf(task.error) || snippetTextOf(task.lastMessage)
      } else if (status === 'cancelled') {
        contextText = snippetTextOf(task.lastMessage) || snippetTextOf(task.prompt)
      } else if (isRunning || isPaused || isBlocked) {
        contextText = snippetTextOf(task.lastMessage) || snippetTextOf(task.prompt)
      } else {
        contextText = snippetTextOf(task.prompt) || snippetTextOf(task.lastMessage)
      }
      contextText = stripMarkdownInline(contextText)
      if (isDuplicateText(contextText, titleText)) contextText = ''
      const contextEmpty = contextText === ''
      const contextDisplay = contextEmpty ? t('contextEmpty') : contextText

      /* ---- zone 3: meta row 1 — group (always) · folder basename · DSH tag ---- */
      const metaOneNodes = []
      const metaOneTitleParts = []
      function pushMetaOne(key, icon, text, titleAttr) {
        if (metaOneNodes.length > 0) {
          metaOneNodes.push(h('span', { key: key + '-sep', className: 'dsh-ps-card-meta-sep', 'aria-hidden': 'true' }, '·'))
        }
        metaOneNodes.push(h('span', {
          key: key,
          className: 'dsh-ps-card-meta-item',
          'data-meta': key,
          title: titleAttr,
        }, icon, h('span', null, text)))
        metaOneTitleParts.push(titleAttr)
      }
      if (task.cwd !== '') {
        pushMetaOne('folder', h(IconFolder, { size: 11, className: 'dsh-ps-card-meta-icon' }), basenameOf(task.cwd), task.cwd)
      }
      if (isSession) {
        if (metaOneNodes.length > 0) {
          metaOneNodes.push(h('span', { key: 'session-sep', className: 'dsh-ps-card-meta-sep', 'aria-hidden': 'true' }, '·'))
        }
        metaOneNodes.push(h('span', {
          key: 'session',
          className: 'dsh-ps-card-tag',
          'data-meta': 'session',
          title: t('sourceLabel') + ': ' + t('badgeSession'),
        }, t('badgeSession')))
        metaOneTitleParts.push(t('sourceLabel') + ': ' + t('badgeSession'))
      }
      const metaOneTitle = metaOneTitleParts.join(' · ')

      /* ---- zone 4: meta row 2 — at most three chips: time · elapsed · model
         (tokens/turns stay in the tooltip and the detail drawer) ---- */
      const metaTwoNodes = []
      const metaTwoTitleParts = []
      function pushMetaTwo(key, text, titleAttr, live) {
        if (metaTwoNodes.length > 0) {
          metaTwoNodes.push(h('span', { key: key + '-sep', className: 'dsh-ps-card-meta-sep', 'aria-hidden': 'true' }, '·'))
        }
        metaTwoNodes.push(h('span', {
          key: key,
          className: 'dsh-ps-card-meta-item' + (live ? ' dsh-ps-card-meta-live' : ''),
          'data-meta': key,
          title: titleAttr,
        }, h('span', null, text)))
        metaTwoTitleParts.push(titleAttr)
      }
      if (isEnded && task.endedAt > 0) {
        pushMetaTwo('created', formatCompactStamp(t, task.endedAt, props.now), formatFullTime(task.endedAt), false)
      } else if (createdAt > 0) {
        pushMetaTwo('created', formatCompactStamp(t, createdAt, props.now), createdTitle, false)
      }
      if (isRunning || isBlocked) {
        pushMetaTwo('duration', formatDuration(durationMs), t('runningFor', { duration: formatDuration(durationMs) }), true)
      } else if (isEnded && durationMs > 0) {
        pushMetaTwo('duration', formatDuration(durationMs), t('durationChip', { duration: formatDuration(durationMs) }), false)
      }
      if (modelShort !== '') {
        pushMetaTwo('model', modelShort, t('model') + ': ' + modelTitle, false)
      }
      if (metaTwoNodes.length === 0) {
        pushMetaTwo('empty', t('contextEmpty'), t('status') + ': ' + statusText, false)
      }
      const metaTwoTitle = metaTwoTitleParts.join(' · ')

      // Full detail (provider/model/effort, exact times, chain, source) stays
      // in the tooltip and the drawer; the card face keeps the four zones.
      const tooltipParts = [titleText, t('status') + ': ' + statusText, priorityHint]
      if (task.cwd !== '') tooltipParts.push(t('cwd') + ': ' + task.cwd)
      if (modelTitle !== '') tooltipParts.push(t('model') + ': ' + modelTitle)
      if (totalTokens > 0) tooltipParts.push(t('tokens') + ': ' + formatTokens(totalTokens))
      if (turns > 0) tooltipParts.push(t('turns') + ': ' + turns)
      if (task.chainFrom !== '' && props.chainTitle) tooltipParts.push(t('chainTitle', { title: props.chainTitle }))
      if (isSession) {
        tooltipParts.push(t('sourceLabel') + ': ' + t('badgeSession'))
        tooltipParts.push(t('chatReadOnly'))
      }
      if (isBlocked) tooltipParts.push(t('blockedNote'))
      const tooltip = tooltipParts.join('\n')

      const actions = []
      if (isSession) {
        if (task.sessionId !== '') {
          actions.push(h(CardAction, {
            key: 'open',
            action: 'open-session',
            label: t('openSession'),
            busy: busyFor('open-session'),
            onClick: function () { props.onOpenSession(task) },
          }, h(IconOpenExternal, { size: 14 })))
        }
        actions.push(h(CardAction, {
          key: 'view',
          action: 'view',
          label: t('view'),
          onClick: function () { props.onOpen(task.id) },
        }, h(IconEye, { size: 14 })))
        actions.push(h(CardAction, {
          key: 'delete',
          action: 'delete',
          label: t('deleteTask'),
          tone: 'danger',
          onClick: function () { props.onAction(task, 'delete') },
        }, h(IconTrash, { size: 14 })))
      } else if (isIdea) {
        actions.push(h(CardAction, {
          key: 'promote',
          action: 'promote',
          label: t('promote'),
          tone: 'brand',
          busy: busyFor('promote'),
          onClick: function () { props.onAction(task, 'promote') },
        }, h(IconArrowRight, { size: 14 })))
        actions.push(h(CardAction, {
          key: 'edit',
          action: 'edit',
          label: t('edit'),
          onClick: function () { props.onEdit(task) },
        }, h(IconEdit, { size: 14 })))
        actions.push(h(CardAction, {
          key: 'view',
          action: 'view',
          label: t('view'),
          onClick: function () { props.onOpen(task.id) },
        }, h(IconEye, { size: 14 })))
        actions.push(h(CardAction, {
          key: 'delete',
          action: 'delete',
          label: t('deleteTask'),
          tone: 'danger',
          onClick: function () { props.onAction(task, 'delete') },
        }, h(IconTrash, { size: 14 })))
      } else if (isPending) {
        actions.push(h(CardAction, {
          key: 'run',
          action: 'run',
          label: t('run'),
          tone: 'brand',
          busy: busyFor('run'),
          onClick: function () { props.onAction(task, 'run') },
        }, h(IconPlay, { size: 14 })))
        actions.push(h(CardAction, {
          key: 'edit',
          action: 'edit',
          label: t('edit'),
          onClick: function () { props.onEdit(task) },
        }, h(IconEdit, { size: 14 })))
        actions.push(h(CardAction, {
          key: 'next',
          action: 'run-next',
          label: t('runNext'),
          busy: busyFor('run-next'),
          onClick: function () { props.onAction(task, 'run-next') },
        }, h(IconArrowToTop, { size: 14 })))
        actions.push(h(CardAction, {
          key: 'up',
          action: 'move-up',
          label: t('moveUp'),
          disabled: props.index <= 0,
          busy: busyFor('move'),
          onClick: function () { props.onMove(task.id, -1) },
        }, h(IconChevronUp, { size: 14 })))
        actions.push(h(CardAction, {
          key: 'down',
          action: 'move-down',
          label: t('moveDown'),
          disabled: props.index >= props.pendingCount - 1,
          busy: busyFor('move'),
          onClick: function () { props.onMove(task.id, 1) },
        }, h(IconChevronDown, { size: 14 })))
        actions.push(h(CardAction, {
          key: 'demote',
          action: 'demote',
          label: t('demote'),
          busy: busyFor('demote'),
          onClick: function () { props.onAction(task, 'demote') },
        }, h(IconArrowLeft, { size: 14 })))
        actions.push(h(CardAction, {
          key: 'delete',
          action: 'delete',
          label: t('deleteTask'),
          tone: 'danger',
          onClick: function () { props.onAction(task, 'delete') },
        }, h(IconTrash, { size: 14 })))
      } else if (isRunning) {
        actions.push(h(CardAction, {
          key: 'pause',
          action: 'pause',
          label: t('pause'),
          tone: 'warn',
          busy: busyFor('pause'),
          onClick: function () { props.onAction(task, 'pause') },
        }, h(IconPause, { size: 14 })))
        actions.push(h(CardAction, {
          key: 'interrupt',
          action: 'interrupt',
          label: t('interrupt'),
          tone: 'danger',
          busy: busyFor('interrupt'),
          onClick: function () { props.onAction(task, 'interrupt') },
        }, h(IconStop, { size: 14 })))
        if (task.sessionId !== '') {
          actions.push(h(CardAction, {
            key: 'open',
            action: 'open-session',
            label: t('openSession'),
            onClick: function () { props.onOpenSession(task) },
          }, h(IconOpenExternal, { size: 14 })))
        }
        actions.push(h(CardAction, {
          key: 'view',
          action: 'view',
          label: t('view'),
          onClick: function () { props.onOpen(task.id) },
        }, h(IconEye, { size: 14 })))
      } else if (isPaused) {
        actions.push(h(CardAction, {
          key: 'resume',
          action: 'resume',
          label: t('resume'),
          tone: 'brand',
          busy: busyFor('resume'),
          onClick: function () { props.onAction(task, 'resume') },
        }, h(IconPlay, { size: 14 })))
        actions.push(h(CardAction, {
          key: 'edit',
          action: 'edit',
          label: t('edit'),
          onClick: function () { props.onEdit(task) },
        }, h(IconEdit, { size: 14 })))
        actions.push(h(CardAction, {
          key: 'interrupt',
          action: 'interrupt',
          label: t('interrupt'),
          tone: 'danger',
          busy: busyFor('interrupt'),
          onClick: function () { props.onAction(task, 'interrupt') },
        }, h(IconStop, { size: 14 })))
        if (task.sessionId !== '') {
          actions.push(h(CardAction, {
            key: 'open',
            action: 'open-session',
            label: t('openSession'),
            onClick: function () { props.onOpenSession(task) },
          }, h(IconOpenExternal, { size: 14 })))
        }
      } else if (isBlocked) {
        if (task.sessionId !== '') {
          actions.push(h(CardAction, {
            key: 'open',
            action: 'open-session',
            label: t('openSession'),
            onClick: function () { props.onOpenSession(task) },
          }, h(IconOpenExternal, { size: 14 })))
        }
        actions.push(h(CardAction, {
          key: 'resume',
          action: 'resume',
          label: t('resume'),
          tone: 'brand',
          busy: busyFor('resume'),
          onClick: function () { props.onAction(task, 'resume') },
        }, h(IconPlay, { size: 14 })))
        actions.push(h(CardAction, {
          key: 'interrupt',
          action: 'interrupt',
          label: t('interrupt'),
          tone: 'danger',
          busy: busyFor('interrupt'),
          onClick: function () { props.onAction(task, 'interrupt') },
        }, h(IconStop, { size: 14 })))
      } else if (isEnded) {
        if (task.sessionId !== '') {
          actions.push(h(CardAction, {
            key: 'open',
            action: 'open-session',
            label: t('openSession'),
            onClick: function () { props.onOpenSession(task) },
          }, h(IconOpenExternal, { size: 14 })))
        }
        actions.push(h(CardAction, {
          key: 'view',
          action: 'view',
          label: t('view'),
          onClick: function () { props.onOpen(task.id) },
        }, h(IconEye, { size: 14 })))
        actions.push(h(CardAction, {
          key: 'retry',
          action: 'retry',
          label: t('retry'),
          busy: busyFor('retry'),
          onClick: function () { props.onAction(task, 'retry') },
        }, h(IconRetry, { size: 14 })))
        actions.push(h(CardAction, {
          key: 'delete',
          action: 'delete',
          label: t('deleteTask'),
          tone: 'danger',
          onClick: function () { props.onAction(task, 'delete') },
        }, h(IconTrash, { size: 14 })))
      }

      function onCardClick(event) {
        if (props.isDragging) return
        const target = event && event.target
        if (target && typeof target.closest === 'function' && target.closest('button, a, input, textarea, select')) return
        props.onOpen(task.id)
      }

      function onCardKeyDown(event) {
        if (!isPending) return
        if (!event.altKey) return
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        props.onMove(task.id, event.key === 'ArrowUp' ? -1 : 1)
      }

      return h('article', {
        className: 'dsh-ps-card',
        'data-status': status,
        'data-source': task.source,
        'data-card-id': task.id,
        'data-priority': priority,
        'data-draggable': canDrag ? 'true' : 'false',
        'data-dragging': props.dragging ? 'true' : 'false',
        'data-drop': props.dropEdge || undefined,
        title: tooltip,
        draggable: canDrag,
        onClick: onCardClick,
        onKeyDown: onCardKeyDown,
        onDragStart: canDrag ? function (event) { props.onDragStart(task.id, event) } : undefined,
        onDragOver: canDrag ? function (event) { props.onDragOver(task.id, event) } : undefined,
        onDragLeave: canDrag ? function (event) { props.onDragLeave(task.id, event) } : undefined,
        onDrop: canDrag ? function (event) { props.onDrop(task.id, event) } : undefined,
        onDragEnd: canDrag ? function (event) { props.onDragEnd(task.id, event) } : undefined,
      },
      isRunning ? h('div', { className: 'dsh-ps-card-progress', 'aria-hidden': 'true' }, h('span', { className: 'dsh-ps-card-progress-fill' })) : null,
      /* zone 1 — identity: rank/grip · priority flag · title · DSH icon · status badge */
      h('div', { className: 'dsh-ps-card-top dsh-ps-card-identity', 'data-zone': 'identity' },
        canDrag ? h('span', { className: 'dsh-ps-grip', title: isIdea ? t('dragToPending') : t('dragHandle'), 'aria-hidden': 'true' }, h(IconGrip, { size: 13 })) : null,
        isPending
          ? h('span', {
            className: 'dsh-ps-rank',
            title: t('position', { index: props.index + 1 }),
            'aria-label': t('position', { index: props.index + 1 }),
          }, String(props.index + 1))
          : null,
        h('span', {
          className: 'dsh-ps-priority',
          'data-priority': priority,
          title: priorityHint,
          'aria-label': priorityHint,
          role: 'img',
        }, h(IconPriorityFlag, { size: 12 })),
        h('button', {
          type: 'button',
          className: 'dsh-ps-card-title',
          title: tooltip,
          'aria-label': t('openTask') + ': ' + titleText,
          'aria-keyshortcuts': isPending ? 'Alt+ArrowUp Alt+ArrowDown' : undefined,
          onClick: function (event) {
            event.stopPropagation()
            props.onOpen(task.id)
          },
        }, titleText),
        isSession ? h('span', {
          className: 'dsh-ps-card-session',
          title: t('badgeSession'),
          'aria-label': t('badgeSession'),
          role: 'img',
        }, h(IconChat, { size: 12 })) : null,
        h(StatusBadge, {
          key: 'status',
          status: status,
          label: statusText,
          title: t('status') + ': ' + statusText,
          className: 'dsh-ps-card-status',
        })),
      /* zone 2 — fixed 2-line context (never a clipped half line) */
      h('p', {
        className: 'dsh-ps-card-context',
        'data-zone': 'context',
        'data-empty': contextEmpty ? 'true' : 'false',
        title: contextEmpty ? undefined : contextText,
      }, contextDisplay),
      /* zone 3 — single-line meta: group · folder · DSH tag */
      h('div', { className: 'dsh-ps-card-meta dsh-ps-card-meta-primary', 'data-row': '1', 'data-zone': 'meta-1', title: metaOneTitle }, metaOneNodes),
      /* zone 4 — single-line tabular meta: created · elapsed · model · tokens · turns */
      h('div', { className: 'dsh-ps-card-meta dsh-ps-card-meta-secondary', 'data-row': '2', 'data-zone': 'meta-2', title: metaTwoTitle }, metaTwoNodes),
      actions.length > 0 ? h('div', { className: 'dsh-ps-card-actions' }, actions) : null)
    }

    // ------------------------------------------------------------------ board columns

    function ColumnFilterOption(props) {
      return h('button', {
        type: 'button',
        className: 'dsh-ps-col-filter-option',
        'data-option': props.optionKey,
        'aria-pressed': props.active ? 'true' : 'false',
        disabled: props.disabled === true,
        title: props.title || undefined,
        onClick: function (event) {
          event.stopPropagation()
          if (props.disabled === true) return
          props.onSelect()
        },
      }, props.label)
    }

    function ColumnFilterPopover(props) {
      const t = props.t
      const column = props.column
      const filter = props.filter
      const popoverRef = React.useRef(null)
      const toggleRef = props.toggleRef
      React.useEffect(function () {
        const node = popoverRef.current
        if (node && typeof node.focus === 'function') {
          try { node.focus() } catch (error) { /* focus is progressive enhancement */ }
        }
        if (typeof document === 'undefined') return undefined
        function onPointerDown(event) {
          const popover = popoverRef.current
          const target = event && event.target
          if (popover && target && typeof popover.contains === 'function' && popover.contains(target)) return
          const toggle = toggleRef && toggleRef.current
          if (toggle && target && typeof toggle.contains === 'function' && toggle.contains(target)) return
          props.onClose()
        }
        function onKeyDown(event) {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          props.onClose()
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return function () {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          const toggle = toggleRef && toggleRef.current
          if (toggle && typeof toggle.focus === 'function') {
            try { toggle.focus() } catch (error) { /* the column may be gone */ }
          }
        }
      }, [])

      function select(patch) {
        props.onChange(patch)
      }

      function section(key, label, options, layout) {
        return h('div', { key: key, className: 'dsh-ps-col-filter-section' },
          h('span', { className: 'dsh-ps-col-filter-label' }, label),
          h('div', {
            className: 'dsh-ps-col-filter-options',
            'data-layout': layout || undefined,
            role: 'group',
            'aria-label': label,
          }, options))
      }

      const sectionNodes = []
      if (columnHasStatusFilter(column)) {
        const statusOptions = [h(ColumnFilterOption, {
          key: 'status-all',
          optionKey: 'all',
          label: t('filterAll'),
          active: filter.status === 'all',
          onSelect: function () { select({ status: 'all' }) },
        })]
        const statuses = COLUMN_STATUS_FILTERS[column]
        for (let i = 0; i < statuses.length; i += 1) {
          const value = statuses[i]
          statusOptions.push(h(ColumnFilterOption, {
            key: 'status-' + value,
            optionKey: value,
            label: statusLabel(t, value),
            active: filter.status === value,
            onSelect: function (selected) {
              return function () { select({ status: selected }) }
            }(value),
          }))
        }
        sectionNodes.push(section('status', t('filterStatus'), statusOptions))
      }

      const priorityOptions = [h(ColumnFilterOption, {
        key: 'priority-all',
        optionKey: 'all',
        label: t('filterAll'),
        active: filter.priority === 'all',
        onSelect: function () { select({ priority: 'all' }) },
      })]
      for (let i = 0; i < PRIORITY_VALUES.length; i += 1) {
        const value = PRIORITY_VALUES[i]
        priorityOptions.push(h(ColumnFilterOption, {
          key: 'priority-' + value,
          optionKey: value,
          label: priorityLabel(t, value),
          active: filter.priority === value,
          onSelect: (function (selected) {
            return function () { select({ priority: selected }) }
          })(value),
        }))
      }
      sectionNodes.push(section('priority', t('filterPriority'), priorityOptions))

      const sessionDisabled = !columnAcceptsSession(column)
      sectionNodes.push(section('source', t('filterSource'), [
        h(ColumnFilterOption, {
          key: 'source-all',
          optionKey: 'all',
          label: t('filterAll'),
          active: filter.source === 'all',
          onSelect: function () { select({ source: 'all' }) },
        }),
        h(ColumnFilterOption, {
          key: 'source-queue',
          optionKey: 'queue',
          label: t('sourceQueue'),
          active: filter.source === 'queue',
          onSelect: function () { select({ source: 'queue' }) },
        }),
        h(ColumnFilterOption, {
          key: 'source-session',
          optionKey: 'session',
          label: t('sourceSession'),
          active: filter.source === 'session',
          disabled: sessionDisabled,
          title: sessionDisabled ? t('sourceSessionDisabled') : undefined,
          onSelect: function () { select({ source: 'session' }) },
        }),
      ]))

      return h('div', {
        className: 'dsh-ps-col-popover',
        role: 'dialog',
        'aria-label': t('columnFilterLabel', { column: props.title }),
        'data-column-filter': column,
        ref: popoverRef,
        tabIndex: -1,
        onClick: function (event) { event.stopPropagation() },
      },
      sectionNodes,
      h('div', { className: 'dsh-ps-col-filter-foot' },
        h('span', { className: 'dsh-ps-col-filter-meta' }, props.countLabel),
        h('button', {
          type: 'button',
          className: 'dsh-ps-col-filter-clear',
          disabled: !isColumnFilterActive(filter),
          onClick: props.onClear,
        }, h(IconRefresh, { size: 11 }), h('span', null, t('filterClear')))))
    }

    function BoardColumn(props) {
      const t = props.t
      const filter = props.filter
      const menuActive = isColumnFilterMenuActive(filter)
      const filtered = menuActive
      return h('section', {
        className: 'dsh-ps-column',
        'data-column': props.variant,
        'data-drop': props.drop || undefined,
        'data-drag-active': props.dragActive ? 'true' : 'false',
        'data-filtered': filtered ? 'true' : 'false',
        'aria-label': props.title,
      },
      h('div', { className: 'dsh-ps-column-top' },
        h('header', { className: 'dsh-ps-column-head' },
          h('span', { className: 'dsh-ps-col-dot', 'data-status': props.dotStatus, 'aria-hidden': 'true' }),
          h('h2', { className: 'dsh-ps-column-title', title: props.titleHint || props.hint || props.title }, props.title),
          h('span', {
            className: 'dsh-ps-column-count',
            'data-filtered': filtered ? 'true' : 'false',
            title: props.countTitle || undefined,
          }, props.countLabel),
          h('span', { className: 'dsh-ps-column-grow' }),
          props.hint && props.variant === 'pending'
            ? h('span', { className: 'dsh-ps-column-hint', title: props.hint }, props.hint)
            : null,
          h('button', {
            type: 'button',
            ref: props.funnelRef,
            className: 'dsh-ps-funnel',
            'data-active': menuActive ? 'true' : 'false',
            'aria-label': t('columnFilterLabel', { column: props.title }),
            'aria-haspopup': 'dialog',
            'aria-expanded': filter.open ? 'true' : 'false',
            title: t('columnFilterLabel', { column: props.title }),
            onClick: props.onToggleFilter,
          },
          h(IconFilter, { size: 13 }),
          menuActive ? h('span', { className: 'dsh-ps-funnel-dot', 'aria-hidden': 'true' }) : null)),
        filter.open
          ? h(ColumnFilterPopover, {
            column: props.variant,
            title: props.title,
            t: t,
            filter: filter,
            groups: props.groups,
            countLabel: props.countLabel,
            toggleRef: props.funnelRef,
            onChange: props.onFilterChange,
            onClear: props.onClearFilters,
            onClose: props.onCloseFilter,
          })
          : null),
      h('div', {
        className: 'dsh-ps-column-body',
        onDragOver: props.onBodyDragOver,
        onDrop: props.onBodyDrop,
        onDragLeave: props.onBodyDragLeave,
      }, props.children,
      props.dropLabel ? h(DropZone, {
        key: 'dropzone',
        active: props.dropActive === true,
        label: props.dropLabel,
        variant: props.variant,
      }) : null))
    }

    function ColumnEmpty(props) {
      return h('div', { className: 'dsh-ps-column-empty', 'data-filtered': props.filtered ? 'true' : 'false' },
        h(props.icon, { size: props.iconSize || 22, className: 'dsh-ps-column-empty-icon' }),
        h('p', { className: 'dsh-ps-column-empty-title' }, props.title),
        props.hint ? h('p', { className: 'dsh-ps-column-empty-hint' }, props.hint) : null,
        props.action || null)
    }

    function DropZone(props) {
      return h('div', {
        className: 'dsh-ps-dropzone',
        'data-active': props.active ? 'true' : 'false',
        'data-variant': props.variant || undefined,
        'aria-hidden': 'true',
      },
      h(IconGrip, { size: 13 }),
      h('span', null, props.label))
    }

    // ------------------------------------------------------------------ settings panel

    function notificationPermission() {
      try {
        if (typeof Notification === 'undefined') return 'unsupported'
        return Notification.permission || 'default'
      } catch (error) {
        return 'unsupported'
      }
    }

    const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

    // 24-hour HH:mm text input: strips separators, caps at 5 chars and inserts
    // the colon automatically once four digits have been typed (2100 → 21:00).
    function sanitizeTimeInput(raw) {
      let value = typeof raw === 'string' ? raw : String(raw === undefined || raw === null ? '' : raw)
      value = value.replace(/[^\d:]/g, '')
      if (value.length > 5) value = value.slice(0, 5)
      if (/^\d{4}$/.test(value)) value = value.slice(0, 2) + ':' + value.slice(2)
      return value
    }

    function isValidReportTime(value) {
      return TIME_PATTERN.test(typeof value === 'string' ? value.trim() : '')
    }

    function reportStatusText(t, settings) {
      if (!settings) return t('reportStatusIdle')
      if (settings.lastStatus === 'running') return t('reportStatusRunning')
      if (settings.lastStatus === 'ok') return t('reportStatusOk')
      if (settings.lastStatus === 'failed') return t('reportStatusFailed')
      return t('reportStatusIdle')
    }

    function reportStatusTone(settings) {
      if (!settings) return 'idle'
      if (settings.lastStatus === 'running') return 'running'
      if (settings.lastStatus === 'ok') return 'ok'
      if (settings.lastStatus === 'failed') return 'failed'
      return 'idle'
    }

    function SettingsDialog(props) {
      const t = props.t
      const store = props.store
      const ctx = props.ctx
      const settings = props.settings
      const catalog = props.models && typeof props.models === 'object' ? props.models : null
      const reportSettings = props.reportSettings || (settings ? settings.dailyReport : null) || null
      const briefSettings = props.briefSettings || (settings ? settings.morningBrief : null) || defaultMorningBriefSettings()
      const evolutionSettings = (settings && settings.evolution) || defaultEvolutionSettings()
      const dialogRef = React.useRef(null)
      const doneRef = React.useRef(null)
      const [saving, setSaving] = React.useState(false)
      const [saveError, setSaveError] = React.useState(null)
      const [draftConcurrency, setDraftConcurrency] = React.useState(settings ? String(settings.concurrency) : '1')
      const [draftTime, setDraftTime] = React.useState(reportSettings ? reportSettings.time : '21:00')
      const [draftDir, setDraftDir] = React.useState(reportSettings ? reportSettings.dir : '')
      const [pickingReportDir, setPickingReportDir] = React.useState(false)
      const [reportFieldError, setReportFieldError] = React.useState(null)
      const [draftBriefTime, setDraftBriefTime] = React.useState(briefSettings.time)
      const [draftBriefDir, setDraftBriefDir] = React.useState(briefSettings.dir)
      const [pickingBriefDir, setPickingBriefDir] = React.useState(false)
      const [briefFieldError, setBriefFieldError] = React.useState(null)
      const [briefGeneratingLocal, setBriefGeneratingLocal] = React.useState(false)
      const [draftEvolutionTime, setDraftEvolutionTime] = React.useState(evolutionSettings.time)
      const [draftEvolutionDir, setDraftEvolutionDir] = React.useState(evolutionSettings.dir)
      const [pickingEvolutionDir, setPickingEvolutionDir] = React.useState(false)
      const [evolutionFieldError, setEvolutionFieldError] = React.useState(null)
      const [evolutionGenerating, setEvolutionGenerating] = React.useState(false)
      const [permission, setPermission] = React.useState(notificationPermission)
      const [backups, setBackups] = React.useState({ phase: 'loading', items: [], latest: null, error: null })
      const [backupsRefreshing, setBackupsRefreshing] = React.useState(false)
      const [confirmRestoreName, setConfirmRestoreName] = React.useState(null)
      const [restoringName, setRestoringName] = React.useState(null)
      const [backupError, setBackupError] = React.useState(null)
      const backupsMountedRef = React.useRef(true)
      const [draftWebhookUrl, setDraftWebhookUrl] = React.useState(settings && settings.webhook ? settings.webhook.url : '')
      const [webhookSaving, setWebhookSaving] = React.useState(false)
      const [webhookTesting, setWebhookTesting] = React.useState(false)
      const [webhookError, setWebhookError] = React.useState(null)
      const [webhookNotice, setWebhookNotice] = React.useState(null)
      const webhookUrlFocusedRef = React.useRef(false)
      const webhookSavingRef = React.useRef(false)
      const webhookUrlRef = React.useRef(null)

      useDialogA11y(dialogRef, props.onClose, true, doneRef)

      // Load recovery points as soon as the settings dialog opens.
      React.useEffect(function () {
        backupsMountedRef.current = true
        loadBackups(true)
        return function () { backupsMountedRef.current = false }
      }, [])

      React.useEffect(function () {
        if (!settings) return
        setDraftConcurrency(String(settings.concurrency))
      }, [settings ? settings.concurrency : -1])

      React.useEffect(function () {
        if (!reportSettings) return
        setDraftTime(reportSettings.time)
        setDraftDir(reportSettings.dir)
      }, [reportSettings ? reportSettings.time : '', reportSettings ? reportSettings.dir : ''])

      React.useEffect(function () {
        setDraftBriefTime(briefSettings.time)
        setDraftBriefDir(briefSettings.dir)
      }, [briefSettings.time, briefSettings.dir])

      React.useEffect(function () {
        setDraftEvolutionTime(evolutionSettings.time)
        setDraftEvolutionDir(evolutionSettings.dir)
      }, [evolutionSettings.time, evolutionSettings.dir])

      // Reflect the Host's generation state in the section's button/spinner.
      React.useEffect(function () {
        const running = evolutionSettings.lastStatus === 'running' || Boolean(evolutionSettings.generatingDate)
        setEvolutionGenerating(running)
      }, [evolutionSettings.lastStatus, evolutionSettings.generatingDate])

      React.useEffect(function () {
        if (webhookUrlFocusedRef.current) return
        const nextUrl = settings && settings.webhook && typeof settings.webhook.url === 'string' ? settings.webhook.url : ''
        setDraftWebhookUrl(nextUrl)
      }, [settings && settings.webhook ? settings.webhook.url : ''])

      function save(patch) {
        setSaving(true)
        setSaveError(null)
        return store.saveSettings(patch).then(function (result) {
          setSaving(false)
          if (!result.ok) setSaveError(result.error || t('settingsFailed'))
          return result
        })
      }

      function commitConcurrency(raw) {
        if (!settings) return
        let value = parseInt(String(raw), 10)
        if (!isFinite(value)) value = settings.concurrency
        value = Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(value)))
        setDraftConcurrency(String(value))
        if (value === settings.concurrency) return
        save({ concurrency: value })
      }

      function stepConcurrency(delta) {
        if (!settings) return
        const next = Math.max(1, Math.min(MAX_CONCURRENCY, (settings.concurrency || 1) + delta))
        setDraftConcurrency(String(next))
        if (next !== settings.concurrency) save({ concurrency: next })
      }

      function pickModel(event) {
        const pair = parseModelValue(event.target.value)
        if (!pair) return
        const found = findCatalogModel(catalog, pair.provider, pair.model)
        let effort = null
        if (found && found.model.reasoning && Array.isArray(found.model.reasoning.efforts)) {
          const efforts = found.model.reasoning.efforts
          const current = settings ? settings.reasoningEffort : null
          const valid = current !== null && efforts.some(function (item) { return item && item.id === current })
          effort = valid ? current : (typeof found.model.reasoning.defaultEffort === 'string' ? found.model.reasoning.defaultEffort : null)
        }
        save({ provider: pair.provider, model: pair.model, reasoningEffort: effort })
      }

      function pickEffort(event) {
        const value = event.target.value
        save({ reasoningEffort: value === '' ? null : value })
      }

      function retryModels() {
        store.loadModels(true)
      }

      function toggleNotifyOnDone() {
        if (!settings) return
        const next = !settings.notifyOnDone
        if (next) {
          try {
            if (typeof Notification !== 'undefined' && Notification.permission === 'default' && typeof Notification.requestPermission === 'function') {
              const attempt = Notification.requestPermission()
              if (attempt && typeof attempt.then === 'function') {
                attempt.then(function () { setPermission(notificationPermission()) }, function () { /* the switch still works without system notifications */ })
              }
            }
          } catch (error) {
            // notification support is optional
          }
        }
        save({ notifyOnDone: next })
      }

      function toggleReportEnabled() {
        if (!reportSettings || saving) return
        setReportFieldError(null)
        save({ dailyReport: { enabled: !reportSettings.enabled } })
      }

      function handleReportTimeChange(raw) {
        const value = sanitizeTimeInput(raw)
        setDraftTime(value)
        if (reportFieldError !== null && isValidReportTime(value)) setReportFieldError(null)
      }

      function commitReportTime(raw) {
        if (!reportSettings) return
        const value = sanitizeTimeInput(String(raw || '').trim())
        setDraftTime(value)
        if (!isValidReportTime(value)) {
          // Invalid 24-hour value: inline field error, never submit.
          setReportFieldError(t('reportTimeInvalid'))
          return
        }
        setReportFieldError(null)
        if (value === reportSettings.time) return
        save({ dailyReport: { time: value } })
      }

      function commitReportDir(raw) {
        if (!reportSettings) return
        const value = String(raw || '').trim()
        setDraftDir(value)
        if (value === reportSettings.dir) return
        save({ dailyReport: { dir: value } })
      }

      function pickReportDirectory() {
        if (pickingReportDir || saving) return
        const service = ctx && ctx.uiWorkspace ? ctx.uiWorkspace : null
        if (!service || typeof service.pickDirectory !== 'function') {
          store.reportError(t('pickFailed'))
          return
        }
        setPickingReportDir(true)
        let attempt = null
        try { attempt = service.pickDirectory() } catch (error) { attempt = Promise.reject(error) }
        Promise.resolve(attempt).then(function (picked) {
          setPickingReportDir(false)
          if (typeof picked === 'string' && picked.trim() !== '') {
            setDraftDir(picked)
            save({ dailyReport: { dir: picked } })
          }
        }, function (error) {
          setPickingReportDir(false)
          store.reportError(t('pickFailed') + ' — ' + (error && error.message ? error.message : t('unknownError')))
        })
      }

      function generateReportNow() {
        if (props.reportGenerating) return
        props.onGenerateReport(todayKey())
      }

      // ---- v0.6: morning brief settings (write straight through to saveSettings)
      const briefBusy = props.briefGenerating === true || briefGeneratingLocal

      React.useEffect(function () {
        if (!briefGeneratingLocal) return undefined
        const timer = setTimeout(function () { setBriefGeneratingLocal(false) }, 90000)
        return function () { clearTimeout(timer) }
      }, [briefGeneratingLocal])

      function saveBrief(patch) {
        setBriefFieldError(null)
        return save({ morningBrief: patch })
      }

      function toggleBriefEnabled() {
        if (saving) return
        void saveBrief({ enabled: briefSettings.enabled !== true })
      }

      function handleBriefTimeChange(raw) {
        const value = sanitizeTimeInput(raw)
        setDraftBriefTime(value)
        if (briefFieldError !== null && isValidReportTime(value)) setBriefFieldError(null)
      }

      function commitBriefTime(raw) {
        const value = sanitizeTimeInput(String(raw || '').trim())
        setDraftBriefTime(value)
        if (!isValidReportTime(value)) {
          // Invalid 24-hour value: inline field error, never submit.
          setBriefFieldError(t('briefTimeInvalid'))
          return
        }
        setBriefFieldError(null)
        if (value === briefSettings.time) return
        void saveBrief({ time: value })
      }

      function commitBriefDir(raw) {
        const value = String(raw || '').trim()
        setDraftBriefDir(value)
        if (value === briefSettings.dir) return
        void saveBrief({ dir: value })
      }

      function pickBriefDirectory() {
        if (pickingBriefDir || saving) return
        const service = ctx && ctx.uiWorkspace ? ctx.uiWorkspace : null
        if (!service || typeof service.pickDirectory !== 'function') {
          store.reportError(t('pickFailed'))
          return
        }
        setPickingBriefDir(true)
        let attempt = null
        try { attempt = service.pickDirectory() } catch (error) { attempt = Promise.reject(error) }
        Promise.resolve(attempt).then(function (picked) {
          setPickingBriefDir(false)
          if (typeof picked === 'string' && picked.trim() !== '') {
            setDraftBriefDir(picked)
            void saveBrief({ dir: picked })
          }
        }, function (error) {
          setPickingBriefDir(false)
          store.reportError(t('pickFailed') + ' — ' + (error && error.message ? error.message : t('unknownError')))
        })
      }

      function generateBriefNow() {
        if (briefBusy) return
        setBriefGeneratingLocal(true)
        store.generateBrief(todayKey()).then(function (result) {
          if (!result.ok) {
            setBriefGeneratingLocal(false)
            return
          }
          if (typeof props.addToast === 'function') props.addToast(t('briefGenerating'), 'info')
          void store.refreshBriefs()
        })
      }

      // ---- v9: self-evolution settings (write straight through to saveSettings)
      React.useEffect(function () {
        if (!evolutionGenerating) return undefined
        const timer = setTimeout(function () { setEvolutionGenerating(false) }, 90000)
        return function () { clearTimeout(timer) }
      }, [evolutionGenerating])

      function saveEvolution(patch) {
        setEvolutionFieldError(null)
        return save({ evolution: patch })
      }

      function toggleEvolutionEnabled() {
        if (saving) return
        void saveEvolution({ enabled: !evolutionSettings.enabled })
      }

      function changeEvolutionInterval(value) {
        if (EVOLUTION_INTERVALS.indexOf(value) < 0) return
        if (value === evolutionSettings.interval) return
        void saveEvolution({ interval: value })
      }

      function handleEvolutionTimeChange(raw) {
        const value = sanitizeTimeInput(raw)
        setDraftEvolutionTime(value)
        if (evolutionFieldError !== null && isValidReportTime(value)) setEvolutionFieldError(null)
      }

      function commitEvolutionTime(raw) {
        const value = sanitizeTimeInput(String(raw || '').trim())
        setDraftEvolutionTime(value)
        if (!isValidReportTime(value)) {
          // Invalid 24-hour value: inline field error, never submit.
          setEvolutionFieldError(t('evolutionTimeInvalid'))
          return
        }
        setEvolutionFieldError(null)
        if (value === evolutionSettings.time) return
        void saveEvolution({ time: value })
      }

      function changeEvolutionWeekday(raw) {
        const value = parseInt(String(raw), 10)
        if (!isFinite(value) || value < 0 || value > 6) return
        if (value === evolutionSettings.weekday) return
        void saveEvolution({ weekday: value })
      }

      function changeEvolutionSkillMode(value) {
        if (EVOLUTION_SKILL_MODES.indexOf(value) < 0) return
        if (value === evolutionSettings.skillMode) return
        void saveEvolution({ skillMode: value })
      }

      function commitEvolutionDir(raw) {
        const value = String(raw || '').trim()
        setDraftEvolutionDir(value)
        if (value === evolutionSettings.dir) return
        void saveEvolution({ dir: value })
      }

      function pickEvolutionDirectory() {
        if (pickingEvolutionDir || saving) return
        const service = ctx && ctx.uiWorkspace ? ctx.uiWorkspace : null
        if (!service || typeof service.pickDirectory !== 'function') {
          store.reportError(t('pickFailed'))
          return
        }
        setPickingEvolutionDir(true)
        let attempt = null
        try { attempt = service.pickDirectory() } catch (error) { attempt = Promise.reject(error) }
        Promise.resolve(attempt).then(function (picked) {
          setPickingEvolutionDir(false)
          if (typeof picked === 'string' && picked.trim() !== '') {
            setDraftEvolutionDir(picked)
            void saveEvolution({ dir: picked })
          }
        }, function (error) {
          setPickingEvolutionDir(false)
          store.reportError(t('pickFailed') + ' — ' + (error && error.message ? error.message : t('unknownError')))
        })
      }

      function generateEvolutionNow() {
        if (evolutionGenerating) return
        setEvolutionGenerating(true)
        store.generateRetrospective().then(function (result) {
          if (!result.ok) {
            setEvolutionGenerating(false)
            return
          }
          const payload = result.data && typeof result.data === 'object' ? result.data : {}
          if (payload.skipped) {
            setEvolutionGenerating(false)
            if (typeof props.addToast === 'function') props.addToast(t('retrospectiveSkipped'), 'info')
            return
          }
          if (typeof props.addToast === 'function') props.addToast(t('retrospectiveGenerating'), 'info')
          void store.refresh()
        })
      }

      function loadBackups(initial) {
        if (!initial) setBackupsRefreshing(true)
        setBackupError(null)
        return store.loadBackups().then(function (result) {
          if (!backupsMountedRef.current) return result
          setBackupsRefreshing(false)
          if (result.ok) {
            const meta = result.data && typeof result.data === 'object' ? result.data : { items: [], latest: null, total: 0 }
            setBackups({ phase: 'ready', items: Array.isArray(meta.items) ? meta.items : [], latest: meta.latest || null, error: null })
          } else {
            const message = result.error || t('backupLoadFailed')
            setBackupError(message)
            setBackups(function (previous) {
              return { phase: 'error', items: previous.items, latest: previous.latest, error: message }
            })
          }
          return result
        })
      }

      function restoreBackup(name) {
        if (restoringName !== null) return
        const backup = backups.items.find(function (item) { return item.name === name }) || null
        setRestoringName(name)
        setBackupError(null)
        store.restoreBackup(name).then(function (result) {
          if (!backupsMountedRef.current) return
          setRestoringName(null)
          if (!result.ok) {
            setBackupError(result.error || t('backupRestoreFailed'))
            return
          }
          setConfirmRestoreName(null)
          if (typeof store.refresh === 'function') void store.refresh()
          if (typeof props.addToast === 'function') {
            const time = backup && backup.savedAt > 0 ? formatTime(backup.savedAt) : name
            props.addToast(t('backupRestored', { time: time }), 'success')
          }
          loadBackups(false)
        }, function (error) {
          if (!backupsMountedRef.current) return
          setRestoringName(null)
          setBackupError(error && error.message ? error.message : t('backupRestoreFailed'))
        })
      }

      function applyWebhookPatch(patch) {
        if (webhookSavingRef.current) return Promise.resolve({ ok: false })
        webhookSavingRef.current = true
        setWebhookSaving(true)
        setWebhookError(null)
        setWebhookNotice(null)
        return store.saveWebhook(patch).then(function (result) {
          webhookSavingRef.current = false
          setWebhookSaving(false)
          if (!result.ok) setWebhookError(result.error || t('settingsFailed'))
          return result
        })
      }

      function toggleWebhookEnabled() {
        if (webhookSaving || webhookTesting) return
        const webhookCurrent = getWebhook()
        if (webhookCurrent.enabled === true) {
          void applyWebhookPatch({ enabled: false })
          return
        }
        const url = draftWebhookUrl.trim()
        if (url === '') {
          setWebhookError(t('webhookUrlRequired'))
          focusWebhookUrl()
          return
        }
        if (!isValidWebhookUrl(url)) {
          setWebhookError(t('webhookUrlInvalid'))
          focusWebhookUrl()
          return
        }
        void applyWebhookPatch({ enabled: true, url: url })
      }

      function focusWebhookUrl() {
        const node = webhookUrlRef.current
        if (node && typeof node.focus === 'function') {
          try { node.focus() } catch (error) { /* focus is progressive enhancement */ }
        }
      }

      function commitWebhookUrl(raw) {
        const value = typeof raw === 'string' ? raw.trim() : ''
        const webhookCurrent = getWebhook()
        if (value === '') {
          if (webhookCurrent.enabled) {
            setWebhookError(t('webhookUrlRequired'))
            return
          }
          setDraftWebhookUrl('')
          if (webhookCurrent.url !== '') void applyWebhookPatch({ url: '' })
          return
        }
        if (!isValidWebhookUrl(value)) {
          setWebhookError(t('webhookUrlInvalid'))
          return
        }
        setDraftWebhookUrl(value)
        setWebhookError(null)
        if (value === webhookCurrent.url) return
        void applyWebhookPatch({ url: value })
      }

      function changeWebhookFormat(value) {
        if (WEBHOOK_FORMATS.indexOf(value) < 0) return
        if (value === getWebhook().format) return
        void applyWebhookPatch({ format: value })
      }

      function toggleWebhookEvent(eventKey) {
        const webhookCurrent = getWebhook()
        if (WEBHOOK_EVENT_KEYS.indexOf(eventKey) < 0) return
        const events = Object.assign({}, webhookCurrent.events)
        events[eventKey] = webhookCurrent.events[eventKey] === false
        void applyWebhookPatch({ events: events })
      }

      function sendWebhookTest() {
        if (webhookTesting || webhookSaving) return
        const webhookCurrent = getWebhook()
        const url = draftWebhookUrl.trim()
        if (!isValidWebhookUrl(url)) {
          setWebhookError(t('webhookUrlRequired'))
          focusWebhookUrl()
          return
        }
        setWebhookTesting(true)
        setWebhookError(null)
        setWebhookNotice(null)
        // Testing only needs the Host to know the URL: commit a fresh draft URL
        // first (works even while notifications are off), then fire the test.
        const commitTestUrl = url === webhookCurrent.url
          ? Promise.resolve({ ok: true })
          : store.saveWebhook({ url: url })
        commitTestUrl.then(function (saved) {
          if (!saved.ok) {
            setWebhookTesting(false)
            setWebhookError(saved.error || t('webhookUrlInvalid'))
            return
          }
          store.testWebhook().then(function (result) {
            setWebhookTesting(false)
            if (!result.ok) {
              setWebhookError(result.error || t('webhookTestFailed'))
            } else {
              setWebhookError(null)
              setWebhookNotice(t('webhookTestSent'))
              if (typeof props.addToast === 'function') props.addToast(t('webhookTestSent'), 'success')
            }
            // sendTest records lastStatus/lastAt/lastEvent on the Host, so pull
            // the fresh state on both success and failure.
            if (typeof store.refresh === 'function') void store.refresh()
          })
        })
      }

      const currentValue = settings ? modelValue(settings.provider, settings.model) : ''
      const currentModel = settings && catalog ? findCatalogModel(catalog, settings.provider, settings.model) : null
      const efforts = currentModel && currentModel.model.reasoning && Array.isArray(currentModel.model.reasoning.efforts)
        ? currentModel.model.reasoning.efforts
        : null

      const modelOptions = []
      if (catalog && Array.isArray(catalog.groups)) {
        for (let i = 0; i < catalog.groups.length; i += 1) {
          const group = catalog.groups[i]
          if (!group || !Array.isArray(group.models)) continue
          const options = []
          for (let j = 0; j < group.models.length; j += 1) {
            const entry = group.models[j]
            if (!entry || typeof entry.id !== 'string') continue
            options.push(h('option', { key: entry.id, value: modelValue(group.id, entry.id) }, entry.name || entry.id))
          }
          if (options.length > 0) modelOptions.push(h('optgroup', { key: String(group.id || i), label: group.name || group.id || 'Provider' }, options))
        }
      }
      if (settings) {
        const known = catalog ? findCatalogModel(catalog, settings.provider, settings.model) : null
        if (!known) {
          modelOptions.push(h('optgroup', { key: 'current', label: t('current') },
            h('option', { value: currentValue }, (settings.provider ? settings.provider + '/' : '') + (settings.model || t('noModel')))))
        }
      }

      const effortOptions = [h('option', { key: 'default', value: '' }, t('effortDefault'))]
      if (efforts) {
        for (let i = 0; i < efforts.length; i += 1) {
          const effort = efforts[i]
          if (!effort || typeof effort.id !== 'string') continue
          effortOptions.push(h('option', { key: effort.id, value: effort.id }, effort.name || effort.id))
        }
      }

      const catalogFailed = props.modelsPhase === 'error'
      const catalogLoading = props.modelsPhase === 'loading' || props.modelsPhase === 'idle'
      const catalogUnavailable = catalog === null && !catalogLoading

      let notifyHint = t('notifyOnDoneHint')
      if (permission === 'denied') notifyHint = t('notifyDenied')
      else if (permission === 'unsupported') notifyHint = t('notifyUnsupported')

      const reportTone = reportStatusTone(reportSettings)
      const reportBusy = props.reportGenerating === true
      let reportMetaText = t('reportStatusIdle')
      if (reportSettings && reportSettings.lastDate) reportMetaText = reportSettings.lastDate
      if (reportSettings && reportSettings.lastGeneratedAt > 0) reportMetaText = reportMetaText + ' · ' + formatTime(reportSettings.lastGeneratedAt)

      function section(key, icon, title, sub, children) {
        return h('section', { key: key, className: 'dsh-ps-settings-group' },
          h('div', { className: 'dsh-ps-settings-group-head' },
            h('span', { className: 'dsh-ps-settings-group-icon', 'aria-hidden': 'true' }, h(icon, { size: 17 })),
            h('div', { className: 'dsh-ps-settings-group-titles' },
              h('h3', { className: 'dsh-ps-settings-group-title' }, title),
              h('p', { className: 'dsh-ps-settings-group-sub' }, sub))),
          h('div', { className: 'dsh-ps-settings-grid' }, children))
      }

      const concurrencyField = h(Field, { key: 'concurrency', label: t('concurrency'), htmlFor: 'dsh-ps-settings-concurrency', hint: t('concurrencyHint') },
        h('div', { className: 'dsh-ps-stepper' },
          h('button', {
            type: 'button',
            'aria-label': t('concurrency') + ' -',
            disabled: saving || !settings || settings.concurrency <= 1,
            onClick: function () { stepConcurrency(-1) },
          }, '−'),
          h('input', {
            id: 'dsh-ps-settings-concurrency',
            type: 'number',
            min: 1,
            max: MAX_CONCURRENCY,
            value: draftConcurrency,
            'aria-label': t('concurrency'),
            disabled: saving || !settings,
            onChange: function (event) { setDraftConcurrency(event.target.value) },
            onBlur: function (event) { commitConcurrency(event.target.value) },
            onKeyDown: function (event) {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitConcurrency(event.currentTarget.value)
              }
            },
          }),
          h('button', {
            type: 'button',
            'aria-label': t('concurrency') + ' +',
            disabled: saving || !settings || settings.concurrency >= MAX_CONCURRENCY,
            onClick: function () { stepConcurrency(1) },
          }, '+')))

      const modelField = h(Field, { key: 'model', label: t('defaultModel'), htmlFor: 'dsh-ps-settings-model' },
        catalogUnavailable
          ? h('div', { className: 'dsh-ps-field-fallback' },
            h('div', { className: 'dsh-ps-field-hint' },
              h('strong', null, t('modelsUnavailable')),
              catalogFailed && props.modelsError ? ' — ' + props.modelsError : ''),
            h('div', { className: 'dsh-ps-dir-row' },
              h('input', {
                id: 'dsh-ps-settings-model',
                className: 'dsh-ps-input',
                type: 'text',
                defaultValue: settings ? settings.provider : '',
                placeholder: t('provider'),
                'aria-label': t('provider'),
                spellCheck: false,
                disabled: saving || !settings,
                onBlur: function (event) {
                  const value = event.target.value.trim()
                  if (!settings || value === '' || value === settings.provider) return
                  save({ provider: value })
                },
              }),
              h('input', {
                className: 'dsh-ps-input',
                type: 'text',
                defaultValue: settings ? settings.model : '',
                placeholder: t('modelId'),
                'aria-label': t('modelId'),
                spellCheck: false,
                disabled: saving || !settings,
                onBlur: function (event) {
                  const value = event.target.value.trim()
                  if (!settings || value === '' || value === settings.model) return
                  save({ model: value })
                },
              })),
            h('div', { className: 'dsh-ps-field-hint' }, t('modelsUnavailableHint')),
            h('button', { type: 'button', className: 'dsh-ps-btn dsh-ps-btn-sm', onClick: retryModels }, t('retry')))
          : h('select', {
            id: 'dsh-ps-settings-model',
            className: 'dsh-ps-select',
            value: currentValue,
            disabled: saving || catalogLoading,
            onChange: pickModel,
          }, catalogLoading ? h('option', { value: currentValue }, t('modelsLoading')) : modelOptions))

      const effortField = h(Field, { key: 'effort', label: t('reasoningEffort'), htmlFor: 'dsh-ps-settings-effort' },
        h('select', {
          id: 'dsh-ps-settings-effort',
          className: 'dsh-ps-select',
          value: settings && typeof settings.reasoningEffort === 'string' ? settings.reasoningEffort : '',
          disabled: saving || !settings || !efforts || efforts.length === 0,
          onChange: pickEffort,
        }, effortOptions),
        efforts && efforts.length > 0 ? null : h('div', { className: 'dsh-ps-field-hint' }, t('effortDefault')))

      const autoStartField = h(Field, { key: 'auto-start', label: t('autoStart'), htmlFor: 'dsh-ps-settings-autostart' },
        h('div', { className: 'dsh-ps-switch-inline', id: 'dsh-ps-settings-autostart' },
          h(Switch, {
            checked: !!(settings && settings.autoStart),
            disabled: saving || !settings,
            label: t('autoStart'),
            onChange: function () {
              if (!settings) return
              save({ autoStart: !settings.autoStart })
            },
          }),
          h('span', { className: 'dsh-ps-field-hint' }, t('autoStartHint'))))

      const notifyRow = h('div', { key: 'notify', className: 'dsh-ps-settings-row dsh-ps-settings-span-2' },
        h(Switch, {
          checked: !!(settings && settings.notifyOnDone),
          disabled: saving || !settings,
          label: t('notifyOnDone'),
          onChange: toggleNotifyOnDone,
        }),
        h('div', { className: 'dsh-ps-settings-row-text' },
          h('span', { className: 'dsh-ps-settings-row-label' }, t('notifyOnDone')),
          h('p', { className: 'dsh-ps-settings-row-hint' }, notifyHint)))

      const reportEnableRow = h('div', { key: 'report-enable', className: 'dsh-ps-settings-row' },
        h(Switch, {
          checked: !!(reportSettings && reportSettings.enabled),
          disabled: saving || !reportSettings,
          label: t('reportEnable'),
          onChange: toggleReportEnabled,
        }),
        h('div', { className: 'dsh-ps-settings-row-text' },
          h('span', { className: 'dsh-ps-settings-row-label' }, t('reportEnable')),
          h('p', { className: 'dsh-ps-settings-row-hint' }, t('reportEnableHint'))))

      const reportTimeField = h(Field, { key: 'report-time', label: t('reportTime'), htmlFor: 'dsh-ps-settings-report-time', hint: t('reportTimeHint'), error: reportFieldError },
        h('input', {
          id: 'dsh-ps-settings-report-time',
          className: 'dsh-ps-input dsh-ps-time-input',
          type: 'text',
          inputMode: 'numeric',
          autoComplete: 'off',
          maxLength: 5,
          placeholder: '21:00',
          value: draftTime,
          disabled: saving || !reportSettings,
          'aria-invalid': reportFieldError ? 'true' : 'false',
          spellCheck: false,
          onChange: function (event) { handleReportTimeChange(event.target.value) },
          onBlur: function (event) { commitReportTime(event.currentTarget.value) },
          onKeyDown: function (event) {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitReportTime(event.currentTarget.value)
            }
          },
        }))

      const reportDirField = h(Field, { key: 'report-dir', label: t('reportDir'), htmlFor: 'dsh-ps-settings-report-dir', hint: t('reportDirHint') },
        h('div', { className: 'dsh-ps-dir-row' },
          h('input', {
            id: 'dsh-ps-settings-report-dir',
            className: 'dsh-ps-input',
            type: 'text',
            value: draftDir,
            placeholder: t('fieldCwdPlaceholder'),
            spellCheck: false,
            disabled: saving || !reportSettings,
            onChange: function (event) { setDraftDir(event.target.value) },
            onBlur: function (event) { commitReportDir(event.target.value) },
            onKeyDown: function (event) {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitReportDir(event.currentTarget.value)
              }
            },
          }),
          h('button', {
            type: 'button',
            className: 'dsh-ps-btn',
            disabled: saving || pickingReportDir || !reportSettings,
            'aria-label': t('chooseDirectory'),
            title: t('chooseDirectory'),
            onClick: pickReportDirectory,
          }, pickingReportDir ? h(Spinner) : h(IconFolder, { size: 15 }))))

      const reportStatusRow = h('div', { key: 'report-status', className: 'dsh-ps-settings-status dsh-ps-settings-span-2' },
        h('span', { className: 'dsh-ps-field-label' }, t('reportLastStatus')),
        h('div', { className: 'dsh-ps-settings-status-line' },
          h('span', { className: 'dsh-ps-report-status-chip', 'data-tone': reportTone },
            reportBusy ? h(Spinner) : null,
            h('span', null, reportBusy ? t('reportGenerating') : reportStatusText(t, reportSettings))),
          h('span', { className: 'dsh-ps-settings-status-date' }, reportMetaText),
          h('span', { className: 'dsh-ps-settings-status-grow' }),
          h('button', {
            type: 'button',
            className: 'dsh-ps-btn dsh-ps-btn-sm',
            disabled: saving || reportBusy || !reportSettings,
            onClick: generateReportNow,
          }, reportBusy ? h(Spinner) : h(IconPlay, { size: 12 }), h('span', null, t('reportGenerateNow')))),
        reportSettings && reportSettings.lastError
          ? h('div', { className: 'dsh-ps-field-error' }, t('reportError') + ' — ' + reportSettings.lastError)
          : null)

      // ---- v0.6: morning brief section (between the daily report and the
      // retrospective section, per the v0.6 contract §4.4)
      const briefStatusToneValue = briefStatusTone(briefSettings)
      let briefMetaText = t('briefStatusIdle')
      if (briefSettings.lastDate) briefMetaText = briefSettings.lastDate
      if (briefSettings.lastGeneratedAt > 0) {
        briefMetaText = briefMetaText + (briefSettings.lastDate ? ' · ' : '') + formatTime(briefSettings.lastGeneratedAt)
      }
      const briefEnableRow = h('div', { key: 'brief-enable', className: 'dsh-ps-settings-row' },
        h(Switch, {
          checked: briefSettings.enabled === true,
          disabled: saving,
          label: t('briefEnable'),
          onChange: toggleBriefEnabled,
        }),
        h('div', { className: 'dsh-ps-settings-row-text' },
          h('span', { className: 'dsh-ps-settings-row-label' }, t('briefEnable')),
          h('p', { className: 'dsh-ps-settings-row-hint' }, t('briefEnableHint'))))

      const briefTimeField = h(Field, { key: 'brief-time', label: t('briefTime'), htmlFor: 'dsh-ps-settings-brief-time', hint: t('briefTimeHint'), error: briefFieldError },
        h('input', {
          id: 'dsh-ps-settings-brief-time',
          className: 'dsh-ps-input dsh-ps-time-input',
          type: 'text',
          inputMode: 'numeric',
          autoComplete: 'off',
          maxLength: 5,
          placeholder: '08:30',
          value: draftBriefTime,
          disabled: saving,
          'aria-invalid': briefFieldError ? 'true' : 'false',
          spellCheck: false,
          onChange: function (event) { handleBriefTimeChange(event.target.value) },
          onBlur: function (event) { commitBriefTime(event.currentTarget.value) },
          onKeyDown: function (event) {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitBriefTime(event.currentTarget.value)
            }
          },
        }))

      const briefDirField = h(Field, { key: 'brief-dir', label: t('briefDir'), htmlFor: 'dsh-ps-settings-brief-dir', hint: t('briefDirHint') },
        h('div', { className: 'dsh-ps-dir-row' },
          h('input', {
            id: 'dsh-ps-settings-brief-dir',
            className: 'dsh-ps-input',
            type: 'text',
            value: draftBriefDir,
            placeholder: t('fieldCwdPlaceholder'),
            spellCheck: false,
            disabled: saving,
            onChange: function (event) { setDraftBriefDir(event.target.value) },
            onBlur: function (event) { commitBriefDir(event.target.value) },
            onKeyDown: function (event) {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitBriefDir(event.currentTarget.value)
              }
            },
          }),
          h('button', {
            type: 'button',
            className: 'dsh-ps-btn',
            disabled: saving || pickingBriefDir,
            'aria-label': t('chooseDirectory'),
            title: t('chooseDirectory'),
            onClick: pickBriefDirectory,
          }, pickingBriefDir ? h(Spinner) : h(IconFolder, { size: 15 }))))

      const briefStatusRow = h('div', { key: 'brief-status', className: 'dsh-ps-settings-status dsh-ps-settings-span-2' },
        h('span', { className: 'dsh-ps-field-label' }, t('briefLast')),
        h('div', { className: 'dsh-ps-settings-status-line' },
          h('span', { className: 'dsh-ps-report-status-chip', 'data-tone': briefStatusToneValue },
            briefBusy ? h(Spinner) : null,
            h('span', null, briefBusy ? t('briefGenerating') : briefStatusText(t, briefSettings))),
          h('span', { className: 'dsh-ps-settings-status-date' }, briefMetaText),
          h('span', { className: 'dsh-ps-settings-status-grow' }),
          h('button', {
            type: 'button',
            className: 'dsh-ps-btn dsh-ps-btn-sm',
            disabled: saving || briefBusy,
            onClick: generateBriefNow,
          }, briefBusy ? h(Spinner) : h(IconPlay, { size: 12 }), h('span', null, briefBusy ? t('briefStatusRunning') : t('briefGenerateNow')))),
        briefSettings.lastError
          ? h('div', { className: 'dsh-ps-field-error' }, t('briefErrorLabel') + ' — ' + briefSettings.lastError)
          : null)

      const briefSection = section('brief', IconCalendar, t('briefSettingsTitle'), t('briefSettingsSub'), [
        briefEnableRow,
        briefTimeField,
        h('div', { key: 'brief-dir-wrap', className: 'dsh-ps-settings-span-2' }, briefDirField),
        briefStatusRow,
      ])

      // ---- v9: self-evolution section (after the daily report section)
      const evolutionBusy = evolutionGenerating
      let evolutionStatusLabel = t('evolutionStatusIdle')
      let evolutionStatusToneValue = 'idle'
      if (evolutionSettings.lastStatus === 'running') {
        evolutionStatusLabel = t('evolutionStatusRunning')
        evolutionStatusToneValue = 'running'
      } else if (evolutionSettings.lastStatus === 'ok') {
        evolutionStatusLabel = t('evolutionStatusOk')
        evolutionStatusToneValue = 'ok'
      } else if (evolutionSettings.lastStatus === 'failed') {
        evolutionStatusLabel = t('evolutionStatusFailed')
        evolutionStatusToneValue = 'failed'
      }
      let evolutionMetaText = t('evolutionLastPending')
      if (evolutionSettings.lastDate) evolutionMetaText = evolutionSettings.lastDate
      if (evolutionSettings.lastGeneratedAt) evolutionMetaText = evolutionMetaText + ' · ' + formatTime(evolutionSettings.lastGeneratedAt)

      function evolutionIntervalButton(value, label) {
        const selected = evolutionSettings.interval === value
        return h('button', {
          key: value,
          type: 'button',
          className: 'dsh-ps-segment',
          'aria-pressed': selected ? 'true' : 'false',
          disabled: saving,
          onClick: function () { changeEvolutionInterval(value) },
        }, h('span', null, label))
      }

      const evolutionIntervalField = h(Field, { key: 'evolution-interval', label: t('evolutionInterval') },
        h('div', { className: 'dsh-ps-segmented', role: 'group', 'aria-label': t('evolutionInterval') },
          evolutionIntervalButton('daily', t('intervalDaily')),
          evolutionIntervalButton('weekly', t('intervalWeekly'))))

      const evolutionTimeField = h(Field, {
        key: 'evolution-time',
        label: t('evolutionTime'),
        htmlFor: 'dsh-ps-settings-evolution-time',
        hint: t('evolutionTimeHint'),
        error: evolutionFieldError,
      },
      h('input', {
        id: 'dsh-ps-settings-evolution-time',
        className: 'dsh-ps-input dsh-ps-time-input',
        type: 'text',
        inputMode: 'numeric',
        autoComplete: 'off',
        maxLength: 5,
        placeholder: '22:00',
        value: draftEvolutionTime,
        disabled: saving,
        'aria-invalid': evolutionFieldError ? 'true' : 'false',
        spellCheck: false,
        onChange: function (event) { handleEvolutionTimeChange(event.target.value) },
        onBlur: function (event) { commitEvolutionTime(event.currentTarget.value) },
        onKeyDown: function (event) {
          if (event.key === 'Enter') {
            event.preventDefault()
            commitEvolutionTime(event.currentTarget.value)
          }
        },
      }))

      const evolutionWeekdayOptions = []
      const evolutionWeekdayOrder = [1, 2, 3, 4, 5, 6, 0]
      for (let i = 0; i < evolutionWeekdayOrder.length; i += 1) {
        const value = evolutionWeekdayOrder[i]
        evolutionWeekdayOptions.push(h('option', { key: String(value), value: String(value) }, weekdayLabel(t, value)))
      }
      const evolutionWeekdayField = h(Field, {
        key: 'evolution-weekday',
        label: t('evolutionWeekday'),
        htmlFor: 'dsh-ps-settings-evolution-weekday',
      },
      h('select', {
        id: 'dsh-ps-settings-evolution-weekday',
        className: 'dsh-ps-select',
        value: String(evolutionSettings.weekday),
        disabled: saving,
        onChange: function (event) { changeEvolutionWeekday(event.target.value) },
      }, evolutionWeekdayOptions))

      const evolutionSkillModeField = h(Field, {
        key: 'evolution-skill-mode',
        label: t('evolutionSkillMode'),
        htmlFor: 'dsh-ps-settings-evolution-skill-mode',
        hint: t('evolutionSkillModeHint'),
      },
      h('select', {
        id: 'dsh-ps-settings-evolution-skill-mode',
        className: 'dsh-ps-select',
        value: evolutionSettings.skillMode,
        disabled: saving,
        onChange: function (event) { changeEvolutionSkillMode(event.target.value) },
      }, [
        h('option', { key: 'off', value: 'off' }, t('skillModeOffLabel')),
        h('option', { key: 'ask', value: 'ask' }, t('skillModeAsk')),
        h('option', { key: 'auto', value: 'auto' }, t('skillModeAuto')),
      ]))

      const evolutionDirField = h(Field, {
        key: 'evolution-dir',
        label: t('evolutionDir'),
        htmlFor: 'dsh-ps-settings-evolution-dir',
        hint: t('evolutionDirHint'),
      },
      h('div', { className: 'dsh-ps-dir-row' },
        h('input', {
          id: 'dsh-ps-settings-evolution-dir',
          className: 'dsh-ps-input',
          type: 'text',
          value: draftEvolutionDir,
          placeholder: t('fieldCwdPlaceholder'),
          spellCheck: false,
          disabled: saving,
          onChange: function (event) { setDraftEvolutionDir(event.target.value) },
          onBlur: function (event) { commitEvolutionDir(event.target.value) },
          onKeyDown: function (event) {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitEvolutionDir(event.currentTarget.value)
            }
          },
        }),
        h('button', {
          type: 'button',
          className: 'dsh-ps-btn',
          disabled: saving || pickingEvolutionDir,
          'aria-label': t('chooseDirectory'),
          title: t('chooseDirectory'),
          onClick: pickEvolutionDirectory,
        }, pickingEvolutionDir ? h(Spinner) : h(IconFolder, { size: 15 }))))

      const evolutionStatusRow = h('div', {
        key: 'evolution-status',
        className: 'dsh-ps-settings-status dsh-ps-settings-span-2',
      },
      h('span', { className: 'dsh-ps-field-label' }, t('evolutionLast')),
      h('div', { className: 'dsh-ps-settings-status-line' },
        h('span', { className: 'dsh-ps-report-status-chip', 'data-tone': evolutionStatusToneValue },
          evolutionBusy ? h(Spinner) : null,
          h('span', null, evolutionBusy ? t('evolutionGenerating') : evolutionStatusLabel)),
        h('span', { className: 'dsh-ps-settings-status-date' }, evolutionMetaText),
        h('span', { className: 'dsh-ps-settings-status-grow' }),
        h('button', {
          type: 'button',
          className: 'dsh-ps-btn dsh-ps-btn-sm',
          disabled: saving || evolutionBusy,
          onClick: generateEvolutionNow,
        }, evolutionBusy ? h(Spinner) : h(IconPlay, { size: 12 }), h('span', null, t('evolutionGenerateNow')))),
      evolutionSettings.lastError
        ? h('div', { className: 'dsh-ps-field-error' }, t('retrospectiveError') + ' — ' + evolutionSettings.lastError)
        : null)

      const evolutionSection = section('evolution', IconSpark, t('evolutionSection'), t('evolutionSectionSub'), [
        h('div', { key: 'evolution-enable', className: 'dsh-ps-settings-row dsh-ps-settings-span-2' },
          h(Switch, {
            checked: evolutionSettings.enabled === true,
            disabled: saving,
            label: t('evolutionEnable'),
            onChange: toggleEvolutionEnabled,
          }),
          h('div', { className: 'dsh-ps-settings-row-text' },
            h('span', { className: 'dsh-ps-settings-row-label' }, t('evolutionEnable')),
            h('p', { className: 'dsh-ps-settings-row-hint' }, t('evolutionEnableHint')))),
        evolutionIntervalField,
        evolutionSettings.interval === 'weekly' ? evolutionWeekdayField : null,
        evolutionTimeField,
        h('div', { key: 'evolution-skill-mode-wrap', className: 'dsh-ps-settings-span-2' }, evolutionSkillModeField),
        h('div', { key: 'evolution-dir-wrap', className: 'dsh-ps-settings-span-2' }, evolutionDirField),
        evolutionStatusRow,
      ])

      const backupItems = backups.items.slice(0, MAX_BACKUP_ROWS)
      let backupSummaryText = t('backupEmpty')
      if (backups.phase === 'loading' && backups.items.length === 0) backupSummaryText = t('backupLoading')
      else if (backups.items.length > 0) {
        backupSummaryText = t('backupSummary', {
          count: backups.items.length,
          time: backups.latest ? formatRelativeTime(t, backups.latest.savedAt, Date.now()) : '—',
          tasks: backups.latest ? backups.latest.taskCount : 0,
        })
      }
      const backupRows = []
      for (let i = 0; i < backupItems.length; i += 1) {
        const item = backupItems[i]
        const fullTime = formatFullTime(item.savedAt)
        const confirming = confirmRestoreName === item.name
        const restoring = restoringName === item.name
        const rowActions = confirming
          ? [
            h('span', { key: 'prompt', className: 'dsh-ps-backup-confirm-prompt' }, t('backupConfirmPrompt')),
            h('button', {
              key: 'confirm',
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-danger',
              disabled: restoringName !== null,
              'aria-label': t('backupRestoreAria', { time: fullTime }),
              onClick: function () { restoreBackup(item.name) },
            }, restoring ? h(Spinner) : h(IconCheck, { size: 12 }), h('span', null, restoring ? t('backupRestoring') : t('backupRestoreConfirm'))),
            h('button', {
              key: 'cancel',
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-ghost',
              disabled: restoringName !== null,
              onClick: function () { setConfirmRestoreName(null) },
            }, h('span', null, t('backupRestoreCancel'))),
          ]
          : h('button', {
            type: 'button',
            className: 'dsh-ps-btn dsh-ps-btn-sm',
            disabled: restoringName !== null,
            'aria-label': t('backupRestoreAria', { time: fullTime }),
            title: t('backupRestoreAria', { time: fullTime }),
            onClick: function () { setConfirmRestoreName(item.name) },
          }, h(IconRefresh, { size: 12 }), h('span', null, t('backupRestore')))
        backupRows.push(h('li', { key: item.name, className: 'dsh-ps-backup-row', 'data-backup': item.name },
          h('div', { className: 'dsh-ps-backup-row-main' },
            h('span', { className: 'dsh-ps-backup-row-time', title: fullTime }, formatRelativeTime(t, item.savedAt, Date.now())),
            h('span', { className: 'dsh-ps-backup-row-meta' }, t('backupTaskCount', { count: item.taskCount }))),
          h('div', { className: 'dsh-ps-backup-row-actions' }, rowActions)))
      }

      const backupErrorBanner = backupError
        ? h(ErrorBanner, {
          error: { text: backupError },
          dismissLabel: t('dismiss'),
          onDismiss: function () { setBackupError(null) },
        })
        : null

      const backupSection = h('section', { key: 'backup', className: 'dsh-ps-settings-group' },
        h('div', { className: 'dsh-ps-settings-group-head' },
          h('span', { className: 'dsh-ps-settings-group-icon', 'aria-hidden': 'true' }, h(IconDownload, { size: 17 })),
          h('div', { className: 'dsh-ps-settings-group-titles' },
            h('h3', { className: 'dsh-ps-settings-group-title' }, t('settingsSectionBackup')),
            h('p', { className: 'dsh-ps-settings-group-sub' }, t('backupSub')))),
        h('div', { className: 'dsh-ps-backup', 'aria-busy': restoringName !== null ? 'true' : 'false' },
          h('div', { className: 'dsh-ps-backup-summary' },
            h('span', { className: 'dsh-ps-backup-summary-text', 'data-phase': backups.phase }, backupSummaryText),
            h('button', {
              type: 'button',
              className: 'dsh-ps-backup-refresh',
              disabled: backupsRefreshing || restoringName !== null,
              'aria-label': t('backupRefreshAria'),
              title: t('backupRefreshAria'),
              onClick: function () { loadBackups(false) },
            }, backupsRefreshing ? h(Spinner) : h(IconRefresh, { size: 12 }),
            h('span', null, backupsRefreshing ? t('backupRefreshing') : t('backupRefresh')))),
          backupErrorBanner,
          backups.phase === 'loading' && backups.items.length === 0
            ? h('div', { className: 'dsh-ps-backup-state', role: 'status' }, h(Spinner), h('span', null, t('backupLoading')))
            : (backupItems.length === 0
              ? h('div', { className: 'dsh-ps-backup-state', role: 'status' }, h('span', null, t('backupEmpty')))
              : h('ul', { className: 'dsh-ps-backup-list', 'aria-label': t('settingsSectionBackup') }, backupRows)),
          confirmRestoreName !== null
            ? h('div', { className: 'dsh-ps-backup-warning', role: 'alert' },
              h(IconAlert, { size: 13, className: 'dsh-ps-backup-warning-icon' }),
              h('span', null, t('backupRestoreWarning')))
            : null))

      function getWebhook() {
        return settings && settings.webhook ? coerceWebhookSettings(settings.webhook, null) : defaultWebhookSettings()
      }

      const webhook = getWebhook()
      const webhookEnabled = webhook.enabled === true
      // Only in-flight saves/tests gate the controls: the enable switch itself
      // must not lock configuration editing (otherwise there is no way to fill
      // in a URL before turning notifications on).
      const webhookControlsDisabled = webhookSaving || webhookTesting
      const webhookStatusText = webhook.lastStatus === 'ok'
        ? t('webhookStatusOk')
        : (webhook.lastStatus === 'failed' ? t('webhookStatusFailed') : '')
      const webhookLastLine = webhookStatusText === '' || !webhook.lastAt
        ? t('webhookLastLineIdle')
        : t('webhookLastLine', {
          status: webhookStatusText,
          time: formatRelativeTime(t, webhook.lastAt, Date.now()),
          event: webhookEventLabel(t, webhook.lastEvent),
        })
      const webhookLastError = webhook.lastStatus === 'failed' && webhook.lastError ? webhook.lastError : ''
      const webhookFormatOptions = [
        h('option', { key: 'generic', value: 'generic' }, t('webhookFormatGeneric')),
        h('option', { key: 'feishu', value: 'feishu' }, t('webhookFormatFeishu')),
        h('option', { key: 'wecom', value: 'wecom' }, t('webhookFormatWecom')),
        h('option', { key: 'dingtalk', value: 'dingtalk' }, t('webhookFormatDingtalk')),
        h('option', { key: 'slack', value: 'slack' }, t('webhookFormatSlack')),
      ]
      const webhookEventRows = []
      for (let i = 0; i < WEBHOOK_EVENT_KEYS.length; i += 1) {
        const eventKey = WEBHOOK_EVENT_KEYS[i]
        const eventLabel = webhookEventLabel(t, eventKey)
        webhookEventRows.push(h('div', {
          key: eventKey,
          className: 'dsh-ps-webhook-event',
          'data-event': eventKey,
        },
        h('span', { className: 'dsh-ps-webhook-event-label' }, eventLabel),
        h(Switch, {
          checked: webhook.events[eventKey] !== false,
          disabled: webhookControlsDisabled,
          label: eventLabel,
          onChange: function () { toggleWebhookEvent(eventKey) },
        })))
      }

      const webhookUrlField = h(Field, { key: 'webhook-url', label: t('webhookUrl'), htmlFor: 'dsh-ps-settings-webhook-url' },
        h('input', {
          id: 'dsh-ps-settings-webhook-url',
          className: 'dsh-ps-input',
          type: 'url',
          value: draftWebhookUrl,
          placeholder: t('webhookUrlPlaceholder'),
          spellCheck: false,
          autoComplete: 'off',
          ref: webhookUrlRef,
          disabled: webhookSaving || webhookTesting,
          'aria-invalid': webhookError ? 'true' : 'false',
          onFocus: function () { webhookUrlFocusedRef.current = true },
          onChange: function (event) { setDraftWebhookUrl(event.target.value) },
          onBlur: function (event) {
            webhookUrlFocusedRef.current = false
            commitWebhookUrl(event.target.value)
          },
          onKeyDown: function (event) {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitWebhookUrl(event.currentTarget.value)
              try { event.currentTarget.blur() } catch (error) { /* optional */ }
            }
          },
        }))

      const webhookFormatField = h(Field, { key: 'webhook-format', label: t('webhookFormat'), htmlFor: 'dsh-ps-settings-webhook-format', hint: t('webhookFormatHint') },
        h('select', {
          id: 'dsh-ps-settings-webhook-format',
          className: 'dsh-ps-select',
          value: webhook.format,
          disabled: webhookControlsDisabled,
          onChange: function (event) { changeWebhookFormat(event.target.value) },
        }, webhookFormatOptions))

      const webhookSection = section('webhook', IconSend, t('settingsSectionWebhook'), t('webhookSub'), [
        h('div', { key: 'webhook-enable', className: 'dsh-ps-settings-row dsh-ps-settings-span-2' },
          h(Switch, {
            checked: webhookEnabled,
            disabled: webhookSaving || webhookTesting,
            label: t('webhookEnableLabel'),
            onChange: toggleWebhookEnabled,
          }),
          h('div', { className: 'dsh-ps-settings-row-text' },
            h('span', { className: 'dsh-ps-settings-row-label' }, t('webhookEnableLabel')),
            h('p', { className: 'dsh-ps-settings-row-hint' }, t('webhookEnableHint')))),
        h('div', { key: 'webhook-url-wrap', className: 'dsh-ps-settings-span-2' }, webhookUrlField),
        webhookFormatField,
        h('div', { key: 'webhook-events', className: 'dsh-ps-settings-span-2 dsh-ps-webhook-events-wrap' },
          h('span', { className: 'dsh-ps-field-label' }, t('webhookEvents')),
          h('div', { className: 'dsh-ps-webhook-events' }, webhookEventRows)),
        h('div', { key: 'webhook-actions', className: 'dsh-ps-settings-span-2 dsh-ps-webhook-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-ps-btn dsh-ps-btn-sm',
            disabled: webhookControlsDisabled || !isValidWebhookUrl(draftWebhookUrl),
            title: isValidWebhookUrl(draftWebhookUrl) ? undefined : t('webhookTestHint'),
            'aria-label': isValidWebhookUrl(draftWebhookUrl) ? t('webhookTest') : t('webhookTest') + ' — ' + t('webhookTestHint'),
            onClick: sendWebhookTest,
          }, webhookTesting ? h(Spinner) : h(IconSend, { size: 13 }),
          h('span', null, webhookTesting ? t('webhookTesting') : t('webhookTest'))),
          h('span', { className: 'dsh-ps-settings-status-grow' }),
          h('span', { className: 'dsh-ps-webhook-status', role: 'status' }, webhookLastLine)),
        webhookError || webhookLastError
          ? h('div', { key: 'webhook-error', className: 'dsh-ps-field-error dsh-ps-settings-span-2', role: 'alert' }, webhookError || webhookLastError)
          : null,
        webhookNotice
          ? h('div', { key: 'webhook-notice', className: 'dsh-ps-webhook-notice dsh-ps-settings-span-2', role: 'status' }, webhookNotice)
          : null,
      ])

      return h('div', { className: 'dsh-ps-dialog-layer' },
        h('div', { className: 'dsh-ps-dialog-mask', 'aria-hidden': 'true', onClick: props.onClose }),
        h('div', {
          className: 'dsh-ps-dialog dsh-ps-settings-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'dsh-ps-settings-title',
          'aria-busy': saving ? 'true' : 'false',
          ref: dialogRef,
          tabIndex: -1,
        },
        h('div', { className: 'dsh-ps-dialog-head' },
          h('div', { className: 'dsh-ps-dialog-titles' },
            h('h2', { className: 'dsh-ps-dialog-title', id: 'dsh-ps-settings-title' }, t('settingsTitle')),
            h('p', { className: 'dsh-ps-dialog-sub' }, t('settingsSub'))),
          h(IconButton, { label: t('close'), title: t('close'), onClick: props.onClose }, h(IconClose, { size: 16 }))),
        h('div', { className: 'dsh-ps-dialog-body' },
          saveError ? h(ErrorBanner, {
            error: { text: saveError },
            dismissLabel: t('dismiss'),
            onDismiss: function () { setSaveError(null) },
          }) : null,
          section('execution', IconSliders, t('settingsSectionExecution'), t('settingsExecutionSub'), [
            concurrencyField, modelField, effortField, autoStartField,
          ]),
          section('notify', IconBell, t('settingsSectionNotify'), t('settingsNotifySub'), [notifyRow]),
          webhookSection,
          section('report', IconFileText, t('settingsSectionReport'), t('settingsReportSub'), [
            reportEnableRow,
            reportTimeField,
            h('div', { key: 'report-dir-wrap', className: 'dsh-ps-settings-span-2' }, reportDirField),
            reportStatusRow,
          ]),
          briefSection,
          evolutionSection,
          backupSection),
        h('div', { className: 'dsh-ps-dialog-foot' },
          h('span', { className: 'dsh-ps-settings-save-state', 'data-tone': saveError ? 'error' : undefined, role: 'status' },
            saving ? h(Spinner) : null,
            h('span', null, saving ? t('saving') : t('settingsAutoSave'))),
          h('span', { className: 'dsh-ps-dialog-foot-grow' }),
          h('button', {
            type: 'button',
            ref: doneRef,
            className: 'dsh-ps-btn dsh-ps-btn-primary',
            onClick: props.onClose,
          }, h(IconCheck, { size: 15 }), h('span', null, t('settingsDone'))))))
    }

    // ------------------------------------------------------------------ edit dialog

    function EditDialog(props) {
      const ctx = props.ctx
      const store = props.store
      const t = props.t
      const task = props.task
      const onClose = props.onClose
      const dialogRef = React.useRef(null)
      const fieldRef = React.useRef(null)
      const initial = task || {}
      const [title, setTitle] = React.useState(initial.title || '')
      const [prompt, setPrompt] = React.useState(initial.prompt || '')
      const [cwd, setCwd] = React.useState(initial.cwd || '')
      const [chainFrom, setChainFrom] = React.useState(initial.chainFrom || '')
      const [priority, setPriority] = React.useState(normalizePriority(initial.priority))
      const [submitting, setSubmitting] = React.useState(false)
      const [picking, setPicking] = React.useState(false)
      const [fieldError, setFieldError] = React.useState(null)
      const [inlineError, setInlineError] = React.useState(null)
      const canEdit = task && task.status !== 'running' && task.source !== 'session'

      useDialogA11y(dialogRef, function () { if (!submitting) onClose() }, true, fieldRef)

      const candidates = []
      const tasks = Array.isArray(props.tasks) ? props.tasks : []
      for (let i = 0; i < tasks.length; i += 1) {
        const candidate = tasks[i]
        if (candidate.id === task.id) continue
        if (candidate.source !== 'queue') continue
        if (candidate.status === 'failed' || candidate.status === 'cancelled') continue
        candidates.push(candidate)
      }
      const knownChain = chainFrom !== '' && candidates.some(function (item) { return item.id === chainFrom })
      const chainOptions = [h('option', { key: 'none', value: '' }, t('chainFromNone'))]
      for (let i = 0; i < candidates.length; i += 1) {
        const candidate = candidates[i]
        chainOptions.push(h('option', { key: candidate.id, value: candidate.id }, candidate.title))
      }
      if (chainFrom !== '' && !knownChain) {
        const fallbackTitle = props.chainTitle || chainFrom
        chainOptions.push(h('option', { key: 'fallback', value: chainFrom }, fallbackTitle))
      }
      const priorityOptions = []
      for (let i = 0; i < PRIORITY_VALUES.length; i += 1) {
        const value = PRIORITY_VALUES[i]
        priorityOptions.push(h('option', { key: value, value: value }, priorityLabel(t, value)))
      }

      function pickDirectory() {
        if (picking || submitting) return
        const service = ctx && ctx.uiWorkspace ? ctx.uiWorkspace : null
        if (!service || typeof service.pickDirectory !== 'function') {
          setInlineError(t('pickFailed'))
          return
        }
        setPicking(true)
        let attempt = null
        try { attempt = service.pickDirectory() } catch (error) { attempt = Promise.reject(error) }
        Promise.resolve(attempt).then(function (picked) {
          if (typeof picked === 'string' && picked.trim() !== '') {
            setCwd(picked)
            setFieldError(null)
          }
          setPicking(false)
        }, function (error) {
          setPicking(false)
          setInlineError(t('pickFailed') + ' — ' + (error && error.message ? error.message : t('unknownError')))
        })
      }

      function submit() {
        if (submitting || picking || !canEdit) return
        const titleText = title.trim()
        const promptText = prompt.trim()
        const cwdText = cwd.trim()
        if (titleText === '' || promptText === '' || cwdText === '') {
          setFieldError(t('required'))
          return
        }
        if (titleText.length > MAX_TITLE_LENGTH) {
          setFieldError(t('titleTooLong', { max: MAX_TITLE_LENGTH }))
          return
        }
        if (!isAbsolutePath(cwdText)) {
          setFieldError(t('cwdInvalid'))
          return
        }
        setFieldError(null)
        setInlineError(null)
        setSubmitting(true)
        const body = {
          id: task.id,
          title: titleText,
          prompt: promptText,
          cwd: cwdText,
          priority: priority,
          chainFrom: chainFrom === '' ? null : chainFrom,
        }
        store.updateTask(body).then(function (result) {
          setSubmitting(false)
          if (result.ok) {
            if (typeof props.addToast === 'function') props.addToast(t('editSuccess'), 'success')
            if (typeof props.onSaved === 'function') props.onSaved()
            onClose()
          } else {
            setInlineError(result.error || t('actionFailed'))
          }
        })
      }

      function onDialogKeyDown(event) {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          submit()
        }
      }

      return h('div', { className: 'dsh-ps-dialog-layer' },
        h('div', { className: 'dsh-ps-dialog-mask', 'aria-hidden': 'true', onClick: function () { if (!submitting) onClose() } }),
        h('div', {
          className: 'dsh-ps-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'dsh-ps-edit-title',
          'aria-busy': submitting ? 'true' : 'false',
          ref: dialogRef,
          tabIndex: -1,
          onKeyDown: onDialogKeyDown,
        },
        h('div', { className: 'dsh-ps-dialog-head' },
          h('div', { className: 'dsh-ps-dialog-titles' },
            h('h2', { className: 'dsh-ps-dialog-title', id: 'dsh-ps-edit-title' }, t('editTitle')),
            h('p', { className: 'dsh-ps-dialog-sub' }, t('editSubtitle'))),
          h(IconButton, { label: t('close'), title: t('close'), onClick: function () { if (!submitting) onClose() }, disabled: submitting }, h(IconClose, { size: 16 }))),
        h('div', { className: 'dsh-ps-dialog-body' },
          inlineError ? h(ErrorBanner, { error: { text: inlineError } }) : null,
          !canEdit ? h('div', { className: 'dsh-ps-hint-box', role: 'alert' }, h(IconAlert, { size: 14 }), h('span', null, t('editRunning'))) : null,
          h(Field, { label: t('fieldTitle'), htmlFor: 'dsh-ps-edit-task-title' },
            h('input', {
              id: 'dsh-ps-edit-task-title',
              ref: fieldRef,
              className: 'dsh-ps-input',
              type: 'text',
              value: title,
              maxLength: MAX_TITLE_LENGTH,
              placeholder: t('fieldTitlePlaceholder'),
              spellCheck: false,
              disabled: submitting || !canEdit,
              onChange: function (event) { setTitle(event.target.value) },
            })),
          h(Field, { label: t('fieldPrompt'), htmlFor: 'dsh-ps-edit-task-prompt' },
            h('textarea', {
              id: 'dsh-ps-edit-task-prompt',
              className: 'dsh-ps-textarea',
              value: prompt,
              rows: 5,
              placeholder: t('fieldPromptPlaceholder'),
              spellCheck: false,
              disabled: submitting || !canEdit,
              onChange: function (event) { setPrompt(event.target.value) },
            })),
          h(Field, { label: t('fieldCwd'), htmlFor: 'dsh-ps-edit-task-cwd' },
            h('div', { className: 'dsh-ps-dir-row' },
              h('input', {
                id: 'dsh-ps-edit-task-cwd',
                className: 'dsh-ps-input',
                type: 'text',
                value: cwd,
                placeholder: t('fieldCwdPlaceholder'),
                spellCheck: false,
                disabled: submitting || !canEdit,
                onChange: function (event) { setCwd(event.target.value) },
              }),
              h('button', {
                type: 'button',
                className: 'dsh-ps-btn',
                disabled: submitting || picking || !canEdit,
                onClick: pickDirectory,
              }, picking ? h(Spinner) : h(IconFolder, { size: 15 }),
              h('span', null, picking ? t('choosing') : t('chooseDirectory'))))),
          h('div', { className: 'dsh-ps-two-col' },
            h(Field, { label: t('fieldChain'), htmlFor: 'dsh-ps-edit-task-chain' },
              h('select', {
                id: 'dsh-ps-edit-task-chain',
                className: 'dsh-ps-select',
                value: chainFrom,
                disabled: submitting || !canEdit,
                onChange: function (event) { setChainFrom(event.target.value) },
              }, chainOptions)),
            h(Field, { label: t('priorityLabel'), htmlFor: 'dsh-ps-edit-task-priority', hint: t('fieldStatusHint') },
              h('select', {
                id: 'dsh-ps-edit-task-priority',
                className: 'dsh-ps-select',
                value: priority,
                disabled: submitting || !canEdit,
                onChange: function (event) { setPriority(normalizePriority(event.target.value)) },
              }, priorityOptions))),
          fieldError ? h('div', { className: 'dsh-ps-field-error', role: 'alert' }, fieldError) : null),
        h('div', { className: 'dsh-ps-dialog-foot' },
          h('span', { className: 'dsh-ps-dialog-foot-grow' }),
          h('button', { type: 'button', className: 'dsh-ps-btn', disabled: submitting, onClick: onClose }, t('cancel')),
          h('button', {
            type: 'button',
            className: 'dsh-ps-btn dsh-ps-btn-primary',
            disabled: submitting || picking || !canEdit,
            onClick: submit,
          }, submitting ? h(Spinner) : h(IconCheck, { size: 15 }),
          h('span', null, submitting ? t('editSubmitting') : t('editSubmit'))))))
    }

    // ------------------------------------------------------------------ publish dialog

    function parseBatchText(text) {
      const lines = String(text || '').split(/\r?\n/)
      const items = []
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim()
        if (line === '') continue
        const separator = line.indexOf('|')
        if (separator >= 0) {
          const title = line.slice(0, separator).trim()
          const prompt = line.slice(separator + 1).trim()
          if (title === '' && prompt === '') continue
          const safeTitle = title === '' ? prompt.slice(0, MAX_TITLE_LENGTH) : title.slice(0, MAX_TITLE_LENGTH)
          items.push({ title: safeTitle, prompt: prompt === '' ? title : prompt })
        } else {
          items.push({ title: line.slice(0, MAX_TITLE_LENGTH), prompt: line })
        }
      }
      return items
    }

    function PublishDialog(props) {
      const ctx = props.ctx
      const store = props.store
      const t = props.t
      const onClose = props.onClose
      const dialogRef = React.useRef(null)
      const fieldRef = React.useRef(null)
      const [mode, setMode] = React.useState(props.initialMode === 'batch' ? 'batch' : 'single')
      const [title, setTitle] = React.useState('')
      const [prompt, setPrompt] = React.useState('')
      const [batchText, setBatchText] = React.useState('')
      const [cwd, setCwd] = React.useState(typeof props.initialCwd === 'string' ? props.initialCwd : '')
      const [chain, setChain] = React.useState(false)
      const [statusTarget, setStatusTarget] = React.useState('idea')
      const [priority, setPriority] = React.useState(DEFAULT_PRIORITY)
      const [submitting, setSubmitting] = React.useState(false)
      const [picking, setPicking] = React.useState(false)
      const [fieldError, setFieldError] = React.useState(null)
      const [inlineError, setInlineError] = React.useState(null)

      const chainCandidate = props.chainCandidate && typeof props.chainCandidate === 'object' ? props.chainCandidate : null
      const chainAvailable = mode === 'batch' || chainCandidate !== null
      const batchItems = parseBatchText(batchText)

      function requestClose() {
        if (submitting) return
        onClose()
      }

      useDialogA11y(dialogRef, requestClose, true, fieldRef)

      function switchMode(next) {
        if (submitting || next === mode) return
        setMode(next)
        setFieldError(null)
        setInlineError(null)
      }

      function pickDirectory() {
        if (picking || submitting) return
        const service = ctx && ctx.uiWorkspace ? ctx.uiWorkspace : null
        if (!service || typeof service.pickDirectory !== 'function') {
          setInlineError(t('pickFailed'))
          return
        }
        setPicking(true)
        let attempt = null
        try { attempt = service.pickDirectory() } catch (error) { attempt = Promise.reject(error) }
        Promise.resolve(attempt).then(function (picked) {
          if (typeof picked === 'string' && picked.trim() !== '') {
            setCwd(picked)
            setFieldError(null)
          }
          setPicking(false)
        }, function (error) {
          setPicking(false)
          setInlineError(t('pickFailed') + ' — ' + (error && error.message ? error.message : t('unknownError')))
        })
      }

      function submit() {
        if (submitting || picking) return
        const cwdText = cwd.trim()
        if (mode === 'single') {
          const titleText = title.trim()
          const promptText = prompt.trim()
          if (titleText === '' || promptText === '' || cwdText === '') {
            setFieldError(t('required'))
            return
          }
          if (titleText.length > MAX_TITLE_LENGTH) {
            setFieldError(t('titleTooLong', { max: MAX_TITLE_LENGTH }))
            return
          }
          if (!isAbsolutePath(cwdText)) {
            setFieldError(t('cwdInvalid'))
            return
          }
          setFieldError(null)
          setInlineError(null)
          setSubmitting(true)
          const body = { title: titleText, prompt: promptText, cwd: cwdText, status: statusTarget, priority: priority }
          if (chain && chainCandidate) body.chainFrom = chainCandidate.id
          store.publish(body).then(function (result) {
            setSubmitting(false)
            if (result.ok) {
              if (typeof props.onPublished === 'function') props.onPublished(cwdText, statusTarget)
              if (typeof props.addToast === 'function') {
                props.addToast(statusTarget === 'idea' ? t('publishIdeaSuccessOne') : t('publishSuccessOne'), 'success')
              }
              onClose()
            } else {
              setInlineError(result.error || t('publishFailed'))
            }
          })
          return
        }
        if (cwdText === '') {
          setFieldError(t('required'))
          return
        }
        if (!isAbsolutePath(cwdText)) {
          setFieldError(t('cwdInvalid'))
          return
        }
        if (batchItems.length === 0) {
          setFieldError(t('batchRequired'))
          return
        }
        if (batchItems.length > MAX_BATCH_ITEMS) {
          setFieldError(t('batchOverflow', { max: MAX_BATCH_ITEMS }))
          return
        }
        setFieldError(null)
        setInlineError(null)
        setSubmitting(true)
        store.publishBatch({ cwd: cwdText, chain: chain === true, status: statusTarget, priority: priority, items: batchItems }).then(function (result) {
          setSubmitting(false)
          if (result.ok) {
            const created = result.data && Array.isArray(result.data.created) ? result.data.created.length : batchItems.length
            if (typeof props.onPublished === 'function') props.onPublished(cwdText, statusTarget)
            if (typeof props.addToast === 'function') {
              props.addToast(statusTarget === 'idea' ? t('publishIdeaSuccess', { count: created }) : t('publishSuccess', { count: created }), 'success')
            }
            onClose()
          } else {
            setInlineError(result.error || t('publishFailed'))
          }
        })
      }

      function onDialogKeyDown(event) {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          submit()
        }
      }

      const modeButtons = [
        h('button', {
          key: 'single',
          type: 'button',
          className: 'dsh-ps-segment',
          'aria-pressed': mode === 'single' ? 'true' : 'false',
          disabled: submitting,
          onClick: function () { switchMode('single') },
        }, t('modeSingle')),
        h('button', {
          key: 'batch',
          type: 'button',
          className: 'dsh-ps-segment',
          'aria-pressed': mode === 'batch' ? 'true' : 'false',
          disabled: submitting,
          onClick: function () { switchMode('batch') },
        }, t('modeBatch')),
      ]

      const cwdField = h(Field, {
        key: 'cwd',
        label: t('fieldCwd'),
        htmlFor: mode === 'batch' ? 'dsh-ps-publish-batch-cwd' : 'dsh-ps-publish-cwd-input',
      },
      h('div', { className: 'dsh-ps-dir-row' },
        h('input', {
          id: mode === 'batch' ? 'dsh-ps-publish-batch-cwd' : 'dsh-ps-publish-cwd-input',
          className: 'dsh-ps-input',
          type: 'text',
          value: cwd,
          placeholder: t('fieldCwdPlaceholder'),
          disabled: submitting,
          spellCheck: false,
          onChange: function (event) { setCwd(event.target.value) },
        }),
        h('button', {
          type: 'button',
          className: 'dsh-ps-btn',
          disabled: submitting || picking,
          onClick: pickDirectory,
        }, picking ? h(Spinner) : h(IconFolder, { size: 15 }),
        h('span', null, picking ? t('choosing') : t('chooseDirectory')))))

      let modeContent = null
      if (mode === 'single') {
        modeContent = h(React.Fragment, null,
          h(Field, { key: 'title', label: t('fieldTitle'), htmlFor: 'dsh-ps-publish-title-input' },
            h('input', {
              id: 'dsh-ps-publish-title-input',
              ref: fieldRef,
              className: 'dsh-ps-input',
              type: 'text',
              value: title,
              maxLength: MAX_TITLE_LENGTH,
              placeholder: t('fieldTitlePlaceholder'),
              spellCheck: false,
              disabled: submitting,
              onChange: function (event) { setTitle(event.target.value) },
            })),
          h(Field, { key: 'prompt', label: t('fieldPrompt'), htmlFor: 'dsh-ps-publish-prompt-input' },
            h('textarea', {
              id: 'dsh-ps-publish-prompt-input',
              className: 'dsh-ps-textarea',
              value: prompt,
              placeholder: t('fieldPromptPlaceholder'),
              rows: 5,
              spellCheck: false,
              disabled: submitting,
              onChange: function (event) { setPrompt(event.target.value) },
            })),
          cwdField)
      } else {
        modeContent = h(React.Fragment, null,
          cwdField,
          h(Field, { key: 'batch', label: t('batchLabel'), htmlFor: 'dsh-ps-publish-batch-input' },
            h('div', { className: 'dsh-ps-batch-bar' },
              h('span', { className: 'dsh-ps-field-hint' }, t('batchHint')),
              h('span', { className: 'dsh-ps-batch-count' }, t('batchCount', { count: batchItems.length }))),
            h('textarea', {
              id: 'dsh-ps-publish-batch-input',
              ref: fieldRef,
              className: 'dsh-ps-textarea dsh-ps-batch-textarea',
              value: batchText,
              placeholder: t('batchPlaceholder'),
              rows: 7,
              disabled: submitting,
              spellCheck: false,
              onChange: function (event) { setBatchText(event.target.value) },
            })))
      }

      const priorityOptions = []
      for (let i = 0; i < PRIORITY_VALUES.length; i += 1) {
        const value = PRIORITY_VALUES[i]
        priorityOptions.push(h('option', { key: value, value: value }, priorityLabel(t, value)))
      }

      const targetControls = h('div', { className: 'dsh-ps-two-col' },
        h(Field, { label: t('fieldStatus'), htmlFor: 'dsh-ps-publish-target', hint: t('fieldStatusHint') },
          h('select', {
            id: 'dsh-ps-publish-target',
            className: 'dsh-ps-select',
            value: statusTarget,
            disabled: submitting,
            onChange: function (event) { setStatusTarget(event.target.value === 'pending' ? 'pending' : 'idea') },
          },
          h('option', { value: 'idea' }, t('statusOptionIdea')),
          h('option', { value: 'pending' }, t('statusOptionPending')))),
        h(Field, { label: t('priorityLabel'), htmlFor: 'dsh-ps-publish-priority' },
          h('select', {
            id: 'dsh-ps-publish-priority',
            className: 'dsh-ps-select',
            value: priority,
            disabled: submitting,
            onChange: function (event) { setPriority(normalizePriority(event.target.value)) },
          }, priorityOptions)))

      const chainHint = mode === 'batch'
        ? t('chainHintBatch')
        : (chainCandidate ? t('chainHint', { title: chainCandidate.title }) : t('chainHintNone'))

      return h('div', { className: 'dsh-ps-dialog-layer' },
        h('div', {
          className: 'dsh-ps-dialog-mask',
          'aria-hidden': 'true',
          onClick: requestClose,
        }),
        h('div', {
          className: 'dsh-ps-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'dsh-ps-publish-title',
          'aria-busy': submitting ? 'true' : 'false',
          ref: dialogRef,
          tabIndex: -1,
          onKeyDown: onDialogKeyDown,
        },
        h('div', { className: 'dsh-ps-dialog-head' },
          h('div', { className: 'dsh-ps-dialog-titles' },
            h('h2', { className: 'dsh-ps-dialog-title', id: 'dsh-ps-publish-title' }, t('publishTitle')),
            h('p', { className: 'dsh-ps-dialog-sub' }, t('publishSubtitle'))),
          h(IconButton, { label: t('close'), title: t('close'), onClick: requestClose, disabled: submitting }, h(IconClose, { size: 16 }))),
        h('div', { className: 'dsh-ps-dialog-body' },
          inlineError ? h(ErrorBanner, { error: { text: inlineError } }) : null,
          h('div', { className: 'dsh-ps-segmented', role: 'group', 'aria-label': t('publishTitle') }, modeButtons),
          modeContent,
          targetControls,
          h('div', { className: 'dsh-ps-option' },
            h('div', { className: 'dsh-ps-option-body' },
              h('span', { className: 'dsh-ps-option-title' }, t('chainSwitch')),
              h('span', { className: 'dsh-ps-option-hint' }, chainHint)),
            h(Switch, {
              checked: chain && chainAvailable,
              disabled: submitting || !chainAvailable,
              label: t('chainSwitch'),
              onChange: function () {
                if (!chainAvailable) return
                setChain(function (value) { return !value })
              },
            })),
          fieldError ? h('div', { className: 'dsh-ps-field-error', role: 'alert' }, fieldError) : null),
        h('div', { className: 'dsh-ps-dialog-foot' },
          h('span', { className: 'dsh-ps-dialog-foot-grow' }),
          h('button', { type: 'button', className: 'dsh-ps-btn', disabled: submitting, onClick: requestClose }, t('cancel')),
          h('button', {
            type: 'button',
            className: 'dsh-ps-btn dsh-ps-btn-primary',
            disabled: submitting || picking,
            onClick: submit,
          }, submitting ? h(Spinner) : h(IconPlus, { size: 15 }),
          h('span', null, submitting ? t('submitting') : t('submit'))))))
    }

    // ------------------------------------------------------------------ detail drawer

    function TranscriptMessage(props) {
      const message = props.message
      const roleLabel = message.role === 'user' ? props.userLabel : props.assistantLabel
      const time = typeof message.time === 'number' && message.time > 0 ? ' · ' + formatTime(message.time) : ''
      return h('div', { className: 'dsh-ps-msg dsh-ps-msg-' + message.role },
        h('span', { className: 'dsh-ps-msg-role' }, roleLabel + time),
        h('div', { className: 'dsh-ps-msg-bubble' }, message.text))
    }

    function DetailDrawer(props) {
      const t = props.t
      const store = props.store
      const task = props.task
      const onClose = props.onClose
      const sessionId = task.sessionId !== '' ? task.sessionId : null
      const isSession = task.source === 'session'
      const dialogRef = React.useRef(null)
      const bodyRef = React.useRef(null)
      const closeBtnRef = React.useRef(null)
      const composerRef = React.useRef(null)
      const pinnedRef = React.useRef(false)
      const reloadRef = React.useRef(null)
      const transcriptFailureRef = React.useRef(false)
      const [transcript, setTranscript] = React.useState({
        phase: sessionId ? 'loading' : 'ready',
        messages: [],
        running: false,
        error: null,
      })
      const [draft, setDraft] = React.useState('')
      React.useEffect(function () {
        if (props.focusComposer !== true) return undefined
        const timer = setTimeout(function () {
          const node = composerRef.current
          if (!node || typeof node.focus !== 'function') return
          try { node.focus() } catch (error) { /* focus is progressive enhancement */ }
        }, 80)
        return function () { clearTimeout(timer) }
      }, [props.focusComposer])
      const [sending, setSending] = React.useState(false)
      const [chatError, setChatError] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [confirmDelete, setConfirmDelete] = React.useState(false)
      const now = useNow(task.status === 'running' || task.status === 'blocked')
      useDialogA11y(dialogRef, onClose, true, closeBtnRef)

      React.useEffect(function () {
        let alive = true
        let abort = null
        let timer = null
        if (!sessionId) {
          setTranscript({ phase: 'ready', messages: [], running: false, error: null })
          reloadRef.current = null
          return function () { alive = false }
        }
        function load() {
          if (!alive) return
          let controller = null
          try {
            if (typeof AbortController === 'function') controller = new AbortController()
          } catch (error) {
            controller = null
          }
          const previous = abort
          abort = controller
          if (previous && typeof previous.abort === 'function') {
            try { previous.abort() } catch (error) { /* already settled */ }
          }
          const options = controller ? { signal: controller.signal } : undefined
          store.request('/transcript?sessionId=' + encodeURIComponent(sessionId), options).then(function (payload) {
            if (!alive) return
            transcriptFailureRef.current = false
            const raw = Array.isArray(payload.messages) ? payload.messages : []
            const messages = []
            for (let i = 0; i < raw.length; i += 1) {
              const item = raw[i]
              if (!item || typeof item.text !== 'string') continue
              const role = item.role === 'user' ? 'user' : (item.role === 'assistant' ? 'assistant' : null)
              if (role === null) continue
              messages.push({
                id: typeof item.id === 'string' ? item.id : String(i),
                role: role,
                text: item.text,
                time: typeof item.time === 'number' ? item.time : 0,
              })
            }
            setTranscript({ phase: 'ready', messages: messages, running: payload.running === true, error: null })
          }, function (error) {
            if (!alive) return
            if (error && error.name === 'AbortError') return
            const message = error && error.message ? error.message : t('unknownError')
            setTranscript(function (previous) {
              return {
                phase: previous.phase === 'loading' ? 'ready' : previous.phase,
                messages: previous.messages,
                running: previous.running,
                error: message,
              }
            })
            if (!transcriptFailureRef.current) {
              transcriptFailureRef.current = true
              store.reportError(t('transcriptFailed') + ' — ' + message)
            }
          })
        }
        reloadRef.current = load
        setTranscript({ phase: 'loading', messages: [], running: false, error: null })
        load()
        timer = setInterval(function () {
          if (typeof document !== 'undefined' && document.hidden === true) return
          load()
        }, TRANSCRIPT_POLL_MS)
        return function () {
          alive = false
          if (timer !== null) clearInterval(timer)
          if (abort && typeof abort.abort === 'function') {
            try { abort.abort() } catch (error) { /* already settled */ }
          }
          if (reloadRef.current === load) reloadRef.current = null
        }
      }, [sessionId, store, t])

      React.useEffect(function () {
        if (!pinnedRef.current) return
        const node = bodyRef.current
        if (node) node.scrollTop = node.scrollHeight
      }, [transcript.messages, transcript.phase])

      function onBodyScroll() {
        const node = bodyRef.current
        if (!node) return
        pinnedRef.current = (node.scrollHeight - node.scrollTop - node.clientHeight) < 80
      }

      function send() {
        const text = draft.trim()
        if (text === '' || sessionId === null || sending || isSession) return
        setSending(true)
        setChatError(null)
        store.sendChat(sessionId, text).then(function (result) {
          setSending(false)
          if (!result.ok) {
            setChatError(result.error || t('chatFailed'))
            return
          }
          setDraft('')
          pinnedRef.current = true
          const revived = typeof result.revived === 'string'
            ? result.revived
            : (result.data && typeof result.data.revived === 'string' ? result.data.revived : '')
          if (revived === 'running' && typeof props.addToast === 'function') {
            props.addToast(t('chatRevivedRunning'), 'success')
          } else if (revived === 'pending' && typeof props.addToast === 'function') {
            props.addToast(t('chatRevivedPending'), 'info')
          }
          // Pull the new task status right away so board card + drawer badge
          // switch columns immediately instead of waiting for the 1.5s poll.
          if (typeof store.refresh === 'function') void store.refresh()
          if (typeof reloadRef.current === 'function') reloadRef.current()
        })
      }

      function onComposerKeyDown(event) {
        const composing = event.nativeEvent && event.nativeEvent.isComposing === true
        if (composing) return
        if (event.key !== 'Enter') return
        if (event.shiftKey) return
        event.preventDefault()
        send()
      }

      function runAction(action) {
        if (busy !== null) return
        setBusy(action)
        store.act(task.id, action).then(function (result) {
          setBusy(null)
          if (!result.ok) return
          if (action === 'delete') onClose()
          else setConfirmDelete(false)
        })
      }

      function moveTask(delta) {
        if (busy !== null || task.status !== 'pending') return
        setBusy('move')
        Promise.resolve(props.onMoveTask(task.id, delta)).then(function () { setBusy(null) })
      }

      function copyResult(answer) {
        copyTextToClipboard(answer).then(function () {
          if (typeof props.addToast === 'function') props.addToast(t('copied'), 'success')
        }, function () {
          if (typeof props.addToast === 'function') props.addToast(t('copyFailed'), 'error')
        })
      }

      const status = task.status
      const statusText = statusLabel(t, status)
      const modelText = taskModelLabel(task)
      const result = task.result
      const answer = result && result.finalAnswer ? result.finalAnswer : ''
      const usage = result && result.usage ? result.usage : null
      const turnsValue = result && result.turns > 0 ? result.turns : task.turns
      const durationMs = taskDurationMs(task, now)
      const running = transcript.running || status === 'running'
      const canRun = status === 'pending' || status === 'idea'
      const canPromote = status === 'idea'
      const canDemote = status === 'pending'
      const canEdit = status !== 'running' && !isSession
      const canRunNext = status === 'pending'
      const canRetry = isEndedStatus(status) && !isSession
      const canPause = status === 'running' || status === 'blocked'
      const canResume = status === 'paused'
      const canInterrupt = RUNNING_STATUSES.indexOf(status) >= 0 || status === 'paused'
      const chainSource = props.chainSource || null

      const metaCells = []
      metaCells.push(h(MetaCell, { key: 'priority', label: t('priorityLabel'), value: priorityLabel(t, normalizePriority(task.priority)) }))
      if (isSession) metaCells.push(h(MetaCell, { key: 'source', label: t('sourceLabel'), value: t('badgeSession') }))
      if (task.cwd !== '') {
        metaCells.push(h(MetaCell, { key: 'cwd', label: t('cwd'), value: task.cwd, title: task.cwd, mono: true, span: 2 }))
      }
      metaCells.push(h(MetaCell, { key: 'model', label: t('model'), value: modelText !== '' ? modelText : t('noModel') }))
      metaCells.push(h(MetaCell, { key: 'status', label: t('status'), value: statusText }))
      if (task.chainFrom !== '') {
        metaCells.push(h(MetaCell, { key: 'chain', label: t('chainFromLabel') },
          chainSource
            ? h('button', {
              type: 'button',
              className: 'dsh-ps-meta-link',
              onClick: function () { props.onOpenTask(chainSource.id) },
            }, h(IconChain, { size: 12 }), h('span', null, chainSource.title))
            : h('span', { className: 'dsh-ps-meta-value-code' }, task.chainFrom)))
      }
      if (task.createdAt > 0) metaCells.push(h(MetaCell, { key: 'created', label: t('createdAt'), value: formatFullTime(task.createdAt) }))
      if (task.startedAt > 0) metaCells.push(h(MetaCell, { key: 'started', label: t('startedAt'), value: formatFullTime(task.startedAt) }))
      if (task.endedAt > 0) metaCells.push(h(MetaCell, { key: 'ended', label: t('endedAt'), value: formatFullTime(task.endedAt) }))
      if (task.updatedAt > 0) metaCells.push(h(MetaCell, { key: 'updated', label: t('updatedAt'), value: formatFullTime(task.updatedAt) }))
      if (durationMs > 0) metaCells.push(h(MetaCell, { key: 'duration', label: t('duration'), value: formatDuration(durationMs) }))
      if (turnsValue > 0) metaCells.push(h(MetaCell, { key: 'turns', label: t('turns'), value: String(turnsValue) }))
      if (usage) {
        const usageText = usage.cacheReadTokens > 0
          ? t('tokensUsageCache', { input: formatNumber(usage.inputTokens), output: formatNumber(usage.outputTokens), cache: formatNumber(usage.cacheReadTokens) })
          : t('tokensUsage', { input: formatNumber(usage.inputTokens), output: formatNumber(usage.outputTokens) })
        metaCells.push(h(MetaCell, { key: 'tokens', label: t('tokens'), value: usageText, span: 2 }))
      }

      let resultBody = null
      if (answer !== '') {
        resultBody = h('pre', { className: 'dsh-ps-result-text' }, answer)
      } else if (isSession) {
        resultBody = h('div', { className: 'dsh-ps-result-placeholder' }, h('span', null, t('chatReadOnly')))
      } else if (status === 'running') {
        resultBody = h('div', { className: 'dsh-ps-result-placeholder' }, h(Spinner), h('span', null, t('resultRunning')))
      } else {
        resultBody = h('div', { className: 'dsh-ps-result-placeholder' }, h('span', null, t('resultEmpty')))
      }

      const actionButtons = []
      if (sessionId !== null) {
        actionButtons.push(h('button', {
          key: 'open',
          type: 'button',
          className: 'dsh-ps-btn dsh-ps-btn-primary',
          onClick: function () { props.onOpenSession(task) },
        }, h(IconOpenExternal, { size: 15 }), h('span', null, t('openSession'))))
      }
      if (canRun) {
        actionButtons.push(h('button', {
          key: 'run',
          type: 'button',
          className: 'dsh-ps-btn',
          disabled: busy !== null,
          onClick: function () { runAction('run') },
        }, busy === 'run' ? h(Spinner) : h(IconPlay, { size: 14 }), h('span', null, t('run'))))
      }
      if (canPromote) {
        actionButtons.push(h('button', {
          key: 'promote',
          type: 'button',
          className: 'dsh-ps-btn dsh-ps-btn-primary',
          disabled: busy !== null,
          onClick: function () { runAction('promote') },
        }, busy === 'promote' ? h(Spinner) : h(IconArrowRight, { size: 14 }), h('span', null, t('promote'))))
      }
      if (canDemote) {
        actionButtons.push(h('button', {
          key: 'demote',
          type: 'button',
          className: 'dsh-ps-btn',
          disabled: busy !== null,
          onClick: function () { runAction('demote') },
        }, busy === 'demote' ? h(Spinner) : h(IconArrowLeft, { size: 14 }), h('span', null, t('demote'))))
      }
      if (canRunNext) {
        actionButtons.push(h('button', {
          key: 'run-next',
          type: 'button',
          className: 'dsh-ps-btn',
          disabled: busy !== null,
          onClick: function () { runAction('run-next') },
        }, busy === 'run-next' ? h(Spinner) : h(IconArrowToTop, { size: 14 }), h('span', null, t('runNext'))))
        actionButtons.push(h('button', {
          key: 'move-up',
          type: 'button',
          className: 'dsh-ps-btn dsh-ps-btn-ghost',
          disabled: busy !== null,
          'aria-label': t('moveUp'),
          title: t('moveUp'),
          onClick: function () { moveTask(-1) },
        }, busy === 'move' ? h(Spinner) : h(IconChevronUp, { size: 15 }), h('span', null, t('moveUp'))))
        actionButtons.push(h('button', {
          key: 'move-down',
          type: 'button',
          className: 'dsh-ps-btn dsh-ps-btn-ghost',
          disabled: busy !== null,
          'aria-label': t('moveDown'),
          title: t('moveDown'),
          onClick: function () { moveTask(1) },
        }, busy === 'move' ? h(Spinner) : h(IconChevronDown, { size: 15 }), h('span', null, t('moveDown'))))
      }
      if (canEdit) {
        actionButtons.push(h('button', {
          key: 'edit',
          type: 'button',
          className: 'dsh-ps-btn',
          disabled: busy !== null,
          onClick: function () { props.onEdit(task) },
        }, h(IconEdit, { size: 14 }), h('span', null, t('edit'))))
      }
      if (canRetry) {
        actionButtons.push(h('button', {
          key: 'retry',
          type: 'button',
          className: 'dsh-ps-btn',
          disabled: busy !== null,
          onClick: function () { runAction('retry') },
        }, busy === 'retry' ? h(Spinner) : h(IconRetry, { size: 15 }), h('span', null, t('retry'))))
      }
      if (canPause) {
        actionButtons.push(h('button', {
          key: 'pause',
          type: 'button',
          className: 'dsh-ps-btn',
          disabled: busy !== null,
          onClick: function () { runAction('pause') },
        }, busy === 'pause' ? h(Spinner) : h(IconPause, { size: 14 }), h('span', null, t('pause'))))
      }
      if (canResume) {
        actionButtons.push(h('button', {
          key: 'resume',
          type: 'button',
          className: 'dsh-ps-btn',
          disabled: busy !== null,
          onClick: function () { runAction('resume') },
        }, busy === 'resume' ? h(Spinner) : h(IconPlay, { size: 14 }), h('span', null, t('resume'))))
      }
      if (canInterrupt) {
        actionButtons.push(h('button', {
          key: 'interrupt',
          type: 'button',
          className: 'dsh-ps-btn',
          disabled: busy !== null,
          onClick: function () { runAction('interrupt') },
        }, busy === 'interrupt' ? h(Spinner) : h(IconStop, { size: 14 }), h('span', null, t('interrupt'))))
      }
      actionButtons.push(h('button', {
        key: 'delete',
        type: 'button',
        className: 'dsh-ps-btn ' + (confirmDelete ? 'dsh-ps-btn-danger' : 'dsh-ps-btn-ghost'),
        disabled: busy !== null,
        onClick: function () {
          if (!confirmDelete) {
            setConfirmDelete(true)
            return
          }
          runAction('delete')
        },
        onBlur: function () { setConfirmDelete(false) },
      }, busy === 'delete' ? h(Spinner) : h(IconTrash, { size: 15 }),
      h('span', null, confirmDelete ? t('confirming') : t('delete'))))
      actionButtons.push(h('button', {
        key: 'back',
        type: 'button',
        className: 'dsh-ps-btn dsh-ps-btn-ghost',
        onClick: onClose,
      }, h(IconClose, { size: 14 }), h('span', null, t('backToList'))))

      const transcriptNodes = []
      if (transcript.phase === 'loading') {
        transcriptNodes.push(h('div', { key: 'loading', className: 'dsh-ps-transcript-state' }, h(Spinner), h('span', null, t('transcriptLoading'))))
      } else if (transcript.messages.length === 0) {
        transcriptNodes.push(h('div', { key: 'empty', className: 'dsh-ps-transcript-state' },
          h('span', null, sessionId === null ? t('chatDisabled') : t('transcriptEmptyTask'))))
      } else {
        for (let i = 0; i < transcript.messages.length; i += 1) {
          transcriptNodes.push(h(TranscriptMessage, {
            key: transcript.messages[i].id + ':' + i,
            message: transcript.messages[i],
            userLabel: t('roleUser'),
            assistantLabel: t('roleAssistant'),
          }))
        }
      }

      let hintBox = null
      if (status === 'idea') hintBox = h('div', { className: 'dsh-ps-hint-box', role: 'status' }, h(IconSpark, { size: 14 }), h('span', null, t('ideaHint')))
      else if (status === 'blocked') hintBox = h('div', { className: 'dsh-ps-hint-box', role: 'status' }, h(IconAlert, { size: 14 }), h('span', null, t('blockedHint')))
      else if (status === 'paused') hintBox = h('div', { className: 'dsh-ps-hint-box', role: 'status' }, h(IconPause, { size: 14 }), h('span', null, t('pausedHint')))

      // Chat revive/continue hint: finished tasks restart on the next message,
      // paused tasks simply continue. Only queue tasks with a live session have
      // an active composer, so only those show the hint.
      let composerHint = null
      if (sessionId !== null && !isSession) {
        if (isEndedStatus(status)) {
          composerHint = h('p', { className: 'dsh-ps-composer-hint', role: 'status', 'data-tone': 'brand' },
            h(IconRefresh, { size: 13, className: 'dsh-ps-composer-hint-icon' }),
            h('span', null, t('chatReviveHint')))
        } else if (status === 'paused') {
          composerHint = h('p', { className: 'dsh-ps-composer-hint', role: 'status', 'data-tone': 'warn' },
            h(IconPlay, { size: 13, className: 'dsh-ps-composer-hint-icon' }),
            h('span', null, t('chatContinueHint')))
        }
      }

      return h('div', { className: 'dsh-ps-drawer-layer' },
        h('div', { className: 'dsh-ps-drawer-mask', 'aria-hidden': 'true', onClick: onClose }),
        h('div', {
          className: 'dsh-ps-drawer',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'dsh-ps-drawer-title',
          ref: dialogRef,
          tabIndex: -1,
        },
        h('div', { className: 'dsh-ps-drawer-head' },
          h('span', { className: 'dsh-ps-drawer-avatar', 'data-status': status, 'aria-hidden': 'true' }, h(StatusIcon, { status: status, size: 20 })),
          h('div', { className: 'dsh-ps-drawer-titles' },
            h('h2', { className: 'dsh-ps-drawer-title', id: 'dsh-ps-drawer-title' }, task.title),
            h('div', { className: 'dsh-ps-drawer-badges' },
              h(StatusBadge, { status: status, label: statusText }),
              h('span', { className: 'dsh-ps-priority', 'data-priority': normalizePriority(task.priority), title: t('priorityLabel') },
                h(IconFlag, { size: 10 }), h('span', null, priorityLabel(t, normalizePriority(task.priority)))),
              isSession ? h('span', { className: 'dsh-ps-chip dsh-ps-chip-session' }, h(IconChat, { size: 11 }), h('span', null, t('badgeSession'))) : null,
              running
                ? h('span', { className: 'dsh-ps-card-live' }, h(IconClock, { size: 12 }), h('span', null, t('runningFor', { duration: formatDuration(durationMs) })))
                : null,
              task.chainFrom !== '' && chainSource
                ? h('span', { className: 'dsh-ps-chip dsh-ps-chip-brand', title: t('chainTitle', { title: chainSource.title }) },
                  h(IconChain, { size: 11 }), h('span', null, t('chainShort')))
                : null)),
          h('button', {
            type: 'button',
            ref: closeBtnRef,
            className: 'dsh-ps-btn dsh-ps-btn-ghost dsh-ps-btn-icon',
            'aria-label': t('close'),
            title: t('close'),
            onClick: onClose,
          }, h(IconClose, { size: 16 }))),
        h('div', { className: 'dsh-ps-drawer-body', ref: bodyRef, onScroll: onBodyScroll },
          h('section', { className: 'dsh-ps-section' },
            h('div', { className: 'dsh-ps-section-head' },
              h('span', { className: 'dsh-ps-section-title' }, h(IconSliders, { size: 14 }), h('span', null, t('overview')))),
            h('div', { className: 'dsh-ps-meta-grid' }, metaCells)),
          h('section', { className: 'dsh-ps-section' },
            h('div', { className: 'dsh-ps-section-head' },
              h('span', { className: 'dsh-ps-section-title' }, h(IconFileText, { size: 14 }), h('span', null, t('taskPrompt')))),
            h('p', { className: 'dsh-ps-prompt-text' }, task.prompt !== '' ? task.prompt : '—')),
          isSession
            ? null
            : h('section', { className: 'dsh-ps-section' },
              h('div', { className: 'dsh-ps-section-head' },
                h('span', { className: 'dsh-ps-section-title' }, h(IconSpark, { size: 14 }), h('span', null, t('resultTitle'))),
                h('span', { className: 'dsh-ps-section-grow' }),
                answer !== ''
                  ? h('button', {
                    type: 'button',
                    className: 'dsh-ps-btn dsh-ps-btn-sm',
                    onClick: function () { copyResult(answer) },
                  }, h(IconCopy, { size: 13 }), h('span', null, t('resultCopy')))
                  : null),
              task.error !== '' ? h('div', { className: 'dsh-ps-result-error', role: 'alert' }, task.error) : null,
              resultBody),
          hintBox,
          h('div', { className: 'dsh-ps-drawer-actions' }, actionButtons),
          h('section', { className: 'dsh-ps-section' },
            h('div', { className: 'dsh-ps-section-head' },
              h('span', { className: 'dsh-ps-section-title' }, h(IconChat, { size: 14 }), h('span', null, t('chat'))),
              h('span', { className: 'dsh-ps-section-grow' }),
              running ? h('span', { className: 'dsh-ps-card-live' }, h(StatusDot, { status: 'running' }), h('span', null, t('statusRunning'))) : null),
            transcript.error
              ? h('div', { className: 'dsh-ps-inline-error', role: 'alert' }, t('transcriptFailed') + ' — ' + transcript.error)
              : null,
            h('div', { className: 'dsh-ps-transcript' }, transcriptNodes))),
        sessionId === null || isSession
          ? h('div', { className: 'dsh-ps-composer' },
            h('p', { className: 'dsh-ps-chat-disabled' }, h(IconChat, { size: 14 }), h('span', null, isSession ? t('chatReadOnly') : t('chatDisabled'))))
          : h('div', { className: 'dsh-ps-composer' },
            chatError ? h('div', { className: 'dsh-ps-inline-error', role: 'alert' }, chatError) : null,
            composerHint,
            h('div', { className: 'dsh-ps-composer-row' },
              h('textarea', {
                className: 'dsh-ps-textarea',
                ref: composerRef,
                value: draft,
                rows: 2,
                placeholder: t('chatPlaceholder'),
                'aria-label': t('chatPlaceholder'),
                disabled: sending,
                onChange: function (event) { setDraft(event.target.value) },
                onKeyDown: onComposerKeyDown,
              }),
              h('button', {
                type: 'button',
                className: 'dsh-ps-btn dsh-ps-btn-primary',
                disabled: sending || draft.trim() === '',
                onClick: send,
              }, sending ? h(Spinner) : h(IconSend, { size: 15 }),
              h('span', null, sending ? t('sending') : t('send')))))))
    }


    // ------------------------------------------------------------------ today workbench (v0.6)

    function taskEventAt(task) {
      if (!task || typeof task !== 'object') return 0
      if (typeof task.updatedAt === 'number' && isFinite(task.updatedAt) && task.updatedAt > 0) return task.updatedAt
      if (typeof task.createdAt === 'number' && isFinite(task.createdAt) && task.createdAt > 0) return task.createdAt
      return 0
    }

    var WAITING_STATUS_ORDER = { blocked: 0, failed: 1, paused: 2 }

    function waitingTasksOf(tasks) {
      const list = []
      if (Array.isArray(tasks)) {
        for (let i = 0; i < tasks.length; i += 1) {
          const task = tasks[i]
          if (task.status === 'blocked' || task.status === 'paused' || task.status === 'failed') list.push(task)
        }
      }
      list.sort(function (left, right) {
        const delta = (WAITING_STATUS_ORDER[left.status] || 9) - (WAITING_STATUS_ORDER[right.status] || 9)
        if (delta !== 0) return delta
        return taskEventAt(left) - taskEventAt(right)
      })
      return list
    }

    function recentEventsOf(tasks, now) {
      const cutoff = (typeof now === 'number' ? now : Date.now()) - NOTIF_RECENT_WINDOW_MS
      const list = []
      if (!Array.isArray(tasks)) return list
      for (let i = 0; i < tasks.length; i += 1) {
        const task = tasks[i]
        if (task.status !== 'done' && task.status !== 'failed' && task.status !== 'blocked') continue
        const at = taskEventAt(task)
        if (at > 0 && at >= cutoff) list.push(task)
      }
      list.sort(function (left, right) { return taskEventAt(right) - taskEventAt(left) })
      return list
    }

    function TodayView(props) {
      const t = props.t
      const store = props.store
      const snap = props.snap
      const now = props.now
      const tasks = Array.isArray(snap.tasks) ? snap.tasks : []
      const settings = snap.settings
      const today = todayKey()
      const date = new Date(now)
      const dateText = (date.getMonth() + 1) + '月' + date.getDate() + '日 · ' + t(WEEKDAY_KEYS[date.getDay()])

      const [capture, setCapture] = React.useState('')
      const [capturing, setCapturing] = React.useState(false)
      const [briefLines, setBriefLines] = React.useState([])
      const [joinBusy, setJoinBusy] = React.useState(null)

      const briefsState = snap.briefs || { phase: 'idle', items: [], settings: null, error: null, supported: true }
      // Contract §5.2 reads suggestions from settings.morningBrief.lastSuggestions,
      // so prefer the settings object when present and fall back to /briefs meta.
      const briefSettings = (settings && settings.morningBrief) || briefsState.settings || defaultMorningBriefSettings()
      const briefsSupported = briefsState.supported !== false
      const briefGenerating = briefSettings.lastStatus === 'running' || Boolean(briefSettings.generatingDate)
      let todayBrief = null
      for (let i = 0; i < briefsState.items.length; i += 1) {
        if (briefsState.items[i].date === today) { todayBrief = briefsState.items[i]; break }
      }
      let briefState = 'none'
      if (!briefsSupported) briefState = 'unsupported'
      else if (briefGenerating) briefState = 'generating'
      else if (briefSettings.enabled === false) briefState = 'off'
      else if (todayBrief) briefState = 'ready'

      const briefSig = todayBrief ? todayBrief.date + ':' + String(todayBrief.updatedAt) : ''
      React.useEffect(function () {
        if (!todayBrief) {
          setBriefLines([])
          return undefined
        }
        let alive = true
        store.loadBriefContent(today).then(function (result) {
          if (!alive) return
          const text = result.ok && result.data && typeof result.data.content === 'string' ? result.data.content : ''
          setBriefLines(briefSummaryLines(text, 3))
        })
        return function () { alive = false }
      }, [briefSig, today, store])

      // Host v0.7 writes structured suggestions; older briefs have none, so
      // derive a minimal fallback from the queue / ideas to keep the block useful.
      const storedSuggestions = Array.isArray(briefSettings.lastSuggestions) ? briefSettings.lastSuggestions : []
      const suggestions = storedSuggestions.length > 0
        ? normalizeBriefSuggestions(storedSuggestions)
        : fallbackBriefSuggestions(tasks, t)
      const showSuggestions = suggestions.length > 0 && briefState !== 'off' && briefState !== 'unsupported'

      const waiting = waitingTasksOf(tasks)
      const proposed = snap.evolution ? snap.evolution.proposedSkillCount : 0
      const waitingCount = waiting.length + (proposed > 0 ? 1 : 0)
      const running = []
      for (let i = 0; i < tasks.length; i += 1) {
        if (tasks[i].status === 'running') running.push(tasks[i])
      }
      let doneTodayCount = 0
      for (let i = 0; i < tasks.length; i += 1) {
        const task = tasks[i]
        if (task.status !== 'done') continue
        if (isSameLocalDay(task.endedAt || task.updatedAt, now)) doneTodayCount += 1
      }

      function submitCapture() {
        const text = capture.trim()
        if (text === '' || capturing) return
        setCapturing(true)
        Promise.resolve(props.onCapture(text)).then(function (result) {
          setCapturing(false)
          if (result && result.ok) setCapture('')
        }, function () { setCapturing(false) })
      }

      function onCaptureKeyDown(event) {
        if (event.key !== 'Enter') return
        if (event.nativeEvent && event.nativeEvent.isComposing) return
        event.preventDefault()
        submitCapture()
      }

      function joinSuggestion(suggestion) {
        if (joinBusy !== null) return
        setJoinBusy(suggestion.title)
        Promise.resolve(props.onJoinSuggestion(suggestion)).then(function () {
          setJoinBusy(null)
        }, function () { setJoinBusy(null) })
      }

      function stopAnd(task, action, event) {
        if (event) event.stopPropagation()
        props.onAction(task, action)
      }

      function stopAndOpen(task, event) {
        if (event) event.stopPropagation()
        props.onOpenTaskChat(task)
      }

      function stopAndOpenDetail(task, event) {
        if (event) event.stopPropagation()
        props.onOpenTask(task.id)
      }

      // ---- block 1: 今日简报 -------------------------------------------------
      const briefHead = h('div', { className: 'dsh-ps-today-sec-head' },
        h('span', { className: 'dsh-ps-today-sec-icon', 'aria-hidden': 'true' }, h(IconFileText, { size: 15 })),
        h('h3', { className: 'dsh-ps-today-sec-title' }, t('todayBrief')),
        todayBrief ? h('span', { className: 'dsh-ps-today-sec-count' }, todayBrief.date) : null)

      let briefBody = null
      if (briefState === 'ready') {
        const lineNodes = []
        for (let i = 0; i < briefLines.length; i += 1) {
          lineNodes.push(h('li', { key: 'brief-line-' + i, className: 'dsh-ps-brief-line' }, briefLines[i]))
        }
        briefBody = h(React.Fragment, null,
          lineNodes.length > 0
            ? h('ul', { className: 'dsh-ps-brief-lines' }, lineNodes)
            : h('p', { className: 'dsh-ps-brief-line' }, t('briefReady')),
          h('div', { className: 'dsh-ps-brief-actions' },
            h('button', {
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-primary',
              onClick: function () { props.onOpenBriefs() },
            }, h(IconFileText, { size: 13 }), h('span', null, t('briefView'))),
            h('button', {
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm',
              disabled: briefGenerating,
              onClick: function () { props.onGenerateBrief(today) },
            }, briefGenerating ? h(Spinner) : h(IconRefresh, { size: 13 }),
            h('span', null, briefGenerating ? t('briefGenerating') : t('briefsRegenerate')))))
      } else if (briefState === 'generating') {
        briefBody = h('p', { className: 'dsh-ps-today-more' }, t('briefGenerating'))
      } else if (briefState === 'off') {
        briefBody = h(React.Fragment, null,
          h('p', { className: 'dsh-ps-today-more' }, t('briefOff')),
          h('div', { className: 'dsh-ps-brief-actions' },
            h('button', {
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm',
              onClick: function () { props.onGoSettings() },
            }, h('span', null, t('briefGoSettings')))))
      } else if (briefState === 'unsupported') {
        briefBody = h('p', { className: 'dsh-ps-today-more' }, t('briefUnsupported'))
      } else {
        briefBody = h(React.Fragment, null,
          h('p', { className: 'dsh-ps-today-more' }, t('briefNoToday')),
          h('div', { className: 'dsh-ps-brief-actions' },
            h('button', {
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-primary',
              disabled: briefGenerating,
              onClick: function () { props.onGenerateBrief(today) },
            }, h(IconPlay, { size: 13 }), h('span', null, t('briefGenerate'))),
            h('button', {
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-ghost',
              onClick: function () { props.onOpenReview('journal') },
            }, h('span', null, t('briefYesterdayLog')))))
      }

      const suggestionNodes = []
      if (showSuggestions) {
        for (let i = 0; i < suggestions.length; i += 1) {
          const item = suggestions[i]
          const busy = joinBusy === item.title
          suggestionNodes.push(h('div', { key: 'suggest-' + i + '-' + item.title, className: 'dsh-ps-brief-suggest-row' },
            h('span', { className: 'dsh-ps-brief-suggest-text', title: item.title + (item.reason ? ' — ' + item.reason : '') },
              h('strong', null, item.title),
              item.reason ? h('span', { className: 'dsh-ps-brief-suggest-reason' }, ' — ' + item.reason) : null),
            h('button', {
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm',
              disabled: joinBusy !== null,
              onClick: function () { joinSuggestion(item) },
            }, busy ? h(Spinner) : h(IconPlus, { size: 12 }), h('span', null, t('briefJoin')))))
        }
      }
      const briefSection = h('section', { className: 'dsh-ps-today-section dsh-ps-brief-card', 'data-state': briefState, 'aria-label': t('todayBrief') },
        briefHead,
        briefBody,
        showSuggestions
          ? h('div', { className: 'dsh-ps-brief-suggest' },
            h('p', { className: 'dsh-ps-brief-suggest-title' }, t('briefSuggest')),
            suggestionNodes)
          : null)

      // ---- block 2: 等你处理 (only when there is something to do) ------------
      const waitingRaw = []
      for (let i = 0; i < waiting.length; i += 1) waitingRaw.push({ kind: waiting[i].status, task: waiting[i] })
      if (proposed > 0) waitingRaw.push({ kind: 'skills' })
      const waitingShown = waitingRaw.slice(0, 3)
      const waitingRows = []
      for (let i = 0; i < waitingShown.length; i += 1) {
        const entry = waitingShown[i]
        const task = entry.task || null
        const actions = []
        if (entry.kind === 'skills') {
          actions.push(h('button', {
            key: 'candidates',
            type: 'button',
            className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-primary',
            onClick: function () { props.onOpenReview('skills') },
          }, h('span', null, t('waitViewCandidates'))))
        } else {
          if (entry.kind === 'blocked') {
            actions.push(h('button', {
              key: 'primary',
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-primary',
              onClick: function (event) { stopAndOpen(task, event) },
            }, h('span', null, t('openSession'))))
          } else if (entry.kind === 'paused') {
            actions.push(h('button', {
              key: 'primary',
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-primary',
              onClick: function (event) { stopAnd(task, 'resume', event) },
            }, h('span', null, t('resume'))))
          } else {
            actions.push(h('button', {
              key: 'primary',
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-primary',
              onClick: function (event) { stopAnd(task, 'retry', event) },
            }, h('span', null, t('retry'))))
          }
          actions.push(h('button', {
            key: 'open',
            type: 'button',
            className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-ghost',
            onClick: function (event) { stopAndOpenDetail(task, event) },
          }, h('span', null, t('view'))))
        }
        waitingRows.push(h('li', { key: task ? task.id : 'skill-candidates', className: 'dsh-ps-today-row', 'data-kind': entry.kind },
          h('span', { className: 'dsh-ps-today-tag', 'data-kind': entry.kind },
            entry.kind === 'blocked' ? t('waitBlocked')
              : (entry.kind === 'paused' ? t('waitPaused')
                : (entry.kind === 'failed' ? t('waitFailed') : t('skills')))),
          h('div', { className: 'dsh-ps-today-main-col' },
            h('span', { className: 'dsh-ps-today-title', title: entry.kind === 'skills' ? t('waitSkillCandidates', { count: proposed }) : task.title },
              entry.kind === 'skills' ? t('waitSkillCandidates', { count: proposed }) : task.title)),
          h('div', { className: 'dsh-ps-today-actions' }, actions)))
      }
      const waitingSection = waitingRaw.length > 0
        ? h('section', { className: 'dsh-ps-today-section', 'aria-label': t('needsYou') },
          h('div', { className: 'dsh-ps-today-sec-head' },
            h('span', { className: 'dsh-ps-today-sec-icon', 'aria-hidden': 'true' }, h(IconBell, { size: 15 })),
            h('h3', { className: 'dsh-ps-today-sec-title' }, t('needsYou')),
            h('span', { className: 'dsh-ps-today-sec-count' }, String(waitingCount))),
          h('ul', { className: 'dsh-ps-today-list' }, waitingRows),
          waitingRaw.length > 3
            ? h('p', { className: 'dsh-ps-today-more' }, t('moreItems', { count: waitingRaw.length - 3 }))
            : null)
        : null

      // ---- block 3: 进行中 (only when something is running) -------------------
      const runningShown = running.slice(0, 3)
      const runningRows = []
      for (let i = 0; i < runningShown.length; i += 1) {
        const task = runningShown[i]
        const elapsed = t('runningFor', { duration: formatDuration(taskDurationMs(task, now)) })
        runningRows.push(h('li', { key: task.id, className: 'dsh-ps-today-row', 'data-kind': 'running' },
          h(StatusDot, { status: 'running' }),
          h('div', { className: 'dsh-ps-today-main-col' },
            h('span', { className: 'dsh-ps-today-title', title: task.title }, task.title),
            h('span', { className: 'dsh-ps-today-hint' }, elapsed)),
          h('div', { className: 'dsh-ps-today-actions' },
            h('button', {
              key: 'open',
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm',
              onClick: function () { props.onOpenSession(task) },
            }, h('span', null, t('openSession'))),
            h('button', {
              key: 'pause',
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-ghost',
              onClick: function (event) { stopAnd(task, 'pause', event) },
            }, h('span', null, t('pause'))))))
      }
      const runningSection = runningShown.length > 0
        ? h('section', { className: 'dsh-ps-today-section', 'aria-label': t('todayRunning') },
          h('div', { className: 'dsh-ps-today-sec-head' },
            h('span', { className: 'dsh-ps-today-sec-icon', 'aria-hidden': 'true' }, h(IconPlay, { size: 15 })),
            h('h3', { className: 'dsh-ps-today-sec-title' }, t('todayRunning')),
            h('span', { className: 'dsh-ps-today-sec-count' }, String(running.length))),
          h('ul', { className: 'dsh-ps-today-list' }, runningRows))
        : null

      // ---- greeting / capture / footer --------------------------------------
      const greetingRow = h('div', { className: 'dsh-ps-greet-row' },
        h('span', { className: 'dsh-ps-greet-date' },
          h(IconCalendar, { size: 13 }),
          h('span', null, dateText)),
        h('p', { className: 'dsh-ps-greet-line' }, t('greetingMorning')))

      const captureNode = h('div', { className: 'dsh-ps-capture' },
        h('input', {
          className: 'dsh-ps-capture-input',
          type: 'text',
          value: capture,
          placeholder: t('capturePlaceholder'),
          'aria-label': t('capturePlaceholder'),
          maxLength: MAX_TITLE_LENGTH,
          spellCheck: false,
          disabled: capturing,
          onChange: function (event) { setCapture(event.target.value) },
          onKeyDown: onCaptureKeyDown,
        }),
        h('button', {
          type: 'button',
          className: 'dsh-ps-capture-submit',
          disabled: capturing || capture.trim() === '',
          onClick: submitCapture,
        }, capturing ? h(Spinner) : null, h('span', null, capturing ? t('captureSaving') : t('captureSubmit'))))

      const footer = h('div', { className: 'dsh-ps-today-foot' },
        h('span', null, t('todayFooterDone', { count: doneTodayCount })),
        h('span', { className: 'dsh-ps-today-foot-sep', 'aria-hidden': 'true' }, '·'),
        h('button', {
          type: 'button',
          className: 'dsh-ps-foot-link',
          onClick: function () { props.onOpenReview('journal') },
        }, h('span', null, t('viewJournal'))),
        h('span', { className: 'dsh-ps-today-foot-sep', 'aria-hidden': 'true' }, '·'),
        h('button', {
          type: 'button',
          className: 'dsh-ps-foot-link',
          onClick: function () { props.onGoTasks() },
        }, h('span', null, t('shortcutBoard'))))

      return h('div', { className: 'dsh-ps-today-page' },
        greetingRow,
        captureNode,
        briefSection,
        waitingSection,
        runningSection,
        footer)
    }

    function BriefsDrawer(props) {
      const t = props.t
      const store = props.store
      const snap = useStoreSnapshot(store)
      const state = snap.briefs || { phase: 'idle', items: [], settings: null, error: null, supported: true }
      const settings = state.settings || (snap.settings ? snap.settings.morningBrief : null) || defaultMorningBriefSettings()
      const generating = settings.lastStatus === 'running' || Boolean(settings.generatingDate)
      const supported = state.supported !== false
      const today = todayKey()
      const items = state.items
      const dialogRef = React.useRef(null)
      const closeBtnRef = React.useRef(null)
      const [selectedDate, setSelectedDate] = React.useState(null)
      const [content, setContent] = React.useState({ phase: 'idle', text: '', error: null, date: null })
      const [contentTick, setContentTick] = React.useState(0)
      const [inlineError, setInlineError] = React.useState(null)
      const [localPending, setLocalPending] = React.useState(null)
      const prevGeneratingRef = React.useRef(null)

      useDialogA11y(dialogRef, props.onClose, true, closeBtnRef)

      React.useEffect(function () {
        if (!supported) return
        void store.refreshBriefs()
      }, [store, supported])

      React.useEffect(function () {
        if (items.length === 0) {
          if (selectedDate !== null) setSelectedDate(null)
          return
        }
        const present = selectedDate !== null && items.some(function (item) { return item.date === selectedDate })
        if (!present) setSelectedDate(items[0].date)
      }, [items, selectedDate])

      React.useEffect(function () {
        if (selectedDate === null) {
          setContent({ phase: 'ready', text: '', error: null, date: null })
          return undefined
        }
        let alive = true
        setContent({ phase: 'loading', text: '', error: null, date: selectedDate })
        store.loadBriefContent(selectedDate).then(function (result) {
          if (!alive) return
          if (result.ok && result.data && typeof result.data.content === 'string') {
            setContent({ phase: 'ready', text: result.data.content, error: null, date: selectedDate })
          } else {
            setContent({ phase: 'error', text: '', error: (result && result.error) || t('briefsContentFailed'), date: selectedDate })
          }
        })
        return function () { alive = false }
      }, [selectedDate, contentTick, store, t])

      React.useEffect(function () {
        if (!generating) return undefined
        const timer = setInterval(function () {
          if (typeof document !== 'undefined' && document.hidden === true) return
          void store.refreshBriefs()
        }, BRIEF_POLL_MS)
        return function () { clearInterval(timer) }
      }, [generating, store])

      React.useEffect(function () {
        const previous = prevGeneratingRef.current
        prevGeneratingRef.current = generating
        if (previous === true && generating === false) {
          setContentTick(function (value) { return value + 1 })
          void store.refreshBriefs()
        }
      }, [generating, store])

      React.useEffect(function () {
        if (!localPending) return
        if (!generating && settings.generatingDate === null && settings.lastStatus !== 'running') setLocalPending(null)
      }, [generating, settings.generatingDate, settings.lastStatus, localPending])

      function refreshAll() {
        setInlineError(null)
        void store.refreshBriefs()
        setContentTick(function (value) { return value + 1 })
      }

      function generate(day) {
        if (generating) return
        setInlineError(null)
        setLocalPending(day)
        store.generateBrief(day).then(function (result) {
          if (!result.ok) {
            setLocalPending(null)
            setInlineError(result.error || t('briefsGenerateFailed'))
            return
          }
          if (typeof props.addToast === 'function') props.addToast(t('briefsGenerated'), 'info')
        })
      }

      const selectedItem = selectedDate === null ? null : (items.find(function (item) { return item.date === selectedDate }) || null)
      const selectedGenerating = generating && (settings.generatingDate === selectedDate || localPending === selectedDate)
      const todayGenerating = generating && (settings.generatingDate === today || localPending === today)

      const listNodes = []
      if (state.phase === 'loading' || (state.phase === 'idle' && items.length === 0)) {
        listNodes.push(h('div', { key: 'loading', className: 'dsh-ps-transcript-state' }, h(Spinner), h('span', null, t('briefsLoading'))))
      } else if (state.phase === 'error' && items.length === 0) {
        listNodes.push(h('div', { key: 'error', className: 'dsh-ps-transcript-state' },
          h('span', null, t('briefsLoadFailed')),
          h('button', { type: 'button', className: 'dsh-ps-btn dsh-ps-btn-sm', onClick: refreshAll }, t('retry'))))
      } else if (items.length === 0) {
        listNodes.push(h('div', { key: 'empty', className: 'dsh-ps-transcript-state' }, h('span', null, t('briefsEmpty'))))
      } else {
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i]
          const isCurrent = item.date === selectedDate
          const itemGenerating = generating && (settings.generatingDate === item.date || localPending === item.date)
          const metaChildren = []
          if (item.bytes > 0) metaChildren.push(h('span', { key: 'size' }, formatBytes(item.bytes)))
          if (item.updatedAt > 0) metaChildren.push(h('span', { key: 'time' }, formatTime(item.updatedAt)))
          if (itemGenerating) metaChildren.push(h('span', { key: 'gen', className: 'dsh-ps-report-item-tag' }, h(Spinner), h('span', null, t('briefGenerating'))))
          listNodes.push(h('button', {
            key: item.date,
            type: 'button',
            className: 'dsh-ps-report-item',
            'data-brief-date': item.date,
            'aria-current': isCurrent ? 'true' : 'false',
            onClick: function () { setSelectedDate(item.date) },
          },
          h('span', { className: 'dsh-ps-report-item-date' }, item.date),
          h('span', { className: 'dsh-ps-report-item-meta' },
            item.date === today ? h('span', { key: 'today', className: 'dsh-ps-report-item-tag' }, t('briefsToday')) : null,
            metaChildren)))
        }
      }

      let mainContent = null
      if (!supported) {
        mainContent = h('div', { className: 'dsh-ps-report-state' }, h('span', null, t('briefUnsupported')))
      } else if (items.length === 0 && state.phase !== 'loading') {
        mainContent = h('div', { className: 'dsh-ps-report-state' },
          h(IconFileText, { size: 26, className: 'dsh-ps-empty-illustration' }),
          h('span', null, t('briefsEmptyHint')),
          h('div', { className: 'dsh-ps-report-empty-actions' },
            h('button', {
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-primary',
              disabled: generating,
              onClick: function () { generate(today) },
            }, todayGenerating ? h(Spinner) : h(IconPlay, { size: 14 }),
            h('span', null, todayGenerating ? t('briefGenerating') : t('briefsGenerate')))))
      } else if (selectedDate === null) {
        mainContent = h('div', { className: 'dsh-ps-report-state' }, h('span', null, t('briefsSelect')))
      } else if (content.phase === 'loading') {
        mainContent = h('div', { className: 'dsh-ps-report-state' }, h(Spinner), h('span', null, t('briefsContentLoading')))
      } else if (content.phase === 'error') {
        mainContent = h('div', { className: 'dsh-ps-report-state' },
          h(IconAlert, { size: 22, className: 'dsh-ps-empty-illustration' }),
          h('span', null, t('briefsContentFailed') + (content.error ? ' — ' + content.error : '')),
          h('button', {
            type: 'button',
            className: 'dsh-ps-btn dsh-ps-btn-sm',
            onClick: function () { setContentTick(function (value) { return value + 1 }) },
          }, t('retry')))
      } else {
        mainContent = h('pre', { className: 'dsh-ps-report-pre' }, content.text)
      }

      let headExtra = null
      if (selectedGenerating || todayGenerating) {
        headExtra = h('span', { className: 'dsh-ps-report-generating' }, h(Spinner), h('span', null, t('briefGenerating')))
      }

      return h('div', { className: 'dsh-ps-drawer-layer' },
        h('div', { className: 'dsh-ps-drawer-mask', 'aria-hidden': 'true', onClick: props.onClose }),
        h('div', {
          className: 'dsh-ps-drawer dsh-ps-report-drawer dsh-ps-brief-drawer',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'dsh-ps-brief-title',
          ref: dialogRef,
          tabIndex: -1,
        },
        h('div', { className: 'dsh-ps-drawer-head' },
          h('span', { className: 'dsh-ps-drawer-avatar', 'data-status': generating ? 'running' : 'done', 'aria-hidden': 'true' },
            generating ? h(Spinner) : h(IconFileText, { size: 20 })),
          h('div', { className: 'dsh-ps-drawer-titles' },
            h('h2', { className: 'dsh-ps-drawer-title', id: 'dsh-ps-brief-title' }, t('briefsTitle')),
            h('div', { className: 'dsh-ps-drawer-badges' },
              h('span', { className: 'dsh-ps-drawer-badges' }, h('span', { className: 'dsh-ps-section-hint' }, t('briefsSub'))),
              h('span', { className: 'dsh-ps-report-status-chip', 'data-tone': briefStatusTone(settings) }, briefStatusText(t, settings)),
              headExtra)),
          h('button', {
            type: 'button',
            ref: closeBtnRef,
            className: 'dsh-ps-btn dsh-ps-btn-ghost dsh-ps-btn-icon',
            'aria-label': t('close'),
            title: t('close'),
            onClick: props.onClose,
          }, h(IconClose, { size: 16 }))),
        inlineError ? h('div', { className: 'dsh-ps-inline-error', role: 'alert', style: { padding: '8px 16px 0' } }, inlineError) : null,
        h('div', { className: 'dsh-ps-report-body' },
          h('div', { className: 'dsh-ps-report-list', 'aria-label': t('briefsTitle') }, listNodes),
          h('div', { className: 'dsh-ps-report-main' },
            h('div', { className: 'dsh-ps-report-main-head' },
              h('div', { className: 'dsh-ps-report-main-title' },
                selectedDate !== null ? selectedDate : t('briefsNoSelection'),
                selectedDate !== null ? h('span', { className: 'dsh-ps-report-main-sub' },
                  selectedItem && selectedItem.bytes > 0 ? ' · ' + formatBytes(selectedItem.bytes) : '') : null),
              h('span', { className: 'dsh-ps-section-grow' }),
              selectedDate !== null
                ? h('button', {
                  type: 'button',
                  className: 'dsh-ps-btn dsh-ps-btn-sm',
                  disabled: generating,
                  onClick: function () { generate(selectedDate) },
                }, selectedGenerating ? h(Spinner) : h(IconRefresh, { size: 13 }),
                h('span', null, selectedGenerating ? t('briefGenerating') : t('briefsRegenerate')))
                : null,
              h('button', {
                type: 'button',
                className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-primary',
                disabled: generating,
                onClick: function () { generate(today) },
              }, todayGenerating ? h(Spinner) : h(IconPlay, { size: 13 }),
              h('span', null, todayGenerating ? t('briefGenerating') : t('briefsGenerate'))),
              h('button', {
                type: 'button',
                className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-ghost',
                'aria-label': t('briefsRefresh'),
                title: t('briefsRefresh'),
                disabled: state.phase === 'loading',
                onClick: refreshAll,
              }, h(IconRefresh, { size: 14 }))),
            h('div', { className: 'dsh-ps-report-content-wrap' }, mainContent)))))
    }

    function NotificationsPopover(props) {
      const t = props.t
      const tasks = Array.isArray(props.tasks) ? props.tasks : []
      const now = props.now
      const lastSeen = props.lastSeen
      const popRef = React.useRef(null)
      const closeRef = React.useRef(props.onClose)
      closeRef.current = props.onClose

      React.useEffect(function () {
        if (typeof document === 'undefined') return undefined
        function onPointerDown(event) {
          const node = popRef.current
          if (!node) return
          if (node.contains(event.target)) return
          closeRef.current()
        }
        function onKeyDown(event) {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          closeRef.current()
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return function () {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [])

      const waiting = waitingTasksOf(tasks)
      const waitingNodes = []
      for (let i = 0; i < waiting.length && i < NOTIF_WAITING_MAX; i += 1) {
        const task = waiting[i]
        waitingNodes.push(h('button', {
          key: task.id,
          type: 'button',
          className: 'dsh-ps-notif-item',
          onClick: function () {
            if (task.status === 'blocked') props.onOpenTaskChat(task)
            else props.onOpenTask(task.id)
          },
        },
        h(StatusDot, { status: task.status }),
        h('span', { className: 'dsh-ps-notif-item-title' }, task.title),
        h('span', { className: 'dsh-ps-notif-item-hint' }, statusLabel(t, task.status))))
      }
      const recent = recentEventsOf(tasks, now)
      const recentNodes = []
      for (let i = 0; i < recent.length && i < NOTIF_RECENT_MAX; i += 1) {
        const task = recent[i]
        recentNodes.push(h('button', {
          key: task.id,
          type: 'button',
          className: 'dsh-ps-notif-item',
          onClick: function () { props.onOpenTask(task.id) },
        },
        h(StatusDot, { status: task.status }),
        h('span', { className: 'dsh-ps-notif-item-title' }, task.title),
        h('span', { className: 'dsh-ps-notif-item-hint' }, formatRelativeTime(t, taskEventAt(task), now))))
      }
      let unread = 0
      if (lastSeen > 0) {
        const seen = new Set()
        const events = waiting.slice()
        for (let i = 0; i < recent.length; i += 1) {
          if (events.indexOf(recent[i]) < 0) events.push(recent[i])
        }
        for (let i = 0; i < events.length; i += 1) {
          const es = seen.has(events[i].id)
          seen.add(events[i].id)
          if (!es && taskEventAt(events[i]) > lastSeen) unread += 1
        }
      }
      const empty = waitingNodes.length === 0 && recentNodes.length === 0

      return h('div', {
        className: 'dsh-ps-notif-popover',
        role: 'dialog',
        'aria-label': t('notificationsAria'),
        ref: popRef,
      },
      h('div', { className: 'dsh-ps-notif-head' },
        h('span', { className: 'dsh-ps-notif-title' }, t('notifications')),
        unread > 0 ? h('span', { className: 'dsh-ps-notif-unread' }, t('notificationUnread', { count: unread })) : null,
        h('span', { className: 'dsh-ps-today-sec-grow' }),
        h('span', { className: 'dsh-ps-notif-item-hint' }, unread > 0 ? '' : t('notificationRead'))),
      waitingNodes.length > 0
        ? h('div', { className: 'dsh-ps-notif-section' },
          h('p', { className: 'dsh-ps-notif-section-title' }, t('needsYou')),
          waitingNodes)
        : null,
      recentNodes.length > 0
        ? h('div', { className: 'dsh-ps-notif-section' },
          h('p', { className: 'dsh-ps-notif-section-title' }, t('recentActivity')),
          recentNodes)
        : null,
      empty ? h('p', { className: 'dsh-ps-notif-empty' }, t('noActivity')) : null,
      h('div', { className: 'dsh-ps-notif-foot' },
        h('button', {
          type: 'button',
          className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-ghost',
          onClick: function () {
            if (typeof props.onOpenWebhookLog === 'function') props.onOpenWebhookLog()
          },
        }, h(IconSend, { size: 13 }), h('span', null, t('notificationLogTitle'))),
        h('span', { className: 'dsh-ps-section-grow' }),
        h('button', {
          type: 'button',
          className: 'dsh-ps-btn dsh-ps-btn-sm',
          onClick: props.onMarkAllRead,
        }, h(IconCheck, { size: 13 }), h('span', null, t('markAllRead')))))
    }

    function WebhookLogDialog(props) {
      const t = props.t
      const store = props.store
      const dialogRef = React.useRef(null)
      const closeBtnRef = React.useRef(null)
      const [state, setState] = React.useState({ phase: 'loading', items: [], error: null })

      useDialogA11y(dialogRef, props.onClose, true, closeBtnRef)

      function load(initial) {
        setState(function (previous) {
          if (initial && previous.items.length === 0) return { phase: 'loading', items: previous.items, error: null }
          return previous
        })
        store.loadWebhookLog().then(function (result) {
          if (result.ok) setState({ phase: 'ready', items: result.data.items, error: null })
          else setState({ phase: 'error', items: [], error: result.error || t('notificationLogFailed') })
        })
      }

      React.useEffect(function () {
        load(true)
      }, [store])

      const rows = []
      for (let i = 0; i < state.items.length; i += 1) {
        const item = state.items[i]
        rows.push(h('div', { key: String(item.at) + ':' + i, className: 'dsh-ps-log-row' },
          h('span', { className: 'dsh-ps-log-state', 'data-ok': item.ok ? 'true' : 'false' }, item.ok ? t('webhookStatusOk') : t('webhookStatusFailed')),
          h('div', { className: 'dsh-ps-log-main' },
            h('span', { className: 'dsh-ps-log-event' }, webhookEventLabel(t, item.event)),
            h('span', { className: 'dsh-ps-log-meta' }, formatTime(item.at) + (item.httpStatus !== null ? ' · HTTP ' + item.httpStatus : '')),
            item.error ? h('p', { className: 'dsh-ps-log-error' }, item.error) : null)))
      }

      let body = null
      if (state.phase === 'loading') {
        body = h('div', { className: 'dsh-ps-report-state' }, h(Spinner), h('span', null, t('notifications')))
      } else if (state.phase === 'error') {
        body = h('div', { className: 'dsh-ps-report-state' },
          h(IconAlert, { size: 22, className: 'dsh-ps-empty-illustration' }),
          h('span', null, t('notificationLogFailed') + (state.error ? ' — ' + state.error : '')),
          h('button', { type: 'button', className: 'dsh-ps-btn dsh-ps-btn-sm', onClick: function () { load(false) } }, t('retry')))
      } else if (rows.length === 0) {
        body = h('div', { className: 'dsh-ps-report-state' },
          h(IconSend, { size: 24, className: 'dsh-ps-empty-illustration' }),
          h('span', null, t('notificationLogEmpty')))
      } else {
        body = h('div', { className: 'dsh-ps-log-list', 'aria-label': t('notificationLogTitle') }, rows)
      }

      return h('div', { className: 'dsh-ps-dialog-layer' },
        h('div', { className: 'dsh-ps-dialog-mask', 'aria-hidden': 'true', onClick: props.onClose }),
        h('div', {
          className: 'dsh-ps-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'dsh-ps-log-title',
          ref: dialogRef,
          tabIndex: -1,
        },
        h('div', { className: 'dsh-ps-dialog-head' },
          h('div', { className: 'dsh-ps-dialog-titles' },
            h('h2', { className: 'dsh-ps-dialog-title', id: 'dsh-ps-log-title' }, t('notificationLogTitle')),
            h('p', { className: 'dsh-ps-dialog-sub' }, t('notificationLogSub'))),
          h('button', {
            type: 'button',
            ref: closeBtnRef,
            className: 'dsh-ps-btn dsh-ps-btn-ghost dsh-ps-btn-icon',
            'aria-label': t('close'),
            title: t('close'),
            onClick: props.onClose,
          }, h(IconClose, { size: 16 }))),
        h('div', { className: 'dsh-ps-dialog-body' }, body),
        h('div', { className: 'dsh-ps-dialog-foot' },
          h('button', {
            type: 'button',
            className: 'dsh-ps-btn dsh-ps-btn-sm',
            disabled: state.phase === 'loading',
            onClick: function () { load(false) },
          }, h(IconRefresh, { size: 13 }), h('span', null, t('notificationLogRefresh'))),
          h('span', { className: 'dsh-ps-dialog-foot-grow' }),
          h('button', { type: 'button', className: 'dsh-ps-btn dsh-ps-btn-primary', onClick: props.onClose }, t('close')))))
    }

    // ------------------------------------------------------------------ reports drawer

    function ReportsDrawer(props) {
      const t = props.t
      const store = props.store
      const snap = useStoreSnapshot(store)
      const reportsState = snap.reports || { phase: 'idle', items: [], settings: null, error: null }
      const reportSettings = reportsState.settings || (snap.settings ? snap.settings.dailyReport : null) || defaultDailyReportSettings()
      const generating = reportSettings.lastStatus === 'running' || Boolean(reportSettings.generatingDate)
      const dialogRef = React.useRef(null)
      const closeBtnRef = React.useRef(null)
      const prevGeneratingRef = React.useRef(null)
      const prevStatusRef = React.useRef(reportSettings.lastStatus)
      const [selectedDate, setSelectedDate] = React.useState(null)
      const [localPending, setLocalPending] = React.useState(null)
      const [content, setContent] = React.useState({ phase: 'idle', text: '', error: null, date: null })
      const [contentTick, setContentTick] = React.useState(0)
      const [inlineError, setInlineError] = React.useState(null)
      const today = todayKey()
      const items = reportsState.items
      const phase = reportsState.phase

      useDialogA11y(dialogRef, props.onClose, !props.embedded, closeBtnRef)

      React.useEffect(function () {
        void store.refreshReports()
      }, [store])

      React.useEffect(function () {
        if (items.length === 0) {
          if (selectedDate !== null) setSelectedDate(null)
          return
        }
        const present = selectedDate !== null && items.some(function (item) { return item.date === selectedDate })
        if (!present) setSelectedDate(items[0].date)
      }, [items, selectedDate])

      React.useEffect(function () {
        if (selectedDate === null) {
          setContent({ phase: 'ready', text: '', error: null, date: null })
          return undefined
        }
        let alive = true
        setContent({ phase: 'loading', text: '', error: null, date: selectedDate })
        store.loadReportContent(selectedDate).then(function (result) {
          if (!alive) return
          if (result.ok && result.data && typeof result.data.content === 'string') {
            setContent({ phase: 'ready', text: result.data.content, error: null, date: selectedDate })
          } else {
            setContent({ phase: 'error', text: '', error: (result && result.error) || t('reportsContentFailed'), date: selectedDate })
          }
        })
        return function () { alive = false }
      }, [selectedDate, contentTick, store, t])

      React.useEffect(function () {
        if (!generating) return undefined
        const timer = setInterval(function () {
          if (typeof document !== 'undefined' && document.hidden === true) return
          void store.refreshReports()
        }, REPORT_POLL_MS)
        return function () { clearInterval(timer) }
      }, [generating, store])

      React.useEffect(function () {
        const previous = prevGeneratingRef.current
        prevGeneratingRef.current = generating
        const currentStatus = reportSettings.lastStatus
        const previousStatus = prevStatusRef.current
        prevStatusRef.current = currentStatus
        if (previous === true && generating === false) {
          setContentTick(function (value) { return value + 1 })
          void store.refreshReports()
        } else if (previous === null && previousStatus === 'running' && generating === false) {
          setContentTick(function (value) { return value + 1 })
        }
      }, [generating, reportSettings.lastStatus, store])

      React.useEffect(function () {
        if (!localPending) return
        if (!generating && reportSettings.generatingDate === null && reportSettings.lastStatus !== 'running') {
          const matched = items.some(function (item) { return item.date === localPending })
          if (matched || reportSettings.lastStatus === 'ok' || reportSettings.lastStatus === 'failed') setLocalPending(null)
        }
      }, [generating, reportSettings.generatingDate, reportSettings.lastStatus, items, localPending])

      function refreshAll() {
        setInlineError(null)
        void store.refreshReports()
        setContentTick(function (value) { return value + 1 })
      }

      function generate(day) {
        if (generating) return
        setInlineError(null)
        setLocalPending(day)
        store.generateReport(day).then(function (result) {
          if (!result.ok) {
            setLocalPending(null)
            setInlineError(result.error || t('reportGenerateFailed'))
            return
          }
          if (typeof props.addToast === 'function') props.addToast(t('reportGenerating'), 'info')
        })
      }

      const selectedItem = selectedDate === null ? null : items.find(function (item) { return item.date === selectedDate }) || null
      const selectedGenerating = generating && (reportSettings.generatingDate === selectedDate || localPending === selectedDate)
      const todayGenerating = generating && (reportSettings.generatingDate === today || localPending === today)

      const listNodes = []
      if (phase === 'loading' || (phase === 'idle' && items.length === 0)) {
        listNodes.push(h('div', { key: 'loading', className: 'dsh-ps-transcript-state' }, h(Spinner), h('span', null, t('reportsLoading'))))
      } else if (phase === 'error' && items.length === 0) {
        listNodes.push(h('div', { key: 'error', className: 'dsh-ps-transcript-state' },
          h('span', null, t('reportsLoadFailed')),
          h('button', { type: 'button', className: 'dsh-ps-btn dsh-ps-btn-sm', onClick: refreshAll }, t('retry'))))
      } else if (items.length === 0) {
        listNodes.push(h('div', { key: 'empty', className: 'dsh-ps-transcript-state' }, h('span', null, t('reportsEmpty'))))
      } else {
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i]
          const isCurrent = item.date === selectedDate
          const itemGenerating = generating && (reportSettings.generatingDate === item.date || localPending === item.date)
          const metaChildren = []
          if (item.bytes > 0) metaChildren.push(h('span', { key: 'size' }, t('reportBytes', { size: formatBytes(item.bytes) })))
          if (item.updatedAt > 0) metaChildren.push(h('span', { key: 'time' }, formatTime(item.updatedAt)))
          if (itemGenerating) metaChildren.push(h('span', { key: 'gen', className: 'dsh-ps-report-item-tag' }, h(Spinner), h('span', null, t('reportGenerating'))))
          listNodes.push(h('button', {
            key: item.date,
            type: 'button',
            className: 'dsh-ps-report-item',
            'data-report-date': item.date,
            'aria-current': isCurrent ? 'true' : 'false',
            onClick: function () { setSelectedDate(item.date) },
          },
          h('span', { className: 'dsh-ps-report-item-date' }, item.date),
          h('span', { className: 'dsh-ps-report-item-meta' },
            item.date === today ? h('span', { key: 'today', className: 'dsh-ps-report-item-tag' }, t('reportToday')) : null,
            metaChildren)))
        }
      }

      let mainContent = null
      if (items.length === 0 && phase !== 'loading') {
        mainContent = h('div', { className: 'dsh-ps-report-state' },
          h(IconFileText, { size: 26, className: 'dsh-ps-empty-illustration' }),
          h('span', null, t('reportsEmptyHint')),
          h('div', { className: 'dsh-ps-report-empty-actions' },
            h('button', {
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-primary',
              disabled: generating,
              onClick: function () { generate(today) },
            }, todayGenerating ? h(Spinner) : h(IconPlay, { size: 14 }),
            h('span', null, todayGenerating ? t('reportGenerating') : t('reportGenerate')))))
      } else if (selectedDate === null) {
        mainContent = h('div', { className: 'dsh-ps-report-state' }, h('span', null, t('reportsSelect')))
      } else if (content.phase === 'loading') {
        mainContent = h('div', { className: 'dsh-ps-report-state' }, h(Spinner), h('span', null, t('reportsContentLoading')))
      } else if (content.phase === 'error') {
        mainContent = h('div', { className: 'dsh-ps-report-state' },
          h(IconAlert, { size: 22, className: 'dsh-ps-empty-illustration' }),
          h('span', null, t('reportsContentFailed') + (content.error ? ' — ' + content.error : '')),
          h('button', {
            type: 'button',
            className: 'dsh-ps-btn dsh-ps-btn-sm',
            onClick: function () { setContentTick(function (value) { return value + 1 }) },
          }, t('retry')))
      } else {
        mainContent = h('pre', { className: 'dsh-ps-report-pre' }, content.text)
      }

      let headExtra = null
      if (selectedGenerating || todayGenerating) {
        headExtra = h('span', { className: 'dsh-ps-report-generating' }, h(Spinner), h('span', null, t('reportGenerating')))
      }

      if (props.embedded === true) {
        return h('div', { className: 'dsh-ps-review-embedded' },
          inlineError ? h('div', { className: 'dsh-ps-inline-error', role: 'alert', style: { padding: '8px 20px 0' } }, inlineError) : null,
          h('div', { className: 'dsh-ps-report-body' },
          h('div', { className: 'dsh-ps-report-list', 'aria-label': t('reportsTitle') }, listNodes),
          h('div', { className: 'dsh-ps-report-main' },
            h('div', { className: 'dsh-ps-report-main-head' },
              h('div', { className: 'dsh-ps-report-main-title' },
                selectedDate !== null ? selectedDate : t('reportNoSelection'),
                selectedDate !== null ? h('span', { className: 'dsh-ps-report-main-sub' },
                  selectedItem && selectedItem.bytes > 0 ? ' · ' + formatBytes(selectedItem.bytes) : '') : null),
              h('span', { className: 'dsh-ps-section-grow' }),
              selectedDate !== null
                ? h('button', {
                  type: 'button',
                  className: 'dsh-ps-btn dsh-ps-btn-sm',
                  disabled: generating,
                  title: t('reportRegenerating'),
                  onClick: function () { generate(selectedDate) },
                }, selectedGenerating ? h(Spinner) : h(IconRefresh, { size: 13 }),
                h('span', null, selectedGenerating ? t('reportGenerating') : t('reportRegenerating')))
                : null,
              h('button', {
                type: 'button',
                className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-primary',
                disabled: generating,
                onClick: function () { generate(today) },
              }, todayGenerating ? h(Spinner) : h(IconPlay, { size: 13 }),
              h('span', null, todayGenerating ? t('reportGenerating') : t('reportGenerate'))),
              h('button', {
                type: 'button',
                className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-ghost',
                'aria-label': t('reportRefresh'),
                title: t('reportRefresh'),
                disabled: phase === 'loading',
                onClick: refreshAll,
              }, h(IconRefresh, { size: 14 }))),
            h('div', { className: 'dsh-ps-report-content-wrap' }, mainContent))))
      }

      return h('div', { className: 'dsh-ps-drawer-layer' },
        h('div', { className: 'dsh-ps-drawer-mask', 'aria-hidden': 'true', onClick: props.onClose }),
        h('div', {
          className: 'dsh-ps-drawer dsh-ps-report-drawer',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'dsh-ps-report-title',
          ref: dialogRef,
          tabIndex: -1,
        },
        h('div', { className: 'dsh-ps-drawer-head' },
          h('span', { className: 'dsh-ps-drawer-avatar', 'data-status': generating ? 'running' : 'done', 'aria-hidden': 'true' },
            generating ? h(Spinner) : h(IconFileText, { size: 20 })),
          h('div', { className: 'dsh-ps-drawer-titles' },
            h('h2', { className: 'dsh-ps-drawer-title', id: 'dsh-ps-report-title' }, t('reportsTitle')),
            h('div', { className: 'dsh-ps-drawer-badges' },
              h('span', { className: 'dsh-ps-drawer-badges' }, h('span', { className: 'dsh-ps-section-hint' }, t('reportsSub'))),
              h('span', { className: 'dsh-ps-report-status-chip', 'data-tone': reportStatusTone(reportSettings) },
                reportStatusText(t, reportSettings)),
              headExtra)),
          h('button', {
            type: 'button',
            ref: closeBtnRef,
            className: 'dsh-ps-btn dsh-ps-btn-ghost dsh-ps-btn-icon',
            'aria-label': t('close'),
            title: t('close'),
            onClick: props.onClose,
          }, h(IconClose, { size: 16 }))),
        inlineError ? h('div', { className: 'dsh-ps-inline-error', role: 'alert', style: { padding: '8px 16px 0' } }, inlineError) : null,
        h('div', { className: 'dsh-ps-report-body' },
          h('div', { className: 'dsh-ps-report-list', 'aria-label': t('reportsTitle') }, listNodes),
          h('div', { className: 'dsh-ps-report-main' },
            h('div', { className: 'dsh-ps-report-main-head' },
              h('div', { className: 'dsh-ps-report-main-title' },
                selectedDate !== null ? selectedDate : t('reportNoSelection'),
                selectedDate !== null ? h('span', { className: 'dsh-ps-report-main-sub' },
                  selectedItem && selectedItem.bytes > 0 ? ' · ' + formatBytes(selectedItem.bytes) : '') : null),
              h('span', { className: 'dsh-ps-section-grow' }),
              selectedDate !== null
                ? h('button', {
                  type: 'button',
                  className: 'dsh-ps-btn dsh-ps-btn-sm',
                  disabled: generating,
                  title: t('reportRegenerating'),
                  onClick: function () { generate(selectedDate) },
                }, selectedGenerating ? h(Spinner) : h(IconRefresh, { size: 13 }),
                h('span', null, selectedGenerating ? t('reportGenerating') : t('reportRegenerating')))
                : null,
              h('button', {
                type: 'button',
                className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-primary',
                disabled: generating,
                onClick: function () { generate(today) },
              }, todayGenerating ? h(Spinner) : h(IconPlay, { size: 13 }),
              h('span', null, todayGenerating ? t('reportGenerating') : t('reportGenerate'))),
              h('button', {
                type: 'button',
                className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-ghost',
                'aria-label': t('reportRefresh'),
                title: t('reportRefresh'),
                disabled: phase === 'loading',
                onClick: refreshAll,
              }, h(IconRefresh, { size: 14 }))),
            h('div', { className: 'dsh-ps-report-content-wrap' }, mainContent)))))
    }

    // ------------------------------------------------------------------ evolution drawer

    // v9: three-tab drawer (retrospectives / lessons / skills) on top of the
    // same drawer shell, focus trap and polling conventions as ReportsDrawer.
    function EvolutionDrawer(props) {
      const t = props.t
      const store = props.store
      const ctx = props.ctx
      const snap = useStoreSnapshot(store)
      const meta = snap.evolution || defaultEvolutionMeta()
      const dialogRef = React.useRef(null)
      const closeBtnRef = React.useRef(null)
      const embedded = props.embedded === true
      const embeddedTab = EVOLUTION_TAB_KEYS.indexOf(props.embeddedTab) >= 0 ? props.embeddedTab : null
      const initialTab = embedded && embeddedTab !== null
        ? embeddedTab
        : (EVOLUTION_TAB_KEYS.indexOf(props.initialTab) >= 0 ? props.initialTab : 'retrospective')
      const [tab, setTab] = React.useState(initialTab)
      const [data, setData] = React.useState({
        phase: 'idle',
        settings: null,
        skillsAvailable: true,
        lessons: [],
        skills: [],
        retrospectives: [],
        running: false,
        error: null,
      })
      const [inlineError, setInlineError] = React.useState(null)
      const [localGenerating, setLocalGenerating] = React.useState(false)
      const [selectedDate, setSelectedDate] = React.useState(null)
      const [content, setContent] = React.useState({ phase: 'idle', text: '', error: null, date: null })
      const [contentTick, setContentTick] = React.useState(0)
      const [lessonText, setLessonText] = React.useState('')
      const [lessonCategory, setLessonCategory] = React.useState('process')
      const [lessonScope, setLessonScope] = React.useState('global')
      const [lessonProject, setLessonProject] = React.useState('')
      const [lessonError, setLessonError] = React.useState(null)
      const [pickingLessonDir, setPickingLessonDir] = React.useState(false)
      const [confirmLessonId, setConfirmLessonId] = React.useState(null)
      const [confirmSkillName, setConfirmSkillName] = React.useState(null)
      const [expandedSkill, setExpandedSkill] = React.useState(null)
      const [skillContents, setSkillContents] = React.useState({})
      const [busy, setBusy] = React.useState(null)

      useDialogA11y(dialogRef, props.onClose, !embedded, closeBtnRef)

      function loadData(silent) {
        if (!silent) setInlineError(null)
        return store.loadEvolution().then(function (result) {
          if (result.ok) {
            const next = normalizeEvolutionSnapshot(result.data)
            setData({
              phase: 'ready',
              settings: next.settings,
              skillsAvailable: next.skillsAvailable,
              lessons: next.lessons,
              skills: next.skills,
              retrospectives: next.retrospectives,
              running: next.running,
              error: null,
            })
            return result
          }
          const message = result.error || t('retrospectiveLoadFailed')
          setData(function (previous) {
            return Object.assign({}, previous, {
              phase: previous.phase === 'idle' ? 'error' : previous.phase,
              error: message,
            })
          })
          if (!silent) setInlineError(message)
          return result
        })
      }

      React.useEffect(function () {
        void loadData(false)
      }, [store])

      // The Host lists retrospectives date-descending; keep the newest selected
      // unless the user picked another existing one.
      React.useEffect(function () {
        const items = data.retrospectives
        if (items.length === 0) {
          if (selectedDate !== null) setSelectedDate(null)
          return
        }
        const present = selectedDate !== null && items.some(function (item) { return item.date === selectedDate })
        if (!present) setSelectedDate(items[0].date)
      }, [data.retrospectives, selectedDate])

      React.useEffect(function () {
        if (selectedDate === null) {
          setContent({ phase: 'ready', text: '', error: null, date: null })
          return undefined
        }
        let alive = true
        setContent({ phase: 'loading', text: '', error: null, date: selectedDate })
        store.loadRetrospectiveContent(selectedDate).then(function (result) {
          if (!alive) return
          if (result.ok && result.data && typeof result.data.content === 'string') {
            setContent({ phase: 'ready', text: result.data.content, error: null, date: selectedDate })
          } else {
            setContent({
              phase: 'error',
              text: '',
              error: (result && result.error) || t('retrospectiveContentFailed'),
              date: selectedDate,
            })
          }
        })
        return function () { alive = false }
      }, [selectedDate, contentTick, store, t])

      const metaGenerating = meta.lastStatus === 'running' || Boolean(meta.generatingDate)
      const serverGenerating = metaGenerating || data.running
      const generating = serverGenerating || localGenerating
      const previousGeneratingRef = React.useRef(null)

      // A run just finished: refresh list/content and toast the outcome.
      React.useEffect(function () {
        const previous = previousGeneratingRef.current
        previousGeneratingRef.current = generating
        if (previous !== true || generating) return
        setLocalGenerating(false)
        setContentTick(function (value) { return value + 1 })
        void loadData(true)
        if (meta.lastStatus === 'failed') {
          if (typeof props.addToast === 'function') props.addToast(t('retrospectiveGenerateFailed'), 'error')
        } else if (meta.lastStatus === 'ok') {
          // Jump to the freshly generated report; the list refresh keeps it too.
          if (typeof meta.lastDate === 'string' && meta.lastDate !== '') setSelectedDate(meta.lastDate)
          if (typeof props.addToast === 'function') props.addToast(t('retrospectiveGenerated'), 'success')
        }
      }, [generating, meta.lastStatus, meta.lastDate, t])

      // A successful POST flips the Host to "running" asynchronously; never let
      // the local spinner stick forever if that state is never observed.
      React.useEffect(function () {
        if (!localGenerating) return undefined
        const timer = setTimeout(function () { setLocalGenerating(false) }, 90000)
        return function () { clearTimeout(timer) }
      }, [localGenerating])

      // While a retrospective is running, poll the detail payload every 3s.
      React.useEffect(function () {
        if (!generating) return undefined
        const timer = setInterval(function () {
          if (typeof document !== 'undefined' && document.hidden === true) return
          void loadData(true)
        }, EVOLUTION_POLL_MS)
        return function () { clearInterval(timer) }
      }, [generating])

      function generate() {
        if (generating) return
        setInlineError(null)
        setLocalGenerating(true)
        store.generateRetrospective().then(function (result) {
          if (!result.ok) {
            setLocalGenerating(false)
            setInlineError(result.error || t('retrospectiveGenerateFailed'))
            return
          }
          const payload = result.data && typeof result.data === 'object' ? result.data : {}
          if (payload.skipped) {
            setLocalGenerating(false)
            if (typeof props.addToast === 'function') props.addToast(t('retrospectiveSkipped'), 'info')
            void loadData(true)
            return
          }
          if (typeof props.addToast === 'function') props.addToast(t('retrospectiveGenerating'), 'info')
          void loadData(true)
        })
      }

      function refreshRetrospective() {
        setInlineError(null)
        setContentTick(function (value) { return value + 1 })
        void loadData(false)
      }

      function submitLesson() {
        if (busy !== null) return
        const text = lessonText.trim()
        if (text === '') {
          setLessonError(t('lessonTextRequired'))
          return
        }
        if (text.length > MAX_LESSON_LENGTH) {
          setLessonError(t('lessonTextTooLong', { max: MAX_LESSON_LENGTH }))
          return
        }
        const project = lessonProject.trim()
        if (lessonScope === 'project' && !isAbsolutePath(project)) {
          setLessonError(t('lessonProjectRequired'))
          return
        }
        setLessonError(null)
        setBusy('lesson-add')
        const body = { text: text, category: lessonCategory, scope: lessonScope }
        if (lessonScope === 'project') body.project = project
        store.addLesson(body).then(function (result) {
          setBusy(null)
          if (!result.ok) {
            setLessonError(result.error || t('lessonAddFailed'))
            return
          }
          setLessonText('')
          if (typeof props.addToast === 'function') props.addToast(t('lessonAdded'), 'success')
          void loadData(true)
        })
      }

      function toggleLesson(lesson) {
        if (busy !== null) return
        setBusy('lesson:' + lesson.id)
        store.updateLesson({ id: lesson.id, active: !lesson.active }).then(function (result) {
          setBusy(null)
          if (!result.ok) return
          if (typeof props.addToast === 'function') props.addToast(t('lessonUpdated'), 'success')
          void loadData(true)
        })
      }

      function deleteLesson(lesson) {
        if (busy !== null) return
        setBusy('lesson-delete:' + lesson.id)
        store.deleteLesson(lesson.id).then(function (result) {
          setBusy(null)
          setConfirmLessonId(null)
          if (!result.ok) return
          if (typeof props.addToast === 'function') props.addToast(t('lessonDeleted'), 'success')
          void loadData(true)
        })
      }

      function pickLessonDirectory() {
        if (pickingLessonDir) return
        const service = ctx && ctx.uiWorkspace ? ctx.uiWorkspace : null
        if (!service || typeof service.pickDirectory !== 'function') {
          setLessonError(t('pickFailed'))
          return
        }
        setPickingLessonDir(true)
        let attempt = null
        try { attempt = service.pickDirectory() } catch (error) { attempt = Promise.reject(error) }
        Promise.resolve(attempt).then(function (picked) {
          setPickingLessonDir(false)
          if (typeof picked === 'string' && picked.trim() !== '') {
            setLessonProject(picked)
            setLessonError(null)
          }
        }, function (error) {
          setPickingLessonDir(false)
          setLessonError(t('pickFailed') + ' — ' + (error && error.message ? error.message : t('unknownError')))
        })
      }

      function toggleSkillContent(skill) {
        if (expandedSkill === skill.name) {
          setExpandedSkill(null)
          return
        }
        setExpandedSkill(skill.name)
        const cached = skillContents[skill.name]
        if (cached && cached.phase === 'loading') return
        if (cached && cached.phase === 'ready') return
        setSkillContents(function (previous) {
          const next = Object.assign({}, previous)
          next[skill.name] = { phase: 'loading', text: '', error: null }
          return next
        })
        store.loadSkillContent(skill.name).then(function (result) {
          setSkillContents(function (previous) {
            const next = Object.assign({}, previous)
            if (result.ok && result.data && typeof result.data.content === 'string') {
              next[skill.name] = { phase: 'ready', text: result.data.content, error: null }
            } else {
              next[skill.name] = {
                phase: 'error',
                text: '',
                error: (result && result.error) || t('skillContentFailed'),
              }
            }
            return next
          })
        })
      }

      function runSkillAction(skill, action) {
        if (busy !== null) return
        setBusy('skill:' + skill.name + ':' + action)
        store.skillAction(skill.name, action).then(function (result) {
          setBusy(null)
          setConfirmSkillName(null)
          if (!result.ok) {
            setInlineError(result.error || (action === 'adopt' ? t('skillAdoptFailed') : t('skillActionFailed')))
            return
          }
          if (typeof props.addToast === 'function') {
            let message = t('skillActionFailed')
            if (action === 'adopt') message = t('skillAdopted')
            else if (action === 'enable') message = t('skillEnabled')
            else if (action === 'disable') message = t('skillDisabled')
            else if (action === 'delete') message = t('skillDeleted')
            props.addToast(message, 'success')
          }
          if (action === 'delete' && expandedSkill === skill.name) setExpandedSkill(null)
          void loadData(true)
        })
      }

      function switchTab(next) {
        setTab(next)
        const node = dialogRef.current && typeof dialogRef.current.querySelector === 'function'
          ? dialogRef.current.querySelector('[data-evo-tab="' + next + '"]')
          : null
        if (node && typeof node.focus === 'function') {
          try { node.focus() } catch (error) { /* focus is progressive enhancement */ }
        }
      }

      function onTabKeyDown(event, index) {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
        event.preventDefault()
        const delta = event.key === 'ArrowRight' ? 1 : -1
        const next = EVOLUTION_TAB_KEYS[(index + delta + EVOLUTION_TAB_KEYS.length) % EVOLUTION_TAB_KEYS.length]
        switchTab(next)
      }

      const phase = data.phase
      const retrospectives = data.retrospectives
      const lessons = data.lessons
      const skills = data.skills
      const settingsForStatus = data.settings || (snap.settings ? snap.settings.evolution : null) || meta
      const proposedCount = skills.filter(function (skill) { return skill.status === 'proposed' }).length
      const tabCounts = { retrospective: retrospectives.length, lessons: lessons.length, skills: proposedCount }
      const tabLabels = { retrospective: t('tabRetro'), lessons: t('tabLessons'), skills: t('tabSkills') }
      const tabArias = {
        retrospective: t('retrospectiveTabAria', { count: retrospectives.length }),
        lessons: t('tabLessonsAria', { count: lessons.length }),
        skills: t('tabSkillsAria', { count: proposedCount }),
      }
      const tabNodes = []
      for (let i = 0; i < EVOLUTION_TAB_KEYS.length; i += 1) {
        const key = EVOLUTION_TAB_KEYS[i]
        const selected = tab === key
        const count = tabCounts[key]
        tabNodes.push(h('button', {
          key: key,
          type: 'button',
          role: 'tab',
          id: 'dsh-ps-evo-tab-' + key,
          className: 'dsh-ps-evo-tab',
          'data-evo-tab': key,
          'aria-selected': selected ? 'true' : 'false',
          'aria-controls': 'dsh-ps-evo-panel-' + key,
          'aria-label': tabArias[key],
          tabIndex: selected ? 0 : -1,
          onClick: function () { setTab(key) },
          onKeyDown: function (event) { onTabKeyDown(event, i) },
        },
        h('span', { className: 'dsh-ps-evo-tab-label' }, tabLabels[key]),
        count > 0 ? h('span', { className: 'dsh-ps-evo-count', 'aria-hidden': 'true' }, String(count)) : null))
      }

      // ---- tab 1: retrospective list + Markdown content
      const listNodes = []
      if (phase === 'loading' || (phase === 'idle' && retrospectives.length === 0)) {
        listNodes.push(h('div', { key: 'loading', className: 'dsh-ps-transcript-state' },
          h(Spinner), h('span', null, t('retrospectiveLoading'))))
      } else if (phase === 'error' && retrospectives.length === 0) {
        listNodes.push(h('div', { key: 'error', className: 'dsh-ps-transcript-state' },
          h('span', null, t('retrospectiveLoadFailed')),
          h('button', { type: 'button', className: 'dsh-ps-btn dsh-ps-btn-sm', onClick: refreshRetrospective }, t('retry'))))
      } else if (retrospectives.length === 0) {
        listNodes.push(h('div', { key: 'empty', className: 'dsh-ps-transcript-state' },
          h('span', null, t('retrospectiveEmpty'))))
      } else {
        for (let i = 0; i < retrospectives.length; i += 1) {
          const item = retrospectives[i]
          const isCurrent = item.date === selectedDate
          const metaChildren = []
          if (item.bytes > 0) metaChildren.push(h('span', { key: 'size' }, formatBytes(item.bytes)))
          if (item.updatedAt > 0) metaChildren.push(h('span', { key: 'time' }, formatTime(item.updatedAt)))
          listNodes.push(h('button', {
            key: item.date,
            type: 'button',
            className: 'dsh-ps-evo-item',
            'data-retro-date': item.date,
            'aria-current': isCurrent ? 'true' : 'false',
            onClick: function () { setSelectedDate(item.date) },
          },
          h('span', { className: 'dsh-ps-evo-item-date' }, item.date),
          h('span', { className: 'dsh-ps-evo-item-meta' }, metaChildren)))
        }
      }

      const selectedItem = selectedDate === null
        ? null
        : retrospectives.find(function (item) { return item.date === selectedDate }) || null
      let retroMain = null
      if (retrospectives.length === 0 && phase !== 'loading') {
        retroMain = h('div', { className: 'dsh-ps-evo-state' },
          h(IconSpark, { size: 26, className: 'dsh-ps-empty-illustration' }),
          h('span', null, t('retrospectiveEmptyHint')),
          h('div', { className: 'dsh-ps-evo-state-actions' },
            h('button', {
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-primary',
              disabled: generating,
              onClick: generate,
            }, generating ? h(Spinner) : h(IconPlay, { size: 14 }),
            h('span', null, generating ? t('retrospectiveGenerating') : t('retrospectiveNow')))))
      } else if (selectedDate === null) {
        retroMain = h('div', { className: 'dsh-ps-evo-state' }, h('span', null, t('retrospectiveSelect')))
      } else if (content.phase === 'loading') {
        retroMain = h('div', { className: 'dsh-ps-evo-state' },
          h(Spinner), h('span', null, t('retrospectiveContentLoading')))
      } else if (content.phase === 'error') {
        retroMain = h('div', { className: 'dsh-ps-evo-state' },
          h(IconAlert, { size: 22, className: 'dsh-ps-empty-illustration' }),
          h('span', null, t('retrospectiveContentFailed') + (content.error ? ' — ' + content.error : '')),
          h('button', {
            type: 'button',
            className: 'dsh-ps-btn dsh-ps-btn-sm',
            onClick: function () { setContentTick(function (value) { return value + 1 }) },
          }, t('retry')))
      } else if (content.text.trim() === '') {
        retroMain = h('div', { className: 'dsh-ps-evo-state' }, h('span', null, t('retrospectiveEmptyContent')))
      } else {
        retroMain = h('pre', { className: 'dsh-ps-evo-pre' }, content.text)
      }

      const retroPanel = h('div', { className: 'dsh-ps-evo-split' },
        h('div', { className: 'dsh-ps-evo-list', 'aria-label': t('retrospectiveTabAria', { count: retrospectives.length }) }, listNodes),
        h('div', { className: 'dsh-ps-evo-main' },
          h('div', { className: 'dsh-ps-evo-main-head' },
            h('div', { className: 'dsh-ps-evo-main-title' },
              selectedDate !== null ? selectedDate : t('retrospective'),
              selectedItem && selectedItem.bytes > 0
                ? h('span', { className: 'dsh-ps-evo-main-sub' }, ' · ' + formatBytes(selectedItem.bytes))
                : null),
            h('span', { className: 'dsh-ps-section-grow' }),
            generating
              ? h('span', { className: 'dsh-ps-evo-generating' }, h(Spinner), h('span', null, t('retrospectiveGenerating')))
              : null,
            h('button', {
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-ghost',
              'aria-label': t('retrospectiveRefresh'),
              title: t('retrospectiveRefresh'),
              disabled: phase === 'loading',
              onClick: refreshRetrospective,
            }, h(IconRefresh, { size: 14 }))),
          h('div', { className: 'dsh-ps-evo-content-wrap' }, retroMain)))

      // ---- tab 2: lessons list + add form
      const lessonCategoryOptions = []
      for (let i = 0; i < EVOLUTION_LESSON_CATEGORIES.length; i += 1) {
        const value = EVOLUTION_LESSON_CATEGORIES[i]
        lessonCategoryOptions.push(h('option', { key: value, value: value }, lessonCategoryLabel(t, value)))
      }
      const lessonScopeOptions = [
        h('option', { key: 'global', value: 'global' }, t('scopeGlobal')),
        h('option', { key: 'project', value: 'project' }, t('scopeProject')),
      ]
      const lessonNodes = []
      if (phase === 'loading' || (phase === 'idle' && lessons.length === 0)) {
        lessonNodes.push(h('div', { key: 'loading', className: 'dsh-ps-transcript-state' },
          h(Spinner), h('span', null, t('evolutionLoading'))))
      } else if (phase === 'error' && lessons.length === 0) {
        lessonNodes.push(h('div', { key: 'error', className: 'dsh-ps-transcript-state' },
          h('span', null, t('evolutionLoadFailed')),
          h('button', { type: 'button', className: 'dsh-ps-btn dsh-ps-btn-sm', onClick: refreshRetrospective }, t('retry'))))
      } else if (lessons.length === 0) {
        lessonNodes.push(h('div', { key: 'empty', className: 'dsh-ps-transcript-state' },
          h('span', null, t('lessonEmpty')),
          h('span', null, t('lessonEmptyHint'))))
      } else {
        for (let i = 0; i < lessons.length; i += 1) {
          const lesson = lessons[i]
          const confirming = confirmLessonId === lesson.id
          const toggleBusy = busy === 'lesson:' + lesson.id
          const deleteBusy = busy === 'lesson-delete:' + lesson.id
          const actions = []
          actions.push(h('button', {
            key: 'toggle',
            type: 'button',
            className: 'dsh-ps-btn dsh-ps-btn-sm',
            disabled: busy !== null,
            onClick: function () { toggleLesson(lesson) },
          }, toggleBusy ? h(Spinner) : (lesson.active ? h(IconPause, { size: 12 }) : h(IconCheck, { size: 12 })),
          h('span', null, lesson.active ? t('lessonDisable') : t('lessonEnable'))))
          if (confirming) {
            actions.push(h('span', { key: 'prompt', className: 'dsh-ps-evo-confirm' }, t('lessonDeleteConfirm')))
            actions.push(h('button', {
              key: 'confirm',
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-danger',
              disabled: busy !== null,
              onClick: function () { deleteLesson(lesson) },
            }, deleteBusy ? h(Spinner) : h(IconCheck, { size: 12 }), h('span', null, t('delete'))))
            actions.push(h('button', {
              key: 'cancel',
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-ghost',
              disabled: busy !== null,
              onClick: function () { setConfirmLessonId(null) },
            }, h('span', null, t('cancel'))))
          } else {
            actions.push(h('button', {
              key: 'delete',
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-danger',
              disabled: busy !== null,
              'aria-label': t('lessonDelete'),
              title: t('lessonDelete'),
              onClick: function () { setConfirmLessonId(lesson.id) },
            }, h(IconTrash, { size: 12 }), h('span', null, t('delete'))))
          }
          lessonNodes.push(h('div', {
            key: lesson.id || 'lesson-' + i,
            className: 'dsh-ps-evo-card',
            'data-inactive': lesson.active ? 'false' : 'true',
            'data-lesson-id': lesson.id || undefined,
          },
          h('div', { className: 'dsh-ps-evo-card-head' },
            h('div', { className: 'dsh-ps-evo-card-title' },
              h('p', { className: 'dsh-ps-evo-text' }, lesson.text))),
          h('div', { className: 'dsh-ps-evo-chips' },
            h('span', { className: 'dsh-ps-evo-status', 'data-status': lesson.active ? 'active' : 'disabled' },
              lesson.active ? t('lessonActive') : t('lessonInactive')),
            h('span', { className: 'dsh-ps-chip' }, lessonCategoryLabel(t, lesson.category)),
            h('span', { className: 'dsh-ps-chip' },
              evolutionScopeLabel(t, lesson.scope) + (lesson.project ? ' · ' + shortenPath(lesson.project) : '')),
            h('span', { className: 'dsh-ps-chip' }, lessonSourceLabel(t, lesson.source)),
            lesson.evidence
              ? h('span', { className: 'dsh-ps-chip' }, t('lessonEvidence') + ' · ' + lesson.evidence)
              : null),
          h('div', { className: 'dsh-ps-evo-actions' }, actions)))
        }
      }

      const lessonsPanel = h('div', { className: 'dsh-ps-evo-scroll' },
        h('form', {
          className: 'dsh-ps-evo-form',
          onSubmit: function (event) {
            event.preventDefault()
            submitLesson()
          },
        },
        h('div', { className: 'dsh-ps-evo-form-head' },
          h('span', { className: 'dsh-ps-evo-form-title' },
            h(IconPlus, { size: 14 }), h('span', null, t('lessonAdd'))),
          h('span', { className: 'dsh-ps-evo-form-hint' }, t('lessonFormHint'))),
        h('div', { className: 'dsh-ps-evo-form-grid' },
          h('div', { className: 'dsh-ps-evo-span' },
            h(Field, { label: t('lessonText'), htmlFor: 'dsh-ps-evo-lesson-text', error: lessonError },
              h('input', {
                id: 'dsh-ps-evo-lesson-text',
                className: 'dsh-ps-input',
                type: 'text',
                value: lessonText,
                maxLength: MAX_LESSON_LENGTH,
                placeholder: t('lessonTextPlaceholder'),
                spellCheck: false,
                disabled: busy !== null,
                'aria-invalid': lessonError ? 'true' : 'false',
                onChange: function (event) {
                  setLessonText(event.target.value)
                  if (lessonError !== null) setLessonError(null)
                },
              }))),
          h(Field, { label: t('lessonCategory'), htmlFor: 'dsh-ps-evo-lesson-category' },
            h('select', {
              id: 'dsh-ps-evo-lesson-category',
              className: 'dsh-ps-select',
              value: lessonCategory,
              disabled: busy !== null,
              onChange: function (event) { setLessonCategory(event.target.value) },
            }, lessonCategoryOptions)),
          h(Field, { label: t('lessonScope'), htmlFor: 'dsh-ps-evo-lesson-scope' },
            h('select', {
              id: 'dsh-ps-evo-lesson-scope',
              className: 'dsh-ps-select',
              value: lessonScope,
              disabled: busy !== null,
              onChange: function (event) { setLessonScope(event.target.value) },
            }, lessonScopeOptions))),
        lessonScope === 'project'
          ? h('div', { className: 'dsh-ps-evo-span' },
            h(Field, { label: t('lessonProject'), htmlFor: 'dsh-ps-evo-lesson-project' },
              h('div', { className: 'dsh-ps-dir-row' },
                h('input', {
                  id: 'dsh-ps-evo-lesson-project',
                  className: 'dsh-ps-input',
                  type: 'text',
                  value: lessonProject,
                  placeholder: t('fieldCwdPlaceholder'),
                  spellCheck: false,
                  disabled: busy !== null,
                  onChange: function (event) { setLessonProject(event.target.value) },
                }),
                h('button', {
                  type: 'button',
                  className: 'dsh-ps-btn',
                  disabled: busy !== null || pickingLessonDir,
                  'aria-label': t('chooseDirectory'),
                  title: t('chooseDirectory'),
                  onClick: pickLessonDirectory,
                }, pickingLessonDir ? h(Spinner) : h(IconFolder, { size: 15 })))))
          : null,
        h('div', { className: 'dsh-ps-evo-form-actions' },
          h('button', {
            type: 'submit',
            className: 'dsh-ps-btn dsh-ps-btn-primary dsh-ps-btn-sm',
            disabled: busy !== null,
          }, busy === 'lesson-add' ? h(Spinner) : h(IconPlus, { size: 13 }),
          h('span', null, t('lessonAdd'))))),
        lessonNodes)

      // ---- tab 3: skill candidates / active skills
      const skillMode = settingsForStatus && settingsForStatus.skillMode ? settingsForStatus.skillMode : 'ask'
      const skillNotices = []
      skillNotices.push(h('div', { key: 'explainer', className: 'dsh-ps-evo-notice' },
        h(IconLayers, { size: 14, className: 'dsh-ps-evo-notice-icon' }),
        h('span', null, t('skillsExplainer'))))
      if (skillMode === 'off') {
        skillNotices.push(h('div', { key: 'mode-off', className: 'dsh-ps-evo-notice', 'data-tone': 'warn', role: 'status' },
          h(IconAlert, { size: 14, className: 'dsh-ps-evo-notice-icon' }),
          h('span', null, t('skillModeOff') + ' — ' + t('skillModeOffHint'))))
      }
      if (data.skillsAvailable === false) {
        skillNotices.push(h('div', { key: 'unavailable', className: 'dsh-ps-evo-notice', 'data-tone': 'warn', role: 'alert' },
          h(IconAlert, { size: 14, className: 'dsh-ps-evo-notice-icon' }),
          h('span', null, t('skillsUnavailable'))))
      }

      const skillNodes = []
      if (phase === 'loading' || (phase === 'idle' && skills.length === 0)) {
        skillNodes.push(h('div', { key: 'loading', className: 'dsh-ps-transcript-state' },
          h(Spinner), h('span', null, t('evolutionLoading'))))
      } else if (phase === 'error' && skills.length === 0) {
        skillNodes.push(h('div', { key: 'error', className: 'dsh-ps-transcript-state' },
          h('span', null, t('evolutionLoadFailed')),
          h('button', { type: 'button', className: 'dsh-ps-btn dsh-ps-btn-sm', onClick: refreshRetrospective }, t('retry'))))
      } else if (skills.length === 0) {
        skillNodes.push(h('div', { key: 'empty', className: 'dsh-ps-transcript-state' },
          h('span', null, t('skillEmpty')),
          h('span', null, t('skillEmptyHint'))))
      } else {
        for (let i = 0; i < skills.length; i += 1) {
          const skill = skills[i]
          const expanded = expandedSkill === skill.name
          const contentState = skillContents[skill.name] || null
          const confirming = confirmSkillName === skill.name
          const actions = []
          actions.push(h('button', {
            key: 'view',
            type: 'button',
            className: 'dsh-ps-btn dsh-ps-btn-sm',
            'aria-label': t('skillViewAria', { name: skill.name }),
            'aria-expanded': expanded ? 'true' : 'false',
            onClick: function () { toggleSkillContent(skill) },
          }, h(IconEye, { size: 12 }), h('span', null, expanded ? t('skillHide') : t('skillView'))))
          if (skill.status === 'proposed') {
            actions.push(h('button', {
              key: 'adopt',
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-primary',
              disabled: busy !== null,
              title: t('skillProposedHint'),
              onClick: function () { runSkillAction(skill, 'adopt') },
            }, busy === 'skill:' + skill.name + ':adopt' ? h(Spinner) : h(IconCheck, { size: 12 }),
            h('span', null, t('skillAdopt'))))
          }
          if (skill.status === 'disabled') {
            actions.push(h('button', {
              key: 'enable',
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm',
              disabled: busy !== null,
              onClick: function () { runSkillAction(skill, 'enable') },
            }, busy === 'skill:' + skill.name + ':enable' ? h(Spinner) : h(IconPlay, { size: 12 }),
            h('span', null, t('skillEnable'))))
          } else {
            actions.push(h('button', {
              key: 'disable',
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm',
              disabled: busy !== null,
              onClick: function () { runSkillAction(skill, 'disable') },
            }, busy === 'skill:' + skill.name + ':disable' ? h(Spinner) : h(IconPause, { size: 12 }),
            h('span', null, t('skillDisable'))))
          }
          if (confirming) {
            actions.push(h('span', { key: 'prompt', className: 'dsh-ps-evo-confirm' }, t('skillDeleteConfirm')))
            actions.push(h('button', {
              key: 'confirm',
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-danger',
              disabled: busy !== null,
              onClick: function () { runSkillAction(skill, 'delete') },
            }, busy === 'skill:' + skill.name + ':delete' ? h(Spinner) : h(IconCheck, { size: 12 }),
            h('span', null, t('delete'))))
            actions.push(h('button', {
              key: 'cancel',
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-ghost',
              disabled: busy !== null,
              onClick: function () { setConfirmSkillName(null) },
            }, h('span', null, t('cancel'))))
          } else {
            actions.push(h('button', {
              key: 'delete',
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-danger',
              disabled: busy !== null,
              'aria-label': t('skillDelete'),
              title: t('skillDelete'),
              onClick: function () { setConfirmSkillName(skill.name) },
            }, h(IconTrash, { size: 12 }), h('span', null, t('delete'))))
          }
          let contentNode = null
          if (expanded) {
            if (contentState === null || contentState.phase === 'loading') {
              contentNode = h('div', { className: 'dsh-ps-transcript-state' },
                h(Spinner), h('span', null, t('skillContentLoading')))
            } else if (contentState.phase === 'error') {
              contentNode = h('div', { className: 'dsh-ps-transcript-state' },
                h('span', null, t('skillContentFailed') + (contentState.error ? ' — ' + contentState.error : '')))
            } else if (contentState.text.trim() === '') {
              contentNode = h('div', { className: 'dsh-ps-transcript-state' }, h('span', null, t('skillContentEmpty')))
            } else {
              contentNode = h('pre', { className: 'dsh-ps-evo-skill-content' }, contentState.text)
            }
          }
          skillNodes.push(h('div', {
            key: skill.name,
            className: 'dsh-ps-evo-card',
            'data-skill-name': skill.name,
          },
          h('div', { className: 'dsh-ps-evo-card-head' },
            h('div', { className: 'dsh-ps-evo-card-title' },
              h('span', { className: 'dsh-ps-evo-name' }, skill.name)),
            h('span', { className: 'dsh-ps-evo-status', 'data-status': skill.status },
              skillStatusLabel(t, skill.status))),
          skill.description ? h('p', { className: 'dsh-ps-evo-text' }, skill.description) : null,
          skill.whenToUse
            ? h('p', { className: 'dsh-ps-evo-evidence' }, t('skillWhenToUse') + ' · ' + skill.whenToUse)
            : null,
          h('div', { className: 'dsh-ps-evo-chips' },
            h('span', { className: 'dsh-ps-chip' },
              evolutionScopeLabel(t, skill.scope) + (skill.project ? ' · ' + shortenPath(skill.project) : '')),
            h('span', { className: 'dsh-ps-chip' }, skillSourceLabel(t, skill.source)),
            skill.evidence
              ? h('span', { className: 'dsh-ps-chip' }, t('skillEvidence') + ' · ' + skill.evidence)
              : null),
          h('div', { className: 'dsh-ps-evo-actions' }, actions),
          contentNode))
        }
      }

      const skillsPanel = h('div', { className: 'dsh-ps-evo-scroll' }, skillNotices, skillNodes)

      let panelContent = retroPanel
      if (tab === 'lessons') panelContent = lessonsPanel
      else if (tab === 'skills') panelContent = skillsPanel

      const headStatus = settingsForStatus
      const headNode = h('div', { className: 'dsh-ps-drawer-head' },
        h('span', {
          className: 'dsh-ps-drawer-avatar',
          'data-status': generating ? 'running' : 'done',
          'aria-hidden': 'true',
        }, generating ? h(Spinner) : h(IconSpark, { size: 20 })),
        h('div', { className: 'dsh-ps-drawer-titles' },
          h('h2', { className: 'dsh-ps-drawer-title', id: 'dsh-ps-evo-title' }, t('evolutionTitle')),
          h('div', { className: 'dsh-ps-drawer-badges' },
            h('span', { className: 'dsh-ps-section-hint' }, t('evolutionSub')),
            h('span', { className: 'dsh-ps-evo-status', 'data-status': evolutionStatusTone(headStatus) },
              evolutionStatusText(t, headStatus)),
            headStatus && headStatus.lastDate
              ? h('span', { className: 'dsh-ps-evo-status', 'data-status': 'idle' },
                t('evolutionLast') + ' · ' + headStatus.lastDate)
              : null,
            headStatus && headStatus.lastError
              ? h('span', {
                className: 'dsh-ps-evo-status',
                'data-status': 'failed',
                title: headStatus.lastError,
              }, t('retrospectiveError'))
              : null,
            generating
              ? h('span', { className: 'dsh-ps-evo-generating' }, h(Spinner), h('span', null, t('evolutionGenerating')))
              : null)),
        h('div', { className: 'dsh-ps-evo-head-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-ps-btn dsh-ps-btn-primary',
            disabled: generating,
            onClick: generate,
          }, generating ? h(Spinner) : h(IconPlay, { size: 14 }),
          h('span', null, generating ? t('retrospectiveGenerating') : t('retrospectiveNow'))),
          h('button', {
            type: 'button',
            ref: closeBtnRef,
            className: 'dsh-ps-btn dsh-ps-btn-ghost dsh-ps-btn-icon',
            'aria-label': t('close'),
            title: t('close'),
            onClick: props.onClose,
          }, h(IconClose, { size: 16 }))))

      const lastErrorNode = headStatus && headStatus.lastError
        ? h('div', {
          className: 'dsh-ps-inline-error',
          role: 'alert',
          style: { padding: '8px 18px 0' },
        }, t('retrospectiveError') + ' — ' + headStatus.lastError)
        : null

      if (embedded) {
        return h('div', { className: 'dsh-ps-review-embedded' },
          h('div', { className: 'dsh-ps-review-toolbar' },
            h('span', { className: 'dsh-ps-review-toolbar-status' },
              h('span', { className: 'dsh-ps-report-status-chip', 'data-tone': evolutionStatusTone(headStatus) },
                generating ? h(Spinner) : null,
                h('span', null, generating ? t('evolutionGenerating') : evolutionStatusText(t, headStatus))),
              headStatus && headStatus.lastDate
                ? h('span', null, t('evolutionLast') + ' · ' + headStatus.lastDate)
                : null),
            h('span', { className: 'dsh-ps-review-toolbar-grow' }),
            h('button', {
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-primary',
              disabled: generating,
              onClick: generate,
            }, generating ? h(Spinner) : h(IconPlay, { size: 13 }),
            h('span', null, generating ? t('retrospectiveGenerating') : t('retrospectiveNow'))),
            h('button', {
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm dsh-ps-btn-ghost',
              'aria-label': t('retrospectiveRefresh'),
              title: t('retrospectiveRefresh'),
              disabled: phase === 'loading',
              onClick: refreshRetrospective,
            }, h(IconRefresh, { size: 14 }))),
          inlineError
            ? h('div', { className: 'dsh-ps-inline-error', role: 'alert', style: { padding: '8px 20px 0' } }, inlineError)
            : null,
          lastErrorNode,
          h('div', {
            className: 'dsh-ps-evo-panel',
            role: 'tabpanel',
            tabIndex: 0,
          }, panelContent))
      }

      return h('div', { className: 'dsh-ps-drawer-layer' },
        h('div', { className: 'dsh-ps-drawer-mask', 'aria-hidden': 'true', onClick: props.onClose }),
        h('div', {
          className: 'dsh-ps-drawer dsh-ps-evo-drawer',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'dsh-ps-evo-title',
          ref: dialogRef,
          tabIndex: -1,
        },
        headNode,
        inlineError
          ? h('div', { className: 'dsh-ps-inline-error', role: 'alert', style: { padding: '8px 18px 0' } }, inlineError)
          : null,
        lastErrorNode,
        h('div', { className: 'dsh-ps-evo-tabs', role: 'tablist', 'aria-label': t('evolution') }, tabNodes),
        h('div', {
          className: 'dsh-ps-evo-panel',
          role: 'tabpanel',
          id: 'dsh-ps-evo-panel-' + tab,
          'aria-labelledby': 'dsh-ps-evo-tab-' + tab,
          tabIndex: 0,
        }, panelContent)))
    }

    // ------------------------------------------------------------------ review drawer (v0.7)

    // One merged drawer: 日志 / 复盘 / 经验 / 技能. The journal tab embeds the
    // work-log list (ReportsDrawer in embedded mode), the other three tabs embed
    // the retrospective panels (EvolutionDrawer in embedded mode) so all the
    // existing generate / adopt / lesson actions keep working unchanged.
    function ReviewDrawer(props) {
      const t = props.t
      const store = props.store
      const snap = useStoreSnapshot(store)
      const initialTab = REVIEW_TAB_KEYS.indexOf(props.initialTab) >= 0 ? props.initialTab : 'journal'
      const [tab, setTab] = React.useState(initialTab)
      const dialogRef = React.useRef(null)
      const closeBtnRef = React.useRef(null)
      useDialogA11y(dialogRef, props.onClose, true, closeBtnRef)
      const proposed = snap.evolution ? snap.evolution.proposedSkillCount : 0
      const labels = { journal: t('journalTab'), retrospective: t('tabRetro'), lessons: t('tabLessons'), skills: t('tabSkills') }
      const tabIds = {}
      for (let i = 0; i < REVIEW_TAB_KEYS.length; i += 1) tabIds[REVIEW_TAB_KEYS[i]] = 'dsh-ps-review-tab-' + REVIEW_TAB_KEYS[i]

      function switchTab(next) {
        setTab(next)
      }

      function onTabKeyDown(event, index) {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
        event.preventDefault()
        const delta = event.key === 'ArrowRight' ? 1 : -1
        switchTab(REVIEW_TAB_KEYS[(index + delta + REVIEW_TAB_KEYS.length) % REVIEW_TAB_KEYS.length])
      }

      const tabNodes = []
      for (let i = 0; i < REVIEW_TAB_KEYS.length; i += 1) {
        const key = REVIEW_TAB_KEYS[i]
        const selected = tab === key
        tabNodes.push(h('button', {
          key: key,
          type: 'button',
          role: 'tab',
          id: tabIds[key],
          className: 'dsh-ps-review-tab',
          'aria-selected': selected ? 'true' : 'false',
          'aria-controls': 'dsh-ps-review-panel',
          'data-review-tab': key,
          tabIndex: selected ? 0 : -1,
          onClick: function () { setTab(key) },
          onKeyDown: function (event) { onTabKeyDown(event, i) },
        },
        h('span', null, labels[key]),
        key === 'skills' && proposed > 0
          ? h('span', { className: 'dsh-ps-review-count', 'aria-hidden': 'true' }, proposed > 9 ? '9+' : String(proposed))
          : null))
      }

      let panel = null
      if (tab === 'journal') {
        panel = h(ReportsDrawer, {
          key: 'journal',
          embedded: true,
          ctx: props.ctx,
          store: store,
          t: t,
          addToast: props.addToast,
          onClose: props.onClose,
        })
      } else {
        panel = h(EvolutionDrawer, {
          key: tab,
          embedded: true,
          embeddedTab: tab,
          ctx: props.ctx,
          store: store,
          t: t,
          addToast: props.addToast,
          onClose: props.onClose,
        })
      }

      return h('div', { className: 'dsh-ps-drawer-layer' },
        h('div', { className: 'dsh-ps-drawer-mask', 'aria-hidden': 'true', onClick: props.onClose }),
        h('div', {
          className: 'dsh-ps-drawer dsh-ps-review-drawer',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'dsh-ps-review-title',
          ref: dialogRef,
          tabIndex: -1,
        },
        h('div', { className: 'dsh-ps-drawer-head' },
          h('span', { className: 'dsh-ps-drawer-avatar', 'data-status': 'done', 'aria-hidden': 'true' },
            h(IconCalendar, { size: 20 })),
          h('div', { className: 'dsh-ps-drawer-titles' },
            h('h2', { className: 'dsh-ps-drawer-title', id: 'dsh-ps-review-title' }, t('review')),
            h('div', { className: 'dsh-ps-drawer-badges' },
              h('span', { className: 'dsh-ps-section-hint' }, t('reviewSub')))),
          h('button', {
            type: 'button',
            ref: closeBtnRef,
            className: 'dsh-ps-btn dsh-ps-btn-ghost dsh-ps-btn-icon',
            'aria-label': t('close'),
            title: t('close'),
            onClick: props.onClose,
          }, h(IconClose, { size: 16 }))),
        h('div', { className: 'dsh-ps-review-tabs', role: 'tablist', 'aria-label': t('review') }, tabNodes),
        h('div', {
          className: 'dsh-ps-review-body',
          role: 'tabpanel',
          id: 'dsh-ps-review-panel',
          'aria-labelledby': tabIds[tab],
          tabIndex: 0,
        }, panel)))
    }

    // ------------------------------------------------------------------ board

    function reorderPendingIds(tasks, dragId, targetId, edge) {
      const ids = tasks.map(function (task) { return task.id })
      const pendingIds = tasks.filter(function (task) { return task.status === 'pending' }).map(function (task) { return task.id })
      if (pendingIds.indexOf(dragId) < 0) return null
      const rest = pendingIds.filter(function (id) { return id !== dragId })
      let index = rest.length
      if (targetId) {
        const anchor = rest.indexOf(targetId)
        if (anchor < 0) return null
        index = edge === 'after' ? anchor + 1 : anchor
      }
      rest.splice(index, 0, dragId)
      let cursor = 0
      const next = []
      for (let i = 0; i < ids.length; i += 1) {
        if (pendingIds.indexOf(ids[i]) >= 0) {
          next.push(rest[cursor])
          cursor += 1
        } else {
          next.push(ids[i])
        }
      }
      return next
    }

    // ---- per-column filter state (v6): every column owns its own search term
    // and its own status/priority/group/source filters; nothing is global.

    function emptyColumnFilter() {
      return { status: 'all', priority: 'all', source: 'all', open: false }
    }

    function createColumnFilterState() {
      const state = {}
      for (let i = 0; i < COLUMN_KEYS.length; i += 1) state[COLUMN_KEYS[i]] = emptyColumnFilter()
      return state
    }

    function isColumnFilterActive(filter) {
      if (!filter || typeof filter !== 'object') return false
      return filter.status !== 'all' || filter.priority !== 'all' || filter.source !== 'all'
    }

    function isColumnFilterMenuActive(filter) {
      if (!filter || typeof filter !== 'object') return false
      return filter.status !== 'all' || filter.priority !== 'all' || filter.source !== 'all'
    }

    function columnHasStatusFilter(columnKey) {
      return Boolean(COLUMN_STATUS_FILTERS[columnKey])
    }

    // Imported DSH sessions only ever land in running/done, so the idea and
    // pending columns must disable the "DSH session" source option.
    function columnAcceptsSession(columnKey) {
      return columnKey === 'claimed' || columnKey === 'ended'
    }

    function matchesColumnFilter(task, filter, columnKey) {
      if (!task || !filter || typeof filter !== 'object') return true
      if (columnHasStatusFilter(columnKey) && filter.status !== 'all' && task.status !== filter.status) return false
      if (filter.priority !== 'all' && normalizePriority(task.priority) !== filter.priority) return false
      if (filter.source !== 'all') {
        if (filter.source === 'session' && task.source !== 'session') return false
        if (filter.source === 'queue' && task.source === 'session') return false
      }
      return true
    }

    function filterTasksForColumn(sourceTasks, filter, columnKey) {
      const list = Array.isArray(sourceTasks) ? sourceTasks : []
      if (!isColumnFilterActive(filter)) return list.slice()
      return list.filter(function (task) { return matchesColumnFilter(task, filter, columnKey) })
    }

    function Board(props) {
      const ctx = props.ctx
      const store = props.store
      const t = props.t
      const snap = useStoreSnapshot(store)
      const tasks = snap.tasks
      const settings = snap.settings
      const reportSettings = snap.reports.settings || (settings ? settings.dailyReport : null)
      const reportGenerating = reportSettings ? (reportSettings.lastStatus === 'running' || Boolean(reportSettings.generatingDate)) : false
      const proposedSkillCount = snap.evolution ? snap.evolution.proposedSkillCount : 0
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [publishOpen, setPublishOpen] = React.useState(false)
      const [publishCwd, setPublishCwd] = React.useState('')
      const [publishMode, setPublishMode] = React.useState('single')
      const [reviewOpen, setReviewOpen] = React.useState(false)
      const [reviewTab, setReviewTab] = React.useState('journal')
      const reviewButtonRef = React.useRef(null)
      const reviewWasOpenRef = React.useRef(false)
      const [selectedId, setSelectedId] = React.useState(null)
      const [editingId, setEditingId] = React.useState(null)
      const [dragId, setDragId] = React.useState(null)
      const [dropCell, setDropCell] = React.useState(null)
      const [lastDir, setLastDir] = React.useState('')
      const [autoBusy, setAutoBusy] = React.useState(false)
      const [reorderBusy, setReorderBusy] = React.useState(false)
      const [busyAction, setBusyAction] = React.useState(null)
      const [view, setView] = React.useState('today')
      const [briefsOpen, setBriefsOpen] = React.useState(false)
      const [notifOpen, setNotifOpen] = React.useState(false)
      const [webhookLogOpen, setWebhookLogOpen] = React.useState(false)
      const [globalQuery, setGlobalQuery] = React.useState('')
      const [lastSeen, setLastSeen] = React.useState(readLastSeenTime)
      const [captureBusy, setCaptureBusy] = React.useState(false)
      const [focusChatId, setFocusChatId] = React.useState(null)
      const [columnFilters, setColumnFilters] = React.useState(createColumnFilterState)
      const funnelRefs = React.useRef(null)
      if (funnelRefs.current === null) {
        funnelRefs.current = {
          idea: React.createRef(),
          pending: React.createRef(),
          claimed: React.createRef(),
          ended: React.createRef(),
        }
      }
      const activeTimer = view === 'today' || snap.runningCount > 0 || tasks.some(function (task) { return task.status === 'blocked' })
      const now = useNow(activeTimer)
      const suppressClickRef = React.useRef(false)
      const dragCleanupRef = React.useRef(null)
      const notifyRef = React.useRef({ ready: false, running: 0, done: 0, failed: 0 })
      const toastsState = useToasts()
      const addToast = toastsState.addToast
      const notifyOnDone = !settings || settings.notifyOnDone !== false

      React.useEffect(function () {
        if (!settingsOpen) return
        if (snap.modelsPhase === 'idle') store.loadModels(false)
      }, [settingsOpen, snap.modelsPhase, store])

      // v0.6: the briefs card needs the compact meta once; the Host only ships
      // it with /state on v0.6+, so old snapshots stay in unsupported fallback.
      React.useEffect(function () {
        if (view !== 'today') return
        const briefs = snap.briefs
        if (!briefs || briefs.supported === false) return
        if (briefs.phase === 'idle') void store.refreshBriefs()
      }, [view, snap.briefs ? snap.briefs.phase : 'idle', snap.briefs ? snap.briefs.supported : true, store])

      // Restore focus to the header entry when the merged review drawer closes.
      React.useEffect(function () {
        if (reviewOpen) {
          reviewWasOpenRef.current = true
          return
        }
        if (!reviewWasOpenRef.current) return
        reviewWasOpenRef.current = false
        const node = reviewButtonRef.current
        if (node && typeof node.focus === 'function') {
          try { node.focus() } catch (error) { /* focus is progressive enhancement */ }
        }
      }, [reviewOpen])

      React.useEffect(function () {
        if (selectedId === null) return
        const present = tasks.some(function (task) { return task.id === selectedId })
        if (!present) setSelectedId(null)
      }, [selectedId, tasks])

      React.useEffect(function () {
        if (editingId === null) return
        const present = tasks.some(function (task) { return task.id === editingId })
        if (!present) setEditingId(null)
      }, [editingId, tasks])

      React.useEffect(function () {
        return function () {
          if (dragCleanupRef.current) clearTimeout(dragCleanupRef.current)
        }
      }, [])

      React.useEffect(function () {
        const previous = notifyRef.current
        if (snap.phase !== 'ready') return
        if (previous.ready && previous.running > 0 && snap.runningCount === 0) {
          const finished = (snap.counts.done + snap.counts.failed) - (previous.done + previous.failed)
          if (finished > 0 && notifyOnDone) {
            const doneCount = Math.max(0, snap.counts.done - previous.done)
            const failedCount = Math.max(0, snap.counts.failed - previous.failed)
            let delivered = false
            try {
              if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                try {
                  new Notification(t('notifyTitle'), { body: t('notifyBody', { done: doneCount, failed: failedCount }) })
                  delivered = true
                } catch (error) {
                  delivered = false
                }
              }
            } catch (error) {
              delivered = false
            }
            if (!delivered) {
              addToast(t('notifyToast', { done: doneCount, failed: failedCount }), failedCount > 0 ? 'info' : 'success')
            }
          }
        }
        notifyRef.current = { ready: true, running: snap.runningCount, done: snap.counts.done, failed: snap.counts.failed }
      }, [snap.phase, snap.runningCount, snap.counts.done, snap.counts.failed, notifyOnDone, t, addToast])

      const reportGenerationRef = React.useRef({ ready: false, generating: false, status: 'idle' })
      React.useEffect(function () {
        const status = reportSettings ? reportSettings.lastStatus : 'idle'
        const previous = reportGenerationRef.current
        const current = { ready: true, generating: reportGenerating, status: status }
        reportGenerationRef.current = current
        if (!previous.ready) return
        if (previous.generating && !current.generating) {
          void store.refreshReports()
          if (status === 'ok') addToast(t('reportGenerated'), 'success')
          else if (status === 'failed') addToast(t('reportGenerateFailed'), 'error')
        }
      }, [reportGenerating, reportSettings ? reportSettings.lastStatus : 'idle', store, t, addToast])

      const taskById = new Map()
      for (let i = 0; i < tasks.length; i += 1) taskById.set(tasks[i].id, tasks[i])
      const titleById = new Map()
      for (let i = 0; i < tasks.length; i += 1) titleById.set(tasks[i].id, tasks[i].title)
      const dragTask = dragId === null ? null : (taskById.get(dragId) || null)

      function openPublish(nextMode) {
        const guess = lastDir !== '' ? lastDir : guessDefaultDirectory(ctx)
        setPublishCwd(guess)
        setPublishMode(nextMode === 'batch' ? 'batch' : 'single')
        setPublishOpen(true)
      }

      function toggleAutoStart() {
        if (!settings || autoBusy) return
        setAutoBusy(true)
        store.saveSettings({ autoStart: settings.autoStart !== true }).then(function () { setAutoBusy(false) })
      }

      // One-line capture: title + prompt, status idea. The Host needs an
      // absolute cwd, so fall back to the last used / guessed workspace folder.
      function captureTask(title) {
        const text = typeof title === 'string' ? title.trim() : ''
        if (text === '') return Promise.resolve({ ok: false, error: null })
        if (captureBusy) return Promise.resolve({ ok: false, error: null })
        const guess = lastDir !== '' ? lastDir : guessDefaultDirectory(ctx)
        if (!isAbsolutePath(guess)) {
          const message = t('captureNoCwd')
          addToast(message, 'error')
          return Promise.resolve({ ok: false, error: message })
        }
        setCaptureBusy(true)
        return store.publish({
          title: text,
          prompt: text,
          cwd: guess,
          status: 'idea',
          priority: 'normal',
        }).then(function (result) {
          setCaptureBusy(false)
          if (result.ok) {
            setLastDir(guess)
            addToast(t('captureSaved'), 'success')
            void store.refresh()
          } else if (result.error) {
            addToast(result.error, 'error')
          }
          return result
        }, function (error) {
          setCaptureBusy(false)
          addToast(t('publishFailed') + ' — ' + (error && error.message ? error.message : t('unknownError')), 'error')
          return { ok: false, error: null }
        })
      }

      function generateBriefNow(day) {
        if (briefGenerating) return
        store.generateBrief(day).then(function (result) {
          if (!result.ok) {
            if (result.error) addToast(result.error, 'error')
            return
          }
          addToast(t('briefGenerating'), 'info')
          void store.refreshBriefs()
        })
      }

      function openCard(id) {
        if (suppressClickRef.current) return
        setFocusChatId(null)
        setSelectedId(id)
      }

      function openTaskChat(task) {
        if (!task) return
        setNotifOpen(false)
        setFocusChatId(task.id)
        setSelectedId(task.id)
      }

      function openReview(tab) {
        const known = ['journal', 'retrospective', 'lessons', 'skills']
        setReviewTab(known.indexOf(tab) >= 0 ? tab : 'journal')
        setReviewOpen(true)
        setNotifOpen(false)
      }

      // "今天建议" → create a queued task with the suggestion title/prompt.
      function joinSuggestion(suggestion) {
        const item = suggestion && typeof suggestion === 'object' ? suggestion : null
        if (!item || typeof item.title !== 'string' || item.title.trim() === '') {
          return Promise.resolve({ ok: false, error: null })
        }
        const guess = lastDir !== '' ? lastDir : guessDefaultDirectory(ctx)
        if (!isAbsolutePath(guess)) {
          const message = t('captureNoCwd')
          addToast(message, 'error')
          return Promise.resolve({ ok: false, error: message })
        }
        return store.publish({
          title: item.title,
          prompt: typeof item.prompt === 'string' && item.prompt !== '' ? item.prompt : item.title,
          cwd: guess,
          status: 'pending',
          priority: normalizePriority(item.priority),
        }).then(function (result) {
          if (result.ok) {
            setLastDir(guess)
            addToast(t('briefJoined', { title: item.title }), 'success')
            void store.refresh()
          } else if (result.error) {
            addToast(result.error, 'error')
          }
          return result
        }, function (error) {
          addToast(t('publishFailed') + ' — ' + (error && error.message ? error.message : t('unknownError')), 'error')
          return { ok: false, error: null }
        })
      }

      function markNotificationsRead() {
        const stamp = Date.now()
        setLastSeen(stamp)
        writeLastSeenTime(stamp)
      }

      function openSession(task) {
        if (!task || task.sessionId === '') {
          store.reportError(t('openSessionFailed'))
          return
        }
        try {
          if (ctx && ctx.uiWorkspace && typeof ctx.uiWorkspace.openSession === 'function') {
            ctx.uiWorkspace.openSession(task.sessionId)
          }
          if (ctx && ctx.layout && typeof ctx.layout.selectPanel === 'function') {
            ctx.layout.selectPanel('conversation')
          }
        } catch (error) {
          store.reportError(t('openSessionFailed') + ' — ' + (error && error.message ? error.message : t('unknownError')))
        }
      }

      function openEdit(task) {
        if (!task) return
        if (task.status === 'running' || task.source === 'session') {
          addToast(t('editRunning'), 'error')
          return
        }
        setSelectedId(null)
        setEditingId(task.id)
      }

      function actionToast(action, task) {
        if (action === 'run') addToast(t('runStarted', { title: task.title }), 'success')
        else if (action === 'pause') addToast(t('pausedToast', { title: task.title }), 'info')
        else if (action === 'resume') addToast(t('resumedToast', { title: task.title }), 'success')
        else if (action === 'interrupt') addToast(t('interruptedToast', { title: task.title }), 'info')
        else if (action === 'retry') addToast(t('retriedToast', { title: task.title }), 'success')
        else if (action === 'promote') addToast(t('promotedToast', { title: task.title }), 'success')
        else if (action === 'demote') addToast(t('demotedToast', { title: task.title }), 'info')
      }

      function runCardAction(task, action) {
        if (!task || busyAction !== null) return
        if (action === 'run-next') {
          if (reorderBusy) return
          setBusyAction(task.id + ':run-next')
          store.act(task.id, action).then(function (result) {
            setBusyAction(null)
            if (result.ok) void store.refresh()
          })
          return
        }
        setBusyAction(task.id + ':' + action)
        store.act(task.id, action).then(function (result) {
          setBusyAction(null)
          if (!result.ok) return
          actionToast(action, task)
          if (action === 'delete' && selectedId === task.id) setSelectedId(null)
        })
      }

      function runCrossColumnAction(task, action) {
        if (!task || busyAction !== null) return
        setBusyAction(task.id + ':' + action)
        store.act(task.id, action).then(function (result) {
          setBusyAction(null)
          if (!result.ok) return
          actionToast(action, task)
        })
      }

      function saveReorder(nextIds) {
        if (reorderBusy) return Promise.resolve()
        if (!nextIds) return Promise.resolve()
        const currentIds = tasks.map(function (task) { return task.id })
        if (nextIds.join('|') === currentIds.join('|')) return Promise.resolve()
        setReorderBusy(true)
        return store.reorder(nextIds).then(function () { setReorderBusy(false) })
      }

      function movePendingTask(id, delta) {
        if (reorderBusy) return Promise.resolve()
        const pending = tasks.filter(function (task) { return task.status === 'pending' })
        const from = pending.findIndex(function (task) { return task.id === id })
        const to = from + delta
        if (from < 0 || to < 0 || to >= pending.length) return Promise.resolve()
        const target = pending[to]
        return saveReorder(reorderPendingIds(tasks, id, target.id, delta > 0 ? 'after' : 'before'))
      }

      function finishDrag() {
        setDragId(null)
        setDropCell(null)
        if (dragCleanupRef.current) clearTimeout(dragCleanupRef.current)
        dragCleanupRef.current = setTimeout(function () {
          suppressClickRef.current = false
          dragCleanupRef.current = null
        }, 60)
      }

      function commitReorderDrop(targetId, edge) {
        const source = dragId
        finishDrag()
        if (source === null) return
        void saveReorder(reorderPendingIds(tasks, source, targetId, edge))
      }

      function cardTaskOf(event) {
        const target = event && event.target
        if (!target || typeof target.closest !== 'function') return null
        const node = target.closest('.dsh-ps-card')
        if (!node) return null
        const id = node.getAttribute('data-card-id')
        return id ? (taskById.get(id) || null) : null
      }

      function dragAllowedFor(column) {
        if (!dragTask) return false
        if (column === 'pending') return dragTask.status === 'idea' || dragTask.status === 'pending'
        if (column === 'idea') return dragTask.status === 'pending'
        return false
      }

      function dropStateFor(column) {
        if (!dragTask) return undefined
        if (column === columnKeyOfStatus(dragTask.status)) return undefined
        return dragAllowedFor(column) ? 'allowed' : 'forbidden'
      }

      function dropActiveFor(column) {
        return Boolean(dragTask && dropCell && dropCell.column === column && dropCell.allowed)
      }

      function dropLabelFor(column) {
        if (!dragTask) return null
        if (column === 'pending') return dragTask.status === 'idea' ? t('dragToPending') : t('dropHere')
        if (column === 'idea') return dragTask.status === 'pending' ? t('dragToIdeas') : null
        return null
      }

      function onDragStart(id, event) {
        const task = taskById.get(id)
        if (!task || !isDraggableStatus(task.status)) return
        suppressClickRef.current = true
        setDragId(id)
        setDropCell(null)
        try {
          if (event && event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', id)
          }
        } catch (error) {
          // Some browsers restrict dataTransfer outside a trusted drag.
        }
      }

      function onCardDragOver(id, event) {
        if (!dragTask) return
        const target = taskById.get(id)
        if (!target) return
        if (dragTask.status !== 'pending' || target.status !== 'pending') return
        if (event) {
          event.preventDefault()
          try {
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
          } catch (error) {
            // optional
          }
        }
        const rect = event.currentTarget.getBoundingClientRect()
        const edge = (event.clientY - rect.top) < rect.height / 2 ? 'before' : 'after'
        setDropCell(function (previous) {
          if (previous && previous.id === id && previous.edge === edge && previous.allowed === true) return previous
          return { column: 'pending', id: id, edge: edge, allowed: true }
        })
      }

      function onCardDragLeave(id) {
        setDropCell(function (previous) {
          if (previous && previous.id === id) return null
          return previous
        })
      }

      function onCardDrop(id, event) {
        if (!dragTask) return
        const target = taskById.get(id)
        if (!target) return
        if (dragTask.status !== 'pending' || target.status !== 'pending') {
          // Cross-column drops are completed by the column body handler so this
          // event keeps bubbling and exactly one action is committed.
          return
        }
        if (event) {
          event.preventDefault()
          event.stopPropagation()
        }
        let edge = 'before'
        if (dropCell && dropCell.id === id && dropCell.allowed === true) edge = dropCell.edge
        else if (event && event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect()
          edge = (event.clientY - rect.top) < rect.height / 2 ? 'before' : 'after'
        }
        commitReorderDrop(id, edge)
      }

      function onDragEnd() {
        finishDrag()
      }

      function onBodyDragOver(column, event) {
        if (!dragTask) return
        const targetTask = cardTaskOf(event)
        if (targetTask && dragTask.status === 'pending' && targetTask.status === 'pending') return
        const allowed = dragAllowedFor(column)
        if (event) {
          event.preventDefault()
          try {
            if (event.dataTransfer) event.dataTransfer.dropEffect = allowed ? 'move' : 'none'
          } catch (error) {
            // optional
          }
        }
        setDropCell(function (previous) {
          if (previous && previous.column === column && previous.allowed === allowed && previous.id === null) return previous
          return { column: column, id: null, edge: 'end', allowed: allowed }
        })
      }

      function onBodyDrop(column, event) {
        if (!dragTask) return
        const source = dragTask
        const targetTask = cardTaskOf(event)
        if (targetTask && source.status === 'pending' && targetTask.status === 'pending') return
        if (event) event.preventDefault()
        if (source.status === 'idea' && column === columnKeyOfStatus(source.status)) {
          finishDrag()
          return
        }
        const allowed = dragAllowedFor(column)
        finishDrag()
        if (!allowed) {
          addToast(t('dragNotAllowed'), 'error')
          return
        }
        if (source.status === 'pending' && column === 'pending') {
          void saveReorder(reorderPendingIds(tasks, source.id, null, 'end'))
          return
        }
        if (source.status === 'idea' && column === 'pending') {
          runCrossColumnAction(source, 'promote')
          return
        }
        if (source.status === 'pending' && column === 'idea') {
          runCrossColumnAction(source, 'demote')
        }
      }

      function onBodyDragLeave(column, event) {
        if (!dragTask) return
        if (event && event.currentTarget && event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return
        setDropCell(function (previous) {
          if (previous && previous.column === column) return null
          return previous
        })
      }

      function generateReport(day) {
        if (reportGenerating) return
        store.generateReport(day).then(function (result) {
          if (result.ok) addToast(t('reportGenerating'), 'info')
        })
      }

      // ---- per-column filters (v6): every column filters only its own cards

      function updateColumnFilter(column, patch) {
        setColumnFilters(function (previous) {
          const next = {}
          for (let i = 0; i < COLUMN_KEYS.length; i += 1) {
            const key = COLUMN_KEYS[i]
            next[key] = key === column ? Object.assign({}, previous[key], patch) : Object.assign({}, previous[key], { open: false })
          }
          return next
        })
      }

      function toggleColumnFilter(column) {
        setColumnFilters(function (previous) {
          const next = {}
          for (let i = 0; i < COLUMN_KEYS.length; i += 1) {
            const key = COLUMN_KEYS[i]
            next[key] = key === column
              ? Object.assign({}, previous[key], { open: !previous[key].open })
              : Object.assign({}, previous[key], { open: false })
          }
          return next
        })
      }

      function clearColumn(column) {
        setColumnFilters(function (previous) {
          const next = {}
          for (let i = 0; i < COLUMN_KEYS.length; i += 1) {
            const key = COLUMN_KEYS[i]
            next[key] = key === column ? emptyColumnFilter() : Object.assign({}, previous[key], { open: false })
          }
          return next
        })
      }

      // v0.7 task view: one status bar + one global search over the whole board.
      const globalTerm = globalQuery.trim().toLowerCase()
      const boardTasks = globalTerm === ''
        ? tasks
        : tasks.filter(function (task) { return matchesGlobalSearch(task, globalTerm) })

      const columnTotals = { idea: [], pending: [], claimed: [], ended: [] }
      for (let i = 0; i < boardTasks.length; i += 1) {
        const task = boardTasks[i]
        columnTotals[columnKeyOfStatus(task.status)].push(task)
      }
      columnTotals.ended.sort(function (a, b) { return taskTimestamp(b) - taskTimestamp(a) })
      const columnViews = {}
      const columnFiltersReady = {}
      for (let i = 0; i < COLUMN_KEYS.length; i += 1) {
        const key = COLUMN_KEYS[i]
        const filter = columnFilters[key] || emptyColumnFilter()
        columnFiltersReady[key] = filter
        const columnTasks = filterTasksForColumn(columnTotals[key], filter, key)
        const menuActive = isColumnFilterMenuActive(filter)
        columnViews[key] = {
          tasks: columnTasks,
          total: columnTotals[key].length,
          filtered: menuActive,
          menuActive: menuActive,
          countLabel: menuActive ? String(columnTasks.length) + '/' + String(columnTotals[key].length) : String(columnTotals[key].length),
        }
      }

      const allPending = tasks.filter(function (task) { return task.status === 'pending' })
      const pendingIndexById = new Map()
      for (let i = 0; i < allPending.length; i += 1) pendingIndexById.set(allPending[i].id, i)

      function columnEmptyNode(column, view, fallback) {
        if (view.tasks.length > 0) return null
        if (view.filtered) {
          return h(ColumnEmpty, {
            icon: IconSearch,
            iconSize: 20,
            filtered: true,
            title: t('filterEmptyTitle'),
            hint: t('filterEmptyHint'),
            action: h('button', {
              type: 'button',
              className: 'dsh-ps-btn dsh-ps-btn-sm',
              onClick: function () { clearColumn(column) },
            }, h(IconRefresh, { size: 13 }), h('span', null, t('filterEmptyClear'))),
          })
        }
        return h(ColumnEmpty, {
          icon: fallback.icon,
          iconSize: fallback.iconSize || 22,
          title: fallback.title,
          hint: fallback.hint,
          action: fallback.action || null,
        })
      }

      function columnControl(column) {
        return {
          t: t,
          filter: columnFiltersReady[column],
          countLabel: columnViews[column].countLabel,
          funnelRef: funnelRefs.current[column],
          onToggleFilter: function () { toggleColumnFilter(column) },
          onFilterChange: function (patch) { updateColumnFilter(column, patch) },
          onClearFilters: function () { clearColumn(column) },
          onCloseFilter: function () { updateColumnFilter(column, { open: false }) },
        }
      }

      let chainCandidate = null
      for (let i = tasks.length - 1; i >= 0; i -= 1) {
        if (tasks[i].source === 'queue' && tasks[i].status !== 'failed' && tasks[i].status !== 'cancelled') {
          chainCandidate = tasks[i]
          break
        }
      }
      const selectedTask = selectedId === null ? null : (taskById.get(selectedId) || null)
      const editingTask = editingId === null ? null : (taskById.get(editingId) || null)
      const chainSource = selectedTask && selectedTask.chainFrom !== '' ? (taskById.get(selectedTask.chainFrom) || null) : null

      const autoStartOn = !!(settings && settings.autoStart)
      const processingCount = snap.counts.running + snap.counts.paused + snap.counts.blocked
      const endedCount = snap.counts.done + snap.counts.failed + snap.counts.cancelled
      const taskbarNode = h('div', { className: 'dsh-ps-taskbar' },
        h('div', { className: 'dsh-ps-taskbar-counts', role: 'group', 'aria-label': t('kpiGroupLabel') },
          h('span', { key: 'idea' }, t('kpiIdea'), ' ', h('strong', null, String(snap.counts.idea))),
          h('span', { key: 'pending' }, t('kpiPending'), ' ', h('strong', null, String(snap.counts.pending))),
          h('span', { key: 'processing' }, t('kpiProcessing'), ' ', h('strong', null, String(processingCount))),
          h('span', { key: 'ended' }, t('columnEnded'), ' ', h('strong', null, String(endedCount)))),
        h('span', { className: 'dsh-ps-taskbar-grow' }),
        h('span', { className: 'dsh-ps-taskbar-switch' },
          h(Switch, {
            checked: autoStartOn,
            disabled: !settings || autoBusy,
            label: t('autoStart'),
            onChange: toggleAutoStart,
          }),
          h('span', null, t('autoStart'))),
        h('div', { className: 'dsh-ps-taskbar-search' },
          h('span', { className: 'dsh-ps-taskbar-search-icon', 'aria-hidden': 'true' }, h(IconSearch, { size: 13 })),
          h('input', {
            className: 'dsh-ps-taskbar-input',
            type: 'search',
            value: globalQuery,
            placeholder: t('searchPlaceholder'),
            'aria-label': t('searchPlaceholder'),
            spellCheck: false,
            onChange: function (event) { setGlobalQuery(event.target.value) },
          }),
          globalQuery !== ''
            ? h('button', {
              type: 'button',
              className: 'dsh-ps-taskbar-clear',
              'aria-label': t('searchClear'),
              title: t('searchClear'),
              onClick: function () { setGlobalQuery('') },
            }, h(IconClose, { size: 12 }))
            : null))

      function renderCard(task, index, columnKey) {
        return h(TaskCard, {
          key: task.id,
          task: task,
          t: t,
          now: now,
          index: index,
          columnKey: columnKey,
          pendingCount: allPending.length,
          moving: reorderBusy,
          busyAction: busyAction,
          dragging: dragId === task.id,
          dropEdge: dropCell && dropCell.id === task.id && dragId !== task.id ? dropCell.edge : null,
          isDragging: dragId === task.id,
          chainTitle: task.chainFrom !== '' ? (titleById.get(task.chainFrom) || '') : '',
          onOpen: openCard,
          onAction: runCardAction,
          onEdit: openEdit,
          onMove: movePendingTask,
          onOpenSession: openSession,
          onDragStart: onDragStart,
          onDragOver: onCardDragOver,
          onDragLeave: onCardDragLeave,
          onDrop: onCardDrop,
          onDragEnd: onDragEnd,
        })
      }

      const ideaNodes = []
      for (let i = 0; i < columnViews.idea.tasks.length; i += 1) ideaNodes.push(renderCard(columnViews.idea.tasks[i], -1, 'idea'))
      const pendingNodes = []
      for (let i = 0; i < columnViews.pending.tasks.length; i += 1) {
        pendingNodes.push(renderCard(columnViews.pending.tasks[i], pendingIndexById.get(columnViews.pending.tasks[i].id) || 0, 'pending'))
      }
      const claimedNodes = []
      for (let i = 0; i < columnViews.claimed.tasks.length; i += 1) claimedNodes.push(renderCard(columnViews.claimed.tasks[i], -1, 'claimed'))
      const endedNodes = []
      for (let i = 0; i < columnViews.ended.tasks.length; i += 1) endedNodes.push(renderCard(columnViews.ended.tasks[i], -1, 'ended'))

      const ideaColumn = h(BoardColumn, Object.assign({
        key: 'idea',
        variant: 'idea',
        title: t('columnIdeas'),
        dotStatus: 'idea',
        hint: t('columnIdeasHint'),
        drop: dropStateFor('idea'),
        dragActive: dragId !== null,
        dropActive: dropActiveFor('idea'),
        dropLabel: dropLabelFor('idea'),
        onBodyDragOver: function (event) { onBodyDragOver('idea', event) },
        onBodyDrop: function (event) { onBodyDrop('idea', event) },
        onBodyDragLeave: function (event) { onBodyDragLeave('idea', event) },
      }, columnControl('idea')),
      columnEmptyNode('idea', columnViews.idea, {
        icon: IconSpark,
        iconSize: 20,
        title: t('emptyIdeasColumn'),
        hint: t('emptyIdeasColumnHint'),
        action: h('button', {
          type: 'button',
          className: 'dsh-ps-btn dsh-ps-btn-sm',
          onClick: function () { openPublish('single') },
        }, h(IconPlus, { size: 13 }), h('span', null, t('emptyIdeasColumnAction'))),
      }),
      ideaNodes)

      const pendingColumn = h(BoardColumn, Object.assign({
        key: 'pending',
        variant: 'pending',
        title: t('columnPending'),
        dotStatus: 'pending',
        hint: t('columnPendingHint'),
        titleHint: t('columnPendingHint') + ' · ' + t('columnPendingDragHint'),
        drop: dropStateFor('pending'),
        dragActive: dragId !== null,
        dropActive: dropActiveFor('pending'),
        dropLabel: dropLabelFor('pending'),
        onBodyDragOver: function (event) { onBodyDragOver('pending', event) },
        onBodyDrop: function (event) { onBodyDrop('pending', event) },
        onBodyDragLeave: function (event) { onBodyDragLeave('pending', event) },
      }, columnControl('pending')),
      columnEmptyNode('pending', columnViews.pending, {
        icon: IconInbox,
        title: t('emptyPendingColumn'),
        hint: t('emptyPendingColumnHint'),
        action: h('button', {
          type: 'button',
          className: 'dsh-ps-btn dsh-ps-btn-sm',
          onClick: function () { openPublish('single') },
        }, h(IconPlus, { size: 13 }), h('span', null, t('emptyCta'))),
      }),
      pendingNodes)

      const claimedColumn = h(BoardColumn, Object.assign({
        key: 'claimed',
        variant: 'claimed',
        title: t('columnClaimed'),
        dotStatus: 'claimed',
        hint: t('columnClaimedHint'),
        drop: dropStateFor('claimed'),
        dragActive: dragId !== null,
      }, columnControl('claimed')),
      columnEmptyNode('claimed', columnViews.claimed, {
        icon: IconPlay,
        iconSize: 20,
        title: t('emptyClaimedColumn'),
        hint: t('emptyClaimedColumnHint'),
      }),
      claimedNodes)

      const endedColumn = h(BoardColumn, Object.assign({
        key: 'ended',
        variant: 'ended',
        title: t('columnEnded'),
        dotStatus: 'done',
        hint: t('columnEndedHint'),
        drop: dropStateFor('ended'),
        dragActive: dragId !== null,
      }, columnControl('ended')),
      columnEmptyNode('ended', columnViews.ended, {
        icon: IconCheckCircle,
        iconSize: 20,
        title: t('emptyEndedColumn'),
        hint: t('emptyEndedColumnHint'),
      }),
      endedNodes)

      let boardContent = null
      if (tasks.length === 0 && snap.phase === 'loading') {
        boardContent = h('div', { className: 'dsh-ps-loading' }, h(Spinner), h('span', null, t('loadingState')))
      } else if (tasks.length === 0 && snap.phase === 'error') {
        boardContent = h('div', { className: 'dsh-ps-empty-hero' },
          h(IconAlert, { size: 26, className: 'dsh-ps-empty-illustration' }),
          h('h2', { className: 'dsh-ps-empty-title' }, t('loadFailed')),
          h('p', { className: 'dsh-ps-empty-hint' }, t('stateLoadFailed')),
          h('div', { className: 'dsh-ps-empty-actions' },
            h('button', { type: 'button', className: 'dsh-ps-btn', onClick: function () { store.refresh() } },
              h(IconRetry, { size: 15 }), h('span', null, t('retry')))))
      } else if (tasks.length === 0) {
        boardContent = h('div', { className: 'dsh-ps-empty-hero' },
          h(SecretaryIllustration, { size: 190, className: 'dsh-ps-empty-illustration' }),
          h('h2', { className: 'dsh-ps-empty-title' }, t('emptyTitle')),
          h('p', { className: 'dsh-ps-empty-hint' }, t('emptyHint')),
          h('div', { className: 'dsh-ps-empty-actions' },
            h('button', { type: 'button', className: 'dsh-ps-btn dsh-ps-btn-primary', onClick: function () { openPublish('single') } },
              h(IconPlus, { size: 15 }), h('span', null, t('emptyCta'))),
            h('button', { type: 'button', className: 'dsh-ps-btn', onClick: function () { openPublish('batch') } },
              h(IconLayers, { size: 15 }), h('span', null, t('emptyCtaBatch')))))
      } else {
        boardContent = h('div', { className: 'dsh-ps-board' }, ideaColumn, pendingColumn, claimedColumn, endedColumn)
      }

      // v0.6: notification centre derives its feed from /state (no extra Host
      // endpoint) — waiting tasks plus the last 24h of done/failed/blocked.
      const briefSettings = snap.briefs.settings || (settings && settings.morningBrief) || defaultMorningBriefSettings()
      const briefGenerating = briefSettings.lastStatus === 'running' || Boolean(briefSettings.generatingDate)
      const notifEvents = []
      const notifSeenIds = new Set()
      const waitingForBadge = waitingTasksOf(tasks)
      for (let i = 0; i < waitingForBadge.length; i += 1) {
        notifSeenIds.add(waitingForBadge[i].id)
        notifEvents.push(taskEventAt(waitingForBadge[i]))
      }
      const recentForBadge = recentEventsOf(tasks, now)
      for (let i = 0; i < recentForBadge.length; i += 1) {
        if (notifSeenIds.has(recentForBadge[i].id)) continue
        notifSeenIds.add(recentForBadge[i].id)
        notifEvents.push(taskEventAt(recentForBadge[i]))
      }
      let unreadCount = 0
      if (lastSeen > 0) {
        for (let i = 0; i < notifEvents.length; i += 1) {
          if (notifEvents[i] > lastSeen) unreadCount += 1
        }
      }

      const headerActions = h('div', { className: 'dsh-ps-header-actions' },
        h('div', { className: 'dsh-ps-notif-wrap' },
          h('button', {
            type: 'button',
            className: 'dsh-ps-bell',
            'data-unread': unreadCount > 0 ? 'true' : undefined,
            'aria-label': unreadCount > 0
              ? t('notificationsAria') + ' · ' + t('notificationUnread', { count: unreadCount })
              : t('notificationsAria'),
            'aria-haspopup': 'dialog',
            'aria-expanded': notifOpen ? 'true' : 'false',
            title: t('notifications'),
            onClick: function () { setNotifOpen(function (value) { return !value }) },
          },
          h(IconBell, { size: 17 }),
          unreadCount > 0
            ? h('span', { className: 'dsh-ps-bell-badge', 'aria-hidden': 'true' }, unreadCount > 9 ? '9+' : String(unreadCount))
            : null),
          notifOpen
            ? h(NotificationsPopover, {
              t: t,
              tasks: tasks,
              now: now,
              lastSeen: lastSeen,
              onOpenTask: openCard,
              onOpenTaskChat: openTaskChat,
              onMarkAllRead: markNotificationsRead,
              onOpenWebhookLog: function () { setNotifOpen(false); setWebhookLogOpen(true) },
              onClose: function () { setNotifOpen(false) },
            })
            : null),
        h('button', {
          type: 'button',
          ref: reviewButtonRef,
          className: 'dsh-ps-btn dsh-ps-evo-entry',
          'aria-haspopup': 'dialog',
          'aria-expanded': reviewOpen ? 'true' : 'false',
          'aria-label': proposedSkillCount > 0
            ? t('review') + ' · ' + t('skillCandidateBadge', { count: proposedSkillCount })
            : t('review'),
          title: proposedSkillCount > 0
            ? t('skillCandidateBadge', { count: proposedSkillCount })
            : t('review'),
          onClick: function () { openReview('journal') },
        }, h(IconCalendar, { size: 15 }), h('span', { className: 'dsh-ps-btn-label' }, t('review')),
        proposedSkillCount > 0
          ? h('span', { className: 'dsh-ps-evo-entry-badge', 'aria-hidden': 'true' },
            proposedSkillCount > 9 ? '9+' : String(proposedSkillCount))
          : null),
        h('button', {
          type: 'button',
          className: 'dsh-ps-btn',
          'aria-haspopup': 'dialog',
          'aria-expanded': settingsOpen ? 'true' : 'false',
          'aria-label': t('settings'),
          onClick: function () { setSettingsOpen(true) },
        }, h(IconSliders, { size: 15 }), h('span', { className: 'dsh-ps-btn-label' }, t('settings'))),
        h('button', {
          type: 'button',
          className: 'dsh-ps-btn dsh-ps-btn-primary',
          'aria-label': t('publish'),
          onClick: function () { openPublish('single') },
        }, h(IconPlus, { size: 16 }), h('span', { className: 'dsh-ps-btn-label' }, t('publish'))))

      const headerNode = h('header', { className: 'dsh-ps-header' },
        h('div', { className: 'dsh-ps-header-main' },
          h('div', { className: 'dsh-ps-title-row' },
            h('h1', { className: 'dsh-ps-title' }, t('panelTitle'))),
          h('p', { className: 'dsh-ps-subtitle' }, t('subtitle'))),
        h('div', { className: 'dsh-ps-header-mid' },
          h('div', { className: 'dsh-ps-views', role: 'tablist', 'aria-label': t('viewSwitchAria') },
            h('button', {
              type: 'button',
              role: 'tab',
              className: 'dsh-ps-view-btn',
              'aria-selected': view === 'today' ? 'true' : 'false',
              onClick: function () { setView('today'); setNotifOpen(false) },
            }, h('span', null, t('viewToday'))),
            h('button', {
              type: 'button',
              role: 'tab',
              className: 'dsh-ps-view-btn',
              'aria-selected': view === 'tasks' ? 'true' : 'false',
              onClick: function () { setView('tasks'); setNotifOpen(false) },
            }, h('span', null, t('viewTasks'))))),
        headerActions)

      const todayNode = h(TodayView, {
        t: t,
        store: store,
        snap: snap,
        now: now,
        onCapture: captureTask,
        onOpenTask: openCard,
        onOpenTaskChat: openTaskChat,
        onOpenSession: openSession,
        onAction: runCardAction,
        onEdit: openEdit,
        onJoinSuggestion: joinSuggestion,
        onOpenBriefs: function () { setBriefsOpen(true) },
        onGenerateBrief: generateBriefNow,
        onGoSettings: function () { setSettingsOpen(true) },
        onGoTasks: function () { setView('tasks'); setNotifOpen(false) },
        onOpenReview: openReview,
      })

      const pageBody = view === 'today'
        ? todayNode
        : h(React.Fragment, null,
          taskbarNode,
          reorderBusy
            ? h('div', { className: 'dsh-ps-settings-saving', role: 'status' }, h(Spinner), h('span', null, t('reorderSaving')))
            : null,
          boardContent)

      const body = h(React.Fragment, null,
        h('div', { className: 'dsh-ps-page', 'data-view': view },
          h('div', { className: 'dsh-ps-page-inner' },
            headerNode,
            h(ErrorBanner, {
              error: snap.error,
              dismissLabel: t('dismiss'),
              onDismiss: store.clearError,
            }),
            pageBody)),
        selectedTask
          ? h(DetailDrawer, {
            key: selectedTask.id,
            ctx: ctx,
            store: store,
            t: t,
            task: selectedTask,
            chainSource: chainSource,
            focusComposer: focusChatId === selectedTask.id,
            onOpenTask: function (id) { setSelectedId(id) },
            onOpenSession: openSession,
            onEdit: openEdit,
            onMoveTask: movePendingTask,
            onClose: function () { setSelectedId(null) },
            addToast: addToast,
          })
          : null,
        editingTask
          ? h(EditDialog, {
            key: 'edit-' + editingTask.id,
            ctx: ctx,
            store: store,
            t: t,
            task: editingTask,
            tasks: tasks,
            chainTitle: editingTask.chainFrom !== '' ? (titleById.get(editingTask.chainFrom) || '') : '',
            addToast: addToast,
            onClose: function () { setEditingId(null) },
            onSaved: function () { setEditingId(null) },
          })
          : null,
        publishOpen
          ? h(PublishDialog, {
            key: 'publish-dialog',
            ctx: ctx,
            store: store,
            t: t,
            initialCwd: publishCwd,
            initialMode: publishMode,
            chainCandidate: chainCandidate,
            addToast: addToast,
            onClose: function () { setPublishOpen(false) },
            onPublished: function (cwd) { setLastDir(cwd) },
          })
          : null,
        settingsOpen
          ? h(SettingsDialog, {
            key: 'settings-dialog',
            ctx: ctx,
            store: store,
            t: t,
            settings: settings,
            reportSettings: reportSettings,
            reportGenerating: reportGenerating,
            briefSettings: briefSettings,
            briefGenerating: briefGenerating,
            models: snap.models,
            modelsPhase: snap.modelsPhase,
            modelsError: snap.modelsError,
            addToast: addToast,
            onGenerateReport: generateReport,
            onGenerateBrief: generateBriefNow,
            onClose: function () { setSettingsOpen(false) },
          })
          : null,
        briefsOpen
          ? h(BriefsDrawer, {
            key: 'briefs-drawer',
            ctx: ctx,
            store: store,
            t: t,
            addToast: addToast,
            onClose: function () { setBriefsOpen(false) },
          })
          : null,
        reviewOpen
          ? h(ReviewDrawer, {
            key: 'review-drawer-' + reviewTab,
            ctx: ctx,
            store: store,
            t: t,
            initialTab: reviewTab,
            addToast: addToast,
            onClose: function () { setReviewOpen(false) },
          })
          : null,
        webhookLogOpen
          ? h(WebhookLogDialog, {
            key: 'webhook-log-dialog',
            t: t,
            store: store,
            onClose: function () { setWebhookLogOpen(false) },
          })
          : null,
        h(ToastStack, {
          toasts: toastsState.toasts,
          onDismiss: toastsState.dismissToast,
          dismissLabel: t('dismiss'),
        }))

      return body
    }

    // ------------------------------------------------------------------ panel + apply

    function fallbackTranslate(key) {
      return key
    }

    function Panel(props) {
      const ctx = props.ctx
      const store = props.store
      const t = typeof props.t === 'function' ? props.t : fallbackTranslate
      useLocaleRerender(ctx && ctx.locale ? ctx.locale : null)
      return h('section', { className: 'dsh-ps-panel', 'aria-label': t('panelTitle') },
        h(PanelErrorBoundary, { t: t },
          h(Board, { ctx: ctx, store: store, t: t })))
    }

    // ------------------------------------------------------------------ apply

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en })
      }, 'dsh-personal-secretary: dictionaries')
      const t = ctx.locale.bind(NS)
      insertStyles(ctx, CSS)
      const store = createStore(ctx, t)
      ctx.effect(function () {
        return function () { store.dispose() }
      }, 'dsh-personal-secretary: store')
      ctx.effect(function () {
        const off = ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'secretary',
            order: 5,
            locale: NS,
            label: function () { return t('panelTitle') },
          }, IconSecretary)
        })
        return function () {
          if (typeof off === 'function') off()
        }
      }, 'dsh-personal-secretary: sidebar entry')
      ctx.effect(function () {
        const off = ctx.slots.inject('main', function () {
          return ctx.slots.register({
            name: 'main',
            key: 'secretary',
            locale: NS,
            inject: function () { return { ctx: ctx, store: store, t: t } },
          }, Panel)
        })
        return function () {
          if (typeof off === 'function') off()
        }
      }, 'dsh-personal-secretary: main panel')
    }

    return {
      name: 'dsh-personal-secretary',
      inject: ['slots', 'locale', 'uiWorkspace', 'layout'],
      apply: apply,
    }
  },
})

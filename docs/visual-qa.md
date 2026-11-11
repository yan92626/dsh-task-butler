# 视觉验收（UI Visual QA）— UI 改动的必做检查

> 用户明确要求：**每次更新插件展示内容后，必须自己先检查是否美观、布局是否合理，不能只看功能是否完成。**
> 本文件是 UI 改动的验收门；不通过不提交、不发版。

## 0. 什么时候必须做

只要改动涉及 `client.js` 的布局、样式、文案、组件结构，或新增/删除页面区块、抽屉、弹窗、空状态，就必须完整走一遍本清单。

## 1. 交付前必须产出的截图（缺一不可）

| 视图 | 宽度 | 主题 | 状态 |
|---|---|---|---|
| 今日页 | 1638（宽屏，对齐用户面板）、1280、1100、900、390 | 深色 + 浅色 | 空态（无等你处理/进行中）与非空态 |
| 任务页 | 1280、900 | 深色 + 浅色 | 有任务 |
| 回顾抽屉 | 1280 | 深色 + 浅色 | 日志 / 复盘 / 经验 / 技能 |

- 截图放入 `docs/preview/<版本或 v07>/`；本期（v0.7.x）放 `docs/preview/v07/`。
- 文件名包含视图、宽度、主题、状态，例如 `today-1280-dark.png`、`today-1638-empty.png`。
- 与上一版本同尺寸截图并排对比，记录改善/回归。

## 2. 量化检查（必须写进交付回执）

- [ ] **左右留白对称**：宽屏（1638/1280）内容列左右留白差 ≤ 4px。
- [ ] **对齐**：Header 左侧标题、右侧操作按钮与内容卡片左右边缘误差 ≤ 4px。
- [ ] **无横向溢出**：`page.scrollWidth === page.clientWidth`（允许滚动条 gutter 差的 10px）。
- [ ] **首屏密度**：今日页首屏内容块 ≤ 3 个 + 页脚；任务页状态条 ≤ 44px 高。
- [ ] **无空态大卡**：空区块不渲染或压成 ≤ 56px 细条，不占大块空白。
- [ ] **无裸 Markdown**：卡片/摘要/日志正文不得出现 `##`、`**`、反引号、分割线原样字符。
- [ ] **字号**：正文 ≥ 12.5px；关键正文 ≥ 13px。
- [ ] **对比度**：正文/背景 ≥ 4.5:1；次级文字/页脚 ≥ 3:1（深色与浅色都测）。
- [ ] **层级**：卡片与页面背景可区分（深色下不允许“糊成一片”）；顶部装饰光晕在宽屏下不形成明显脏色块。
- [ ] **滚动**：无双层滚动（页面滚 + 列内滚）；不出现被裁断的卡片行。
- [ ] **状态与动效**：`prefers-reduced-motion` 生效；hover/focus 可见；无 console error。
- [ ] **一致性**：明暗主题同一套 token；不新增色板外字面色值（`node tests/static-check.mjs` 会拦）。

## 3. 怎么渲染（本地评测台）

本机已有可复现渲染台（不依赖 DSH 登录）：

- 目录：`/tmp/panel-harness`（`server.mjs` 同源 GET 代理 live Host `/secretary/api/*`；`public/bootstrap.js` 伪造最小 DSH ctx 并真实执行 `client.js` 的 `plugin.apply`；`public/theme.css` 从 `app.asar` 提取真实 DSH 明/暗 token；`shots.sh` 截图脚本）。
- 依赖：`/tmp/panel-deps/node_modules` 下的 React 18 / ReactDOM 18 UMD（如缺失：`npm_config_cache=/tmp/npm-cache npm --prefix /tmp/panel-deps install react@18.3.1 react-dom@18.3.1`，走本机代理）。
- 运行：`node /tmp/panel-harness/server.mjs &`（8787），再执行截图脚本或 headless Chrome：
  `--headless=new --no-sandbox --user-data-dir=/tmp/xxx --window-size=<W>,<H> --virtual-time-budget=8000 --screenshot=... http://127.0.0.1:8787/`
- 真实 DSH 主题：深色通过 `document.body.setAttribute('data-ds-dark-theme','')` 切换（与线上一致）。
- 限制：渲染台只挂 Panel 本体，没有 DSH 外壳/侧栏，所以宽度是**面板宽**而非整窗宽；动画会被禁用。上线前仍需用户在真实 GUI 刷新后目测一次。

## 4. 已知历史问题（发现即修，不要回归）

- v0.6：今日页 8 个区块 + 右栏 3 张重复卡；2 个空态卡片占 198px；900 宽 header 178px；任务页 5 张 KPI 卡 171px、≤1320 退化成 2×2 巨列、列内双层滚动裁卡片；卡片显示裸 Markdown；宽屏内容列左对齐留白不平衡。
- v0.7.0：今日页内容列 `max-width:920px;margin:0` 左对齐，宽屏右侧大片空白；深色下光晕过重、卡片与背景层次偏弱。
- v0.7.1：修复项（居中列 + 深色打磨），验收基线见 `docs/preview/v07/`。

## 5. 回执模板

```
视觉验收：
- 截图：<路径清单>
- 留白对称：L/R = ...px
- header/内容对齐：...px
- 横向溢出：无/有
- 首屏内容块：N + 页脚
- 字号/对比度：正文 xx:1，次级 xx:1
- 卡片/背景层级：Δ亮度 ...
- console error：0
- 与上一版对比：改善 ... / 回归 ...
- 结论：可发布 / 需修复（附问题与截图）
```

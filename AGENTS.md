# 仓库协作约定（AGENTS）

给所有在本仓库工作的 Agent：

1. **UI 改动必须过视觉验收**：涉及 `client.js` 的布局/样式/文案/组件改动，交付前必须按 [`docs/visual-qa.md`](docs/visual-qa.md) 自检——多宽度（宽屏/1280/1100/900/390）× 明暗主题 × 空/非空态截图 + 留白对称/对齐/对比度/字号/横向溢出/console error 指标。**不通过不提交、不发版**；截图放 `docs/preview/v07/`。
2. **不要只说“功能完成”**：交付回执里必须包含视觉验收结果（截图路径 + 指标 + 与上一版对比）。用户不接受“只改了逻辑/页面”的交付。
3. 单文件浏览器半 `client.js`（`window.__ModuleLoader__`，无构建、无 JSX，只 `require('react')`）；Host 为 ESM（`index.js` + `host/**`）。
4. 负责范围外不改；不执行 `git add/commit/push/tag`（由 Lead 统一发版）；不重启用户 Harness（Host 新代码需用户在 Plugin Manager 重载 bundle 生效）。
5. 改动要同步：`tests/static-check.mjs`（字符串/版本/契约）、对应单测、README、locale、`package.json` 与 `host/api.js` 的 `VERSION`。
6. 真实数据（任务/会话/路径/项目名）不要提交；`research/` 已 gitignore；示例/截图需脱敏。
7. 每次发版流程：版本号 → 全量测试（static + 单测 + api-check）→ 视觉验收 → commit → tag `vX.Y.Z` → push。

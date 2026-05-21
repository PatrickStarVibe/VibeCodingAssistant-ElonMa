# Follow-up: 18080 debug/highlight enablement + selection tooltip anchor positioning

## 背景

上一 task `20260520-220045-feedback-ui-unification` 已 completed，`npm test` 全过。用户验收时发现两个问题：

1. `http://127.0.0.1:18080` 上没有 vocabulary 高亮，也没有 Debug panel。
2. 未高亮 word/phrase 选中后，现在确实走了 `VocabularyHoverTooltip` 并显示「我不认识」，这个 UX 方向正确；但 tooltip 位置仍出现在旧 Translator 左上位置，没有跟随选中的 word/phrase，也没有和高亮 hover tooltip 共用同一套定位逻辑。

本 task 是修 follow-up bug，不要重做上一 task 的大范围功能。

## 已知诊断

### 1. 18080 没有高亮 / Debug panel

代码里 vocabulary 相关功能依赖 localStorage 开关：

- 高亮 overlay：`localStorage['vocab:hover'] === '1'`
- Debug panel：`localStorage['vocab:debug'] === '1'`
- domain debug：`localStorage['vocab:domainDebug']`

`5173`、`18080`、`localhost:18080`、`127.0.0.1:18080` 是不同 origin，localStorage 不共享。所以用户在另一个端口开过 debug，不代表 18080 也开了。

Planner / Implementer 需要验证这点，并让 18080 的 dev/debug workflow 更不容易踩坑。可选方向：

- dev-only URL/query param bootstrap，例如 `?vocabHover=1&vocabDebug=1` 写入 localStorage 后生效；
- dev-only console helper / visible debug status；
- 在 dev 环境下提供更清楚的 debug enablement path；
- 不要把 debug panel 默认暴露给普通生产用户，除非项目现有约定就是这么做。

目标是：用户在 18080 上可以明确知道高亮/debug 是否开启，并能稳定打开它们。

### 2. 选中 word/phrase tooltip 位置不对

上一 task 只复用了 `VocabularyHoverTooltip` 的视觉组件，但没有真正复用 hover 高亮路径的 live DOM anchor 定位。

当前疑似问题：

- `useReader` 的 selection range 来自 epub iframe 文档；
- `Translator` / `VocabularyHoverTooltip` 渲染在外层 React document；
- 如果 iframe 内部 `Range` rect 没有正确转换到外层 viewport，或 `selectionContext.anchor` 为空，就会 fallback 到旧 `{ x, y }`；
- `Translator.tsx` 里 `createFallbackAnchor(text, x, y)` 会保留旧 Translator 的定位行为；
- 用户看到的现象正是：样式已变成 hover tooltip，但位置还是旧左上 popover 位置。

这次必须修的是“定位来源和坐标转换”，不是再改视觉。

## 本 task 范围

### 1. 高亮 / Debug enablement

- 确认 `vocab:hover` 和 `vocab:debug` 在 18080 origin 下的行为。
- 给 18080/dev workflow 增加一个可靠、可发现的启用方式。
- 避免误导：如果高亮没开，Debug panel 不应让用户以为功能坏了。
- 保持生产用户体验安全，不要无条件显示 Debug panel 给普通用户。

### 2. Selection tooltip 和 hover tooltip 共用定位逻辑

未高亮 word/phrase 选中后的 `VocabularyHoverTooltip` 必须跟随选中的词/短语显示，和高亮词 hover tooltip 使用同一套 anchor coordinate 逻辑。

要求：

- word/phrase selection 不能依赖旧 Translator 的 `{ x, y }` 作为正常路径。
- 正常路径应从当前 epub selection `Range` / live DOM rect 生成 `WordAnchor`。
- iframe 内部 rect 必须转换到外层 viewport 坐标。
- 如果 selection anchor 算不出来，要有明确 fallback 策略，并且 fallback 也应尽量基于 iframe frame rect / selected range，而不是回到旧左上 popover。
- 句子 selection 仍保持旧 Translator 行为，不进入 vocabulary tooltip。
- 不改变已验收的高亮词 hover →「我认识」流程。

### 3. 测试要求

新增或补强测试，不要只测组件渲染，要测定位来源：

- `getViewportAnchorRectsForRange` / selection anchor helper 能把 iframe 内 rect 转成外层 viewport rect。
- `Translator` 在 word/phrase selection 有 anchor 时，传给 `VocabularyHoverTooltip` 的位置来自 anchor，不来自旧 `{ x, y }`。
- anchor 缺失 fallback 有测试，确认不会回到明显错误的左上旧位置。
- 高亮/debug enablement 的 dev bootstrap 或 helper 有测试（如果实现为代码路径）。
- `npm test` 全过。

## 不在范围内

- 不重做反馈 UI 视觉风格。
- 不改 sentence selection 的旧 Translator 行为。
- 不改 Translation Planning / 自动翻译能力，除非定位修复必须触碰类型传递。
- 不清理 pre-existing dirty files，例如 `docs/obsidian-vault/`、`scripts/obsidian/`。

## 验收标准

- 在 18080 上能明确开启 vocabulary hover 高亮和 Debug panel，或页面/console 提供清晰的 dev enablement path。
- 开启后 vocabulary 高亮应出现，Debug panel 应出现。
- 选中未高亮 word/phrase 后，「我不认识」tooltip 出现在选区附近，而不是旧左上位置。
- 高亮词 hover tooltip 和 selection tooltip 使用一致的定位/坐标转换逻辑。
- `npm test` 全过。

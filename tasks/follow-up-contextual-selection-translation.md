# Follow-up: contextual selection translation + unified hover tooltip positioning

## 背景

上一轮 task `20260520-220045-feedback-ui-unification` 已完成，用户验收时继续发现：

1. `http://127.0.0.1:18080` 上没有 vocabulary 高亮，也没有 Debug panel。
2. 未高亮 word/phrase 选中后，视觉上已复用 `VocabularyHoverTooltip` 并显示「我不认识」，但位置仍然出现在旧 Translator 左上角位置，没有跟随选中的词/短语。
3. sentence 选中后仍出现旧的左上角 pop-up 小窗口，可以点击翻译，但这条旧路径没有真正接入新的翻译算法，也不符合用户现在要求。

上一轮 planning task `20260520-233712-vocab-debug-anchor-position` 因修订轮数到达上限且计划仍保留旧 sentence Translator 路径，已停止。本 task 重新整理最新需求。

## 用户最新产品要求

Translator Planning 不再只区分“单词翻译”或“整篇翻译”。新增并改成一条新的主路径：

- 用户选多少，系统就翻多少。
- 选中的文本作为待翻译内容。
- 请求中要接 sentence 或周边上下文，用 contextual translation。
- 原本旧的 sentence/manual Translator 路径不保留，直接删除。

旧路径包括：

- sentence 选中后出现在左上角的 pop-up 小窗口；
- 手工点击“翻译”的按钮路径；
- 旧的 `translateText` 用户路径；
- 相关旧测试。

## 本 task 范围

### 1. 18080 高亮 / Debug enablement

当前 vocabulary 相关功能依赖 localStorage：

- 高亮 overlay：`localStorage['vocab:hover'] === '1'`
- Debug panel：`localStorage['vocab:debug'] === '1'`
- domain debug：`localStorage['vocab:domainDebug']`

`5173`、`18080`、`localhost:18080`、`127.0.0.1:18080` 是不同 origin，localStorage 不共享。

要求：

- 给 dev/18080 workflow 增加可靠启用方式，例如 dev-only URL 参数：
  - `?vocabHover=1|0`
  - `?vocabDebug=1|0`
  - `?vocabDomainDebug=1|0`
- 参数只在 dev 环境生效，生产用户不暴露 Debug panel。
- 参数应覆盖当前 localStorage，并在处理后从 URL 中移除。
- 如果 Debug 开启但 hover 未开启，要给清楚提示，避免用户以为功能坏了。

### 2. 统一 selection tooltip 和 hover tooltip 的显示逻辑

所有选区类型都必须使用同一套 Hover Tooltip 风格窗口和同一套位置逻辑：

- word
- phrase
- sentence
- 用户任意长度选区

要求：

- `VocabularyHoverTooltip` 或等价统一 tooltip 是唯一选区浮层样式。
- 位置必须来自统一 anchor / iframe-to-viewport 转换逻辑。
- 必须和高亮词 hover tooltip 保持一致。
- 严禁回到旧左上角 pop-up 位置。
- 如果 selection anchor 算不出来，fallback 也应基于 iframe frame rect / selected range / reader area，而不是旧 `{ x, y }`。

### 3. 删除旧 sentence/manual Translator 路径

要求：

- 删除旧 sentence pop-up 小窗口。
- 删除旧手工点击翻译按钮路径。
- 删除旧 `translateText` 用户路径，除非底层服务仍被新 contextual request 内部复用，但 UI 行为不能再走旧路径。
- 删除或重写旧 sentence Translator 测试。
- sentence/长选区选中后，直接显示统一 tooltip，并自动发起 contextual selection translation。

### 4. 新增统一 contextual selection translation path

新增或改造请求接口，使其支持任意选区：

- 输入：selected text、selection kind、sentence 或周边上下文、必要的偏移/CFI 信息。
- 输出：用于 tooltip 展示的翻译状态和翻译结果。
- word/phrase/sentence/任意选区都走这条路径。
- word/phrase 可沿用 vocabulary contextual translation 的能力，但接口命名和调用应表达“selection translation”而不是只服务 vocabulary word。
- sentence/长选区不进入 vocabulary feedback 写入逻辑。

### 5. 行为差异

word/phrase：

- 显示统一 tooltip。
- 自动请求 contextual selection translation。
- 显示「我不认识」按钮。
- 点击后写 vocabulary unknown feedback。

sentence/长选区：

- 显示统一 tooltip。
- 自动请求 contextual selection translation。
- 不显示「我不认识」按钮。
- 不写 vocabulary feedback。

高亮词 hover：

- 保持已有「我认识」流程，不要重做。

### 6. 测试要求

新增或补强测试，不要只测组件渲染，要测路径和定位：

- `getViewportAnchorRectsForRange` / selection anchor helper 能把 iframe 内 rect 转成外层 viewport rect，测试里 mock 非零 iframe frame rect，例如 `{ x: 100, y: 80 }`。
- word/phrase selection 渲染统一 tooltip，位置来自 anchor，不来自旧 `{ x, y }`。
- sentence/长选区渲染统一 tooltip，位置来自同一套 anchor 逻辑，不出现旧手工翻译 pop-up。
- sentence/长选区不显示「我不认识」，不调用 unknown feedback。
- word/phrase 仍显示「我不认识」并能调用 unknown feedback。
- 任意选区调用新的 contextual selection translation path。
- anchor 缺失 fallback 不回到明显错误的左上旧位置。
- dev URL bootstrap 在 dev 环境下能设置 `vocabHover` / `vocabDebug`，非 dev 环境下不生效。
- `npm test` 全过。

### 7. 验收标准

- 在 18080 上打开 `?vocabHover=1&vocabDebug=1` 后，词汇高亮出现，Debug panel 出现，或页面/console 明确说明当前开关状态。
- 选中未高亮 word/phrase：tooltip 出现在选区附近，包含翻译和「我不认识」。
- 选中 sentence 或更长文本：tooltip 出现在选区附近，包含翻译，不包含「我不认识」。
- 旧 sentence 左上角 pop-up 和手工翻译按钮不再出现。
- 所有选区浮层都不出现在旧左上角。
- `npm test` 全过。

## 不在范围内

- 不重做高亮词 hover 的「我认识」流程。
- 不重做整篇翻译 / batch translation。
- 不清理 pre-existing dirty files，例如 `docs/obsidian-vault/`、`scripts/obsidian/`。

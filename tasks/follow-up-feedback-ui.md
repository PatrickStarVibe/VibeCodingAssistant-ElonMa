# Follow-up: 反馈 UI 统一 + 闪烁修复 + 自动翻译

## 背景

上一个 task `reader-word-feedback-v1` 已 completed 并被用户验收。已验收 OK 的部分：

- 高亮词 hover → 现有 translation tooltip 右下角加「我认识」按钮 → 点击后该词高亮消失。**这条工作正常，本任务不要动它**

用户验收发现的问题：

1. 未高亮词被选中时，弹出的 Translator（原 popover）行为和视觉不符合预期
2. 点击「标为生词」时整个页面所有高亮会闪烁消失约 0.x 秒再重出
3. Translation Planning 算法当前没有"单词结合上下文翻译"的单次请求模式

## 本 task 范围

把"未高亮词选中"这条流程的 UX 重做，**不动**已验收的"高亮词 hover"流程。

### 1. UI 共用一套组件

让"未高亮词选中"和"高亮词 hover"共用同一个 React 组件和视觉风格（推荐：基于现有 `VocabularyHoverTooltip` 抽取共享组件，或者让两个场景渲染同一个 wrapper）。

按钮文案按上下文切换：
- 高亮词 hover：「我认识」（点击后移除高亮 + 写 userKnownFeedback——保持现状）
- 未高亮词选中（word 或 phrase）：「我不认识」（点击后加高亮 + 写 userUnknownFeedback——替换原"标为生词"）

按钮位置和样式与「我认识」对齐。颜色、圆角、字号、padding、阴影完全一致——不要新设计风格。

### 2. 自动翻译

未高亮词被选中时，**不要等用户点"翻译"按钮**，立即自动调用翻译。

期间显示 pending 状态：spinner 或骨架屏，风格匹配现有 hover tooltip 的 loading 状态（如果已有；没有就用最简单的 spinner + "翻译中..."文案）。

翻译失败时显示错误状态，按钮仍可点（让用户决定标为生词或关闭）。

### 3. 句子选中保持现状

如果选中的是 sentence（依据上一 task 的分类规则：含终结标点或 token > 6），保持当前 Translator 的行为不变——**不**显示「我不认识」按钮，**不**自动翻译（让用户点"翻译"按钮），**不**写入 vocabulary feedback。

句子级翻译属于 translation request，不是 vocabulary feedback。

### 4. 修复"标为生词"导致的全页闪烁

**用户描述**：点击「���为生词」时整个页面所有高亮会闪烁消失约 0.x 秒再重出。

**怀疑根因**（让 Codex 验证）：
- `userVocabularyFeedback` 写入触发了 `USER_VOCABULARY_FEEDBACK_CHANGED_EVENT` 事件
- overlay controller 监听到事件后重跑整个 page analyzer（可能在 `installEpubVocabularyHoverOverlay` 或 `vocabularyOverlayController.ts` 里）
- 重跑期间旧高亮已清除、新高亮还没渲染，造成闪烁

**修复方向**（具体方案让 Planner 决定）：
- **乐观更新**：写入 feedback 后，直接在内存里给当前 highlight 列表加新条目，不重跑全 analyzer
- **增量更新**：只 patch 当前页受影响的高亮节点，不重新渲染整个高亮 layer
- **延迟切换**：双 buffer，新 layer 渲染好了再 swap 替换旧的，避免空窗

不要为了图省事直接禁用事件监听——用户后续 hover 该词需要看到正确的高亮状态。

### 5. Translation Planning 集成（如果需要）

**用户提示**：现有 Translation Planning 算法没有"单词结合上下文翻译"的单次请求模式。如果自动翻译流程需要这个能力，要给 Translation Planning 加这个选项。

让 Codex 先 grep 现有的 translation 入口（`translateText`、`Translator.tsx`、`translation/` 目录），判断：

- (a) 现有 `translateText(text)` 已经够用 → 直接调，不动 Translation Planning
- (b) 单词需要带 context（前后句子）才能翻得准 → 给 Translation Planning 加单次请求接口

如果走 (b)，新增的接口要：
- 接受 `{ text, context, sourceLang?, targetLang? }`
- 返回 `Promise<{ translation, error? }>`
- 不破坏现有批量翻译流程

具体走 (a) 还是 (b) 是技术决策，让 Planner 判断；如果分歧大，让 Manager 在 brief 或 plan 阶段问用户。

## UI 风格约束

- 颜色、圆角、字号、间距、阴影**严格匹配**现有 `VocabularyHoverTooltip`
- 不引入新颜色、新字体、新动画
- pending 状态如果项目里没现成 spinner，参考现有 loading 模式（grep `loading` / `pending` / `spinner`）
- 不允许在反馈卡片之外加新的浮动 UI

## 不在范围内

- 不动已验收的"高亮词 hover → 我认识"流程
- 不改 sentence 选中的行为
- 不接入 vocabulary 评估算法 / 学习模型
- 不改 base vocab、词库、domain tier
- 不做反馈数据的服务器同步
- 不做查看/删除已标记列表的 UI

## 验证

- `npm test` 全过（项目 348+ 测试）
- 新增组件 / 行为的单元测试，沿用现有项目测试风格（让 Codex 看现有测试用什么风格，不要预设）
- 不要求 `npm run lint` 通过——已知 pre-existing lint errors 与本任务无关

## 关键决策点（建议在 brief gate 让用户确认）

- Translation Planning 走 (a) 直调还是 (b) 加单次请求接口
- "未高亮词选中"的自动翻译是同步还是异步（同步阻塞 UI 等翻译，异步先显示 pending）
- 闪烁修复用乐观更新、增量更新、还是双 buffer
- 共用组件的拆分粒度：抽到独立 `VocabularyFeedbackTooltip` 组件，还是 `VocabularyHoverTooltip` 加 prop 控制

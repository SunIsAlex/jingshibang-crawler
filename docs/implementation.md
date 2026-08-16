# 实现说明与验收边界

## 处理链路

```text
正常列表/搜索
  -> 正常详情与 PDF.js Canvas 预览
  -> Canvas 本地截图 + SHA-256
  -> PageSegmenter 本地分区
  -> VisionProvider 严格 JSON 转录
  -> Zod + FormulaValidator + 低置信度二次验证
  -> 必要时 FormulaVisionVerifier 局部复核
  -> 标准化题目 hash 去重
  -> SQLite
  -> Markdown / JSON
```

网站当前样本没有题目 JSON、正文 DOM 或 PDF text layer，所以实际走 Canvas 路径。实现没有猜测逐页图片 URL，也不会点击下载、资料篮、支付等入口。

## 核心模块

- `src/jingshibang/client.ts`：通过真实 SPA 路由发现试卷、等待已观察 API 响应并缓存已渲染 Canvas。
- `src/jingshibang/security.ts`：站点 origin、已观察 API allowlist、下载/支付 denylist 和 paperId 来源守卫。
- `src/vision/`：厂商无关 Provider、严格转录 Prompt、Zod、双阶段复核、局部公式复核、页面裁剪和 Vision Cache。
- `src/database/`：SQLite schema、增量 paper hash、题目去重、来源、选项、图片资产、运行统计和 checkpoint。
- `src/crawler/`：预算、调度、增量跳过、Ctrl+C checkpoint、运行汇总；与 `src/downloader/` 完全分离。
- `src/exporters/markdown.ts`：按试卷或专题导出，复制原始题图；默认不导出答案。

## 置信度

最终置信度不是只采用模型自报值，还会综合：

- FormulaValidator 的结构错误和视觉提示；
- `[UNCERTAIN: ...]` 与不确定区域数量；
- 选择题选项完整性；
- 低置信度二次视觉复核；
- 局部公式复核置信度；
- 跨页标记。

`>=0.95` 为 `confirmed`，`0.80~0.95` 为 `auto_review`，更低为 `needs_review`。人工通过 `npm run review` 查看题目 crop、局部公式 crop 与转录后确认。

## 缓存与增量

- 原始页：实际 PNG 内容 SHA-256 相同则不重写。
- 整卷：详情元数据与所有页面 hash 组成 `papers.content_hash`；已有题目且未变化时跳过分割和 AI。
- Vision：`image_hash + model + prompt_version` 唯一；复核结果使用独立版本键。
- 题目：Unicode NFKC、空白、无意义 HTML、题号和来源前缀标准化后，按正文、选项顺序与图像 hash 计算 SHA-256。
- 来源：重复题目只保留一份正文，通过 `question_sources` 关联多张试卷和多页来源。
- 每完成一页写入 checkpoint；预算耗尽、Ctrl+C 或受限响应不会清除 checkpoint。

## 保守边界

- 当前几何资产采用“原题 crop 原样保存”的保守策略，不让 AI 重绘；尚未实现自动精确切出图形框。
- 跨页合并综合题号、前后续标记与标准化文本相似度；选择题边界使用相邻两张 crop 复核。真实样本第 8、15 题已人工对照并保留多页来源。
- 下载 endpoint 和真实扣额事务没有经过用户明确授权研究，因此 downloader 始终 fail-closed，不能消耗额度。
- 401/403/429 行为没有通过制造错误主动测试；实现只提供保守停止策略。
- 真实整卷采集需要由用户通过 `npm run auth` 为独立 Playwright 会话保存登录状态。

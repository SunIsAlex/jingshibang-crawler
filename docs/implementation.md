# 实现说明与验收边界

## 处理链路

```text
正常列表/搜索
  -> 正常详情与 PDF.js 预览
  -> 被动保存预览已加载的原始 PDF（失败时：Canvas 本地截图）
  -> pdf.js 本地高分辨率渲染 + SHA-256；提取内嵌文字层
  -> 文字层按题号分题、截断答案（无可靠文字层时：PageSegmenter 本地分区）
  -> 纯文字题：直接由 PDF 文字生成；其余：VisionProvider 严格 JSON 转录（附 PDF 文字参考）
  -> Zod + FormulaValidator + 低置信度二次验证
  -> 必要时 FormulaVisionVerifier 局部复核
  -> 标准化题目 hash 去重
  -> SQLite
  -> Markdown / JSON
```

网站当前样本没有题目 JSON 或正文 DOM，预览页面也没有渲染 PDF.js text layer，但页面确实下载了整份 PDF。因此实现优先使用这份 PDF 原件：它由正常预览请求获得，捕获过程只读取已到达浏览器的响应体，不发额外请求。实现没有猜测逐页图片 URL，也不会点击下载、资料篮、支付等入口。

## 原始 PDF 与文字层

- `src/pdf/pdf-capture.ts`：被动监听页面响应，识别 `%PDF-` 内容；支持 PDF.js 的 HTTP 206 分段加载，分段完整覆盖文件后才拼接。若 `filepreview` 返回的是包装 JSON，页面随后自行请求的 PDF 同样会被捕获；不是原始 PDF 时只记录日志并退回 Canvas。保存的来源 URL 会遮蔽 `token`、签名等临时凭据。
- `src/pdf/pdf-document.ts`：pdf.js（Node legacy build + `@napi-rs/canvas`）离线渲染页面、提取文字及其像素坐标；修复部分 PDF 把"页、长"等字映射到 CJK 部首区的问题。
- `src/pdf/text-layout.ts`：文字行聚合、文字层可靠性判断、按严格连续题号分题、大题题型、跨页续题、"参考答案"标题与题号重新从 1 开始的答案区检测、题间【答案】【解析】截断、纯文字题解析与"可否跳过 AI"判定。
- `src/pdf/region-raster.ts`：在渲染图上遮掉所有文字框，统计剩余墨迹（图形、分式线、表格线等），并把成块的剩余墨迹（连同点名等短标签）定位为题图。
- 数据库：`paper_documents` 记录 PDF 的路径、SHA-256、大小、页数和可靠文字层页数；`questions.extraction_method` 记录 `pdf_text`、`vision+pdf_text` 或 `vision`。整卷 content hash 在拿到 PDF 时包含 PDF 的 SHA-256。

只有满足以下全部条件的题目才会跳过 AI：所在页文字层可靠；题干和选项不含拉丁字母、运算符和数学符号（这些需要转成 LaTeX）；没有明显小于正文字号的字符（上下标、分式）；文字框之外几乎没有墨迹（无图形）；选择题能解析出连续的 A、B、C……选项。其余题目一律附带 PDF 文字参考调用视觉模型，Vision Cache 的版本键包含文字参考的 hash。

## 核心模块

- `src/pdf/`：原始 PDF 捕获、本地渲染、文字层分题与图形定位，见上文。
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

- 几何资产不让 AI 重绘。PDF 模式下按"文字之外的墨迹"精确裁出图形框；Canvas 模式仍保存原题 crop，可再用 `npm run assets:refine` 定位。
- `filepreview` 预览的 PDF 即 PDF.js 显示的文件（`type=answer`，含答案页）；它不一定与"下载文档"得到的 Word/PDF 完全相同，后者会消耗下载额度，仍未实现。
- 文字层分题依赖严格连续的阿拉伯数字题号；题号重新从 1 开始会被当作答案区开始，若某份试卷分部分重新编号，后半部分会被保守地跳过并记录日志。
- 跨页合并综合题号、前后续标记与标准化文本相似度；选择题边界使用相邻两张 crop 复核。真实样本第 8、15 题已人工对照并保留多页来源。
- 下载 endpoint 和真实扣额事务没有经过用户明确授权研究，因此 downloader 始终 fail-closed，不能消耗额度。
- 401/403/429 行为没有通过制造错误主动测试；实现只提供保守停止策略。
- 真实整卷采集需要由用户通过 `npm run auth` 为独立 Playwright 会话保存登录状态。

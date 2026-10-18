# 菁师帮题目采集器

在用户本人正常登录、正常页面访问和账号额度范围内，将菁师帮试卷预览转换为结构化题目、SQLite、Markdown 与 JSON。采集器只读取列表、详情，以及正常预览页面为 PDF.js 已经加载的原始 PDF（拿不到时退回读取已渲染的 Canvas）；资料下载是独立且默认关闭的模块。

## 原始 PDF 优先，而不是只靠 OCR

详情页的正常预览会请求一次 `/api/public/filepreview`，把整份 PDF 交给 PDF.js 绘制。采集器在同一页面上被动监听这次响应，直接保存 PDF 原件（支持整包响应和 HTTP 206 分段响应），不发任何额外请求，不点击下载，也不消耗下载额度。之后：

1. **本地高分辨率渲染**：用 pdf.js 在本地按 `PDF_RENDER_SCALE`（默认 2.5，约 180 DPI）渲染页面，不再截取 1215×1718 的预览 Canvas。
2. **读取 PDF 内嵌文字层**：按严格连续的题号（1、2、3……）把页面切成"一题一块"，识别"一、选择题"等大题标题、跨页续题、"参考答案"标题以及题间的【答案】【解析】块，答案内容不会进入 AI 或数据库。
3. **纯文字题不调用 AI**：题干和选项不含拉丁字母或数学符号、没有上下标、文字之外没有图形墨迹时，直接用 PDF 文字生成题目（`extraction_method=pdf_text`）。
4. **其余题目带文字参考调用 AI**：含公式或图形的题目仍交给视觉模型转成 LaTeX，但会附上该区域的 PDF 文字层，汉字、标点和数字以原文为准（`extraction_method=vision+pdf_text`）。
5. **题图精确裁切**：遮掉所有文字框后剩下的墨迹即为图形，题图直接按该区域裁切，不再保存整块题目截图。
6. **自动降级**：PDF 未捕获或无法解析时退回 Canvas 截图；扫描件、乱码等没有可靠文字层的页面退回原来的图像分割 + 视觉识别（`extraction_method=vision`）。

## 安全默认值

- `MAX_DOWNLOADS_PER_DAY=0`：任何资料下载都被拒绝。
- 只接受列表正常发现的 `paperId`，或用户在 `--paper` 中明确提供的单个 ID；不支持范围或枚举。
- 401、403、429 会停止相关批次并保留 checkpoint；不更换账号、Cookie、IP 或代理。
- `.env`、`.local/`、`data/`、`output/` 均被 Git 忽略；日志会遮蔽认证字段、token、API Key 和手机号。
- AI 只负责忠实转录，不解题，不补答案；默认导出不含答案。

## 初始化

要求 Node.js 22.13 或更新版本。

```bash
npm install
copy .env.example .env
npm run db:init
```

项目兼容 OpenAI Chat Completions 风格的多模态服务。当前已验证模型为 `Qwen/Qwen3-VL-32B-Instruct`。在 `.env` 中配置 `API_KEY`、`API_URL`，其余配置可沿用示例。

首次运行需要在脚本打开的浏览器中由用户亲自登录：

```bash
npm run auth
```

登录完成后回到终端按 Enter，授权状态只保存在 `.local/auth-state.json`。

## CLI

```bash
npm run crawl -- --paper 192455 --dry-run
npm run crawl -- --paper 192455
npm run crawl -- --keyword "对数函数"
npm run crawl -- --keyword "解三角形" --year 2025
npm run crawl -- --region "北京" --grade "高三"
npm run crawl -- --resume
npm run crawl -- --paper 192455 --refresh

npm run pdf -- --paper 192455
npm run pdf -- --keyword "对数函数" --page 2

npm run review
npm run assets:refine -- --paper 192455
npm run export -- --paper 192455
npm run export -- --paper 192455 --format json
npm run export -- --paper 192455 --include-answer
npm run export:topic -- --keyword "对数函数"

npm run vision:probe
npm run typecheck
npm test
```

`pdf` 只保存原始 PDF（`data/pdfs/<paperId>.pdf`，并以试卷标题复制到 `output/<paperId>/`），不调用 AI。

相关配置（`.env`）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PREVIEW_SOURCE` | `auto` | `auto` 优先原始 PDF、失败退回 Canvas；`pdf` 必须拿到 PDF；`canvas` 为旧的截图模式 |
| `PDF_TEXT_MODE` | `auto` | `auto` 纯文字题直接解析；`hint` 全部走视觉但附文字参考；`off` 忽略文字层 |
| `PDF_RENDER_SCALE` | `2.5` | 本地渲染倍率（1 = 72 DPI） |
| `PDF_CAPTURE_TIMEOUT_MS` | `15000` | 等待预览 PDF 响应完整到达的时间 |

`crawl` 永远不会进入下载模块。`npm run download -- --resource <id>` 也会在默认额度为 0 或下载 endpoint 尚未由用户授权验证时 fail-closed。

## 数据目录

```text
data/
├── jingshibang.db
├── pdfs/<paperId>.pdf
├── raw-pages/<paperId>/page-001.png
├── question-crops/<paperId>/...
├── formula-crops/<paperId>/...
└── assets/<sha256>.png

output/
├── <paperId>/index.md | index.json | <试卷标题>.pdf
└── topics/topic-<hash>/index.md
```

重复整卷通过页面像素 SHA-256 与试卷内容 hash 跳过；重复 crop 通过 `image_hash + model + prompt_version` 命中 Vision Cache；相同题目通过标准化正文、选项顺序和图片 hash 去重。

站点实测结果见 [docs/site-analysis.md](docs/site-analysis.md)，模型选择见 [docs/model-selection.md](docs/model-selection.md)，实现与已知边界见 [docs/implementation.md](docs/implementation.md)，真实采集验收见 [docs/acceptance.md](docs/acceptance.md)。

# 菁师帮题目采集器

在用户本人正常登录、正常页面访问和账号额度范围内，将菁师帮试卷预览转换为结构化题目、SQLite、Markdown 与 JSON。采集器只读取列表、详情和页面已经渲染的 Canvas；资料下载是独立且默认关闭的模块。

## 安全默认值

- `MAX_DOWNLOADS_PER_DAY=0`：任何资料下载都被拒绝。
- 只接受列表正常发现的 `paperId`，或用户在 `--paper` 中明确提供的单个 ID；不支持范围或枚举。
- 401、403、429 会停止相关批次并保留 checkpoint；不更换账号、Cookie、IP 或代理。
- `.env`、`.local/`、`data/`、`output/` 均被 Git 忽略；日志会遮蔽认证字段、token、API Key 和手机号。
- AI 只负责忠实转录，不解题，不补答案；默认导出不含答案。

## 初始化

要求 Node.js 22 或更新版本。

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

`crawl` 永远不会进入下载模块。`npm run download -- --resource <id>` 也会在默认额度为 0 或下载 endpoint 尚未由用户授权验证时 fail-closed。

## 数据目录

```text
data/
├── jingshibang.db
├── raw-pages/<paperId>/page-001.png
├── question-crops/<paperId>/...
├── formula-crops/<paperId>/...
└── assets/<sha256>.png

output/
├── <paperId>/index.md | index.json
└── topics/topic-<hash>/index.md
```

重复整卷通过页面像素 SHA-256 与试卷内容 hash 跳过；重复 crop 通过 `image_hash + model + prompt_version` 命中 Vision Cache；相同题目通过标准化正文、选项顺序和图片 hash 去重。

站点实测结果见 [docs/site-analysis.md](docs/site-analysis.md)，模型选择见 [docs/model-selection.md](docs/model-selection.md)，实现与已知边界见 [docs/implementation.md](docs/implementation.md)，真实采集验收见 [docs/acceptance.md](docs/acceptance.md)。

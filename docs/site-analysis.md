# 菁师帮站点结构研究

> 研究日期：2026-08-16（Asia/Shanghai）  
> 方法：在用户本人完成正常登录后，通过真实 SPA 页面操作、可见 DOM、Canvas 结构和浏览器已观测资源清单进行只读研究。  
> 安全边界：未点击“下载”“下载文档”“加资料篮”，未触发验证码，未读取 Cookie、localStorage、Authorization、账号详情或接口响应中的私人字段。所有临时预览凭据均记为 `[REDACTED]`。

## 结论摘要

- 当前站点是 Vue 风格的 hash-route SPA。
- 试卷列表首页是 `/home/#/`；关键词搜索页路由实际拼写为 `/home/#/seachList?key=<keyword>`（站点使用 `seachList`，不是 `searchList`）。
- 试卷详情路由是 `/home/#/paperDetail?id=<paperId>&title=<title>&from=试卷&video=0`。
- `paperId` 来自用户正常点击列表卡片后新标签页 URL 的 `id` 查询参数；同时详情页正常请求 `/api/product/detail/<paperId>`。未枚举任何 ID。
- 已观察的两张正常试卷详情都没有结构化题目 DOM，也没有 PDF text layer；整份 PDF 由 PDF.js 渲染成逐页 Canvas。
- 预览不是逐页图片 URL：页面正常请求一次 `/api/public/filepreview?...`，随后 PDF.js 用 `pdf.worker` 将 PDF 渲染为多个 `.pdf-page > canvas`。
- 数学公式与题图均成为 Canvas 像素，不存在可复用的 LaTeX、MathML 或题目 HTML。因此当前样本的数据获取优先级实际落在“Canvas 页面图像 -> 分题裁剪 -> 多模态转录”。
- 正常打开详情即可看到全部预览页，无需点击“下载文档”。本次研究资料下载按钮点击次数为 0。

## 1. SPA 路由结构

实际观察到：

| 页面 | 路由 |
| --- | --- |
| 试卷列表首页 | `/home/#/` |
| 关键词搜索结果 | `/home/#/seachList?key=<URL-encoded keyword>` |
| 试卷详情/预览 | `/home/#/paperDetail?id=<paperId>&title=<URL-encoded title>&from=试卷&video=0` |

列表卡片被点击后，站点会在新标签页打开详情。研究样本包括正常页面动作产生的 `paperId=192839`、`paperId=194023` 和 `paperId=192455`；这些 ID 仅来自可见列表行为，没有推测或枚举。

## 2. 首页和试卷列表路由

`/home/#/` 的“试卷”页展示筛选栏和分页列表。初始真实列表请求：

```text
GET /api/products
  ?page=1
  &limit=20
  &keyword=
  &store_subject=
  &store_grade=
  &store_type=
  &store_year=
  &sort=
  &selectOrder=
  &district=
  &include_assembly=1
```

同一页面还正常请求：

```text
GET /api/store/getcategory
GET /api/city/searchConfig
```

页面也会调用账户、资料篮、消息和额度相关接口。其响应内容与题目整理无关，本次没有读取或保存。

## 3. 搜索请求

在首页搜索框输入“对数函数”并按 Enter，页面进入：

```text
/home/#/seachList?key=%E5%AF%B9%E6%95%B0%E5%87%BD%E6%95%B0
```

实际请求：

```text
GET /api/products
  ?page=1
  &limit=20
  &keyword=%E5%AF%B9%E6%95%B0%E5%87%BD%E6%95%B0
  &tab_type=
  &selectOrder=
```

页面当时显示 270 条结果、20 条/页。

## 4. 筛选请求

列表页的年级、类别、年份、城区、排序会回填 `/api/products` 的查询参数。通过真实点击依次验证：

```text
高二   -> store_grade=%E9%AB%98%E4%BA%8C
2025   -> store_year=2025
西城   -> district=%E8%A5%BF%E5%9F%8E
```

组合筛选时实际请求仍为：

```text
GET /api/products?page=1&limit=20&keyword=
  &store_subject=
  &store_grade=%E9%AB%98%E4%BA%8C
  &store_type=
  &store_year=2025
  &sort=
  &selectOrder=
  &district=%E8%A5%BF%E5%9F%8E
  &include_assembly=1
```

## 5. 分页参数

关键词搜索结果从第 1 页点击到第 2 页后，实际请求由：

```text
GET /api/products?page=1&limit=20&keyword=对数函数&tab_type=&selectOrder=
```

变为：

```text
GET /api/products?page=2&limit=20&keyword=对数函数&tab_type=&selectOrder=
```

因此已确认分页参数是 `page`，每页数量是 `limit`；当前 UI 默认 `limit=20`。

## 6. paperId 从哪里获得

正常列表卡片点击会在新标签页打开：

```text
/home/#/paperDetail?id=<paperId>&title=<title>&from=试卷&video=0
```

实现应只接收以下来源的 `paperId`：

1. 正常 `/api/products` 列表响应中的可见试卷记录；或
2. 正常列表卡片导航后详情 URL 的 `id` 参数；或
3. 用户通过 CLI 显式提供的 ID。

禁止相邻 ID、范围 ID 或随机 ID 枚举。

## 7. paperDetail 的正常请求

详情页实际发出：

```text
GET /api/product/detail/<paperId>
GET /api/smallclass/recommendlist?product_id=<paperId>
GET /api/cart/count
GET /api/city/searchConfig
GET /api/yunoss/get_license_key
```

还观察到：

```text
GET /api/myupload/choose_question?id=<paperId>&type=2
```

这里只能确认该请求由正常详情页产生。由于未读取响应体，不推断其业务含义，正式实现前也不应把它当作题目 JSON 接口。

## 8. 试卷预览请求

两个详情样本都正常请求：

```text
GET /api/public/filepreview
  ?product_id=<paperId>
  &type=answer
  &filepath=<URL-encoded PDF path>
  &token=[REDACTED]
```

同时加载：

```text
/home/assets/PdfRenderer-*.js
/home/assets/PdfRenderer-*.css
/home/assets/pdf.worker.min-*.js
```

预览 URL 含短期访问凭据。实现和日志必须在采集、异常、数据库、checkpoint、Markdown 中统一遮蔽 `token`，不得持久化完整预览 URL。数据库中的 `remote_url` 应保存脱敏模板或不含凭据的规范化 URL；临时凭据只在内存中使用。

## 9. 题目是否存在结构化 JSON

当前只能确认：正常页面请求中没有观察到独立的题目列表 JSON 请求；详情页仅观察到详情、推荐、辅助请求和一次 PDF 预览请求。

`/api/myupload/choose_question` 的响应体未读取，因此不能把它认定为结构化题目 JSON。正式实现必须先检查正常响应的 `Content-Type` 和 schema；只有确认为题目结构化数据时才优先解析。

## 10. DOM 是否含题目正文

不含。

两个样本的 `body.innerText` 只包含站点导航、试卷标题、页数、浏览/下载统计、价格、收藏/纠错/下载按钮和相关推荐。数学试卷正文、选项和公式没有出现在 DOM 文本中。

数学样本中检查到：

```text
.textLayer 数量 = 0
可选择题目文本 = 0
iframe = 0
embed/object = 0
```

## 11. 预览图片 URL 如何产生

当前样本没有逐页图片 URL。

页面通过一次 `filepreview` 请求获得 PDF 内容，再由 PDF.js 在浏览器内绘制 Canvas。实现不应猜测“page-001.png”一类远程 URL；应从正常预览响应或已经渲染的 Canvas 获取当前用户能看到的页面像素。

## 12. 图片分页机制

分页是一页一个 DOM 包装器：

```text
.pdf-scroll-container
  .pdf-page > canvas
  .pdf-page > canvas
  ...
```

观察样本：

| paperId | 页面显示 | `.pdf-page` | Canvas | Canvas 像素尺寸 |
| --- | ---: | ---: | ---: | --- |
| 192839（政治） | 11 页 | 11 | 11 | 1215 × 1718 |
| 192455（数学） | 16 页 | 16 | 16 | 1215 × 1718 |

每个 `.pdf-page` 自身没有题目文本或页码属性。页码只能按正常渲染顺序从 1 开始编号。

## 13. 数学公式采用什么形式

数学公式属于 PDF 页面图像内容，最终只存在于 Canvas 像素中。首屏可见样本包含选择题公式与分式形式，但 DOM 中没有 LaTeX、MathML、KaTeX/MathJax 节点或 PDF text layer。

因此该样本不能从网页直接“保存公式源码”。正确流程是：

```text
Canvas/PDF page raster
  -> PageSegmenter
  -> question crop
  -> VisionProvider 精确转录
  -> Zod schema
  -> FormulaValidator
  -> 必要时局部公式复核
```

后续真实单卷采集已对几何图题和跨页题完成本地原图对照：第 8 题跨第 1–2 页，第 15 题跨第 2–3 页；题图以原始 crop 保存，不做重绘。详细结果见 `docs/acceptance.md`。

## 14. 登录状态如何体现

未登录时需要用户本人完成登录；登录后导航栏显示账户入口，详情和预览正常加载。页面会正常调用账户状态相关请求，但本次没有读取其响应体，也没有读取 Cookie、Authorization、localStorage 或 session storage。

认证实现应仅保存 Playwright `storageState` 到：

```text
.local/auth-state.json
```

并确保 `.local/` 被 Git 忽略。任何日志过滤器必须遮蔽 `cookie`、`authorization`、`token`、`session`、手机号和用户标识。

## 15. 哪些请求需要登录

本次研究在已登录会话中完成，没有通过主动清除认证来制造 401，因此不能逐接口断言匿名权限。

可以确认详情预览 URL携带临时凭据，认证状态与预览访问相关。实现应把详情和预览视为需要正常用户会话的操作；遇到 401 时停止并要求用户重新登录，不能重试绕过。

## 16. 哪些操作会触发资料下载

页面明确提供以下下载相关 UI：

```text
下载
下载文档
加资料篮
资料篮
```

为了不消耗用户额度，本次未点击上述入口，因此没有验证下载请求的具体 endpoint，也不应从脚本文件名推测。

正式 crawler 必须通过选择器、按钮文字和 URL allowlist/denylist 阻止这些动作；downloader 只能由独立命令显式启用。

## 17. 哪些操作只是正常预览

已实际确认：

1. 在列表中点击试卷卡片；
2. 打开 `/paperDetail?id=<paperId>...`；
3. 页面请求 `/api/product/detail/<paperId>`；
4. 页面请求 `/api/public/filepreview?...`；
5. PDF.js 将全部页渲染成 Canvas。

上述流程没有点击下载按钮。它是当前可验证的正常预览路径。

## 18. 每日下载额度在哪里消耗

页面初始化时观察到与免费/收费额度相关的账户接口，但其响应及计数含义未读取。由于本轮严格禁止点击下载，无法通过真实动作确认“哪一个下载请求”最终扣减额度。

安全结论：只有独立 `download` 命令可以进入下载模块；默认 `MAX_DOWNLOADS_PER_DAY=0`。在未完成一次用户明确授权的下载对照实验前，不应实现或调用任何具体下载 endpoint。

## 19. HTTP 401 / 403 / 429 行为

本轮没有主动制造 401、403 或 429；这样做可能涉及认证清除、异常请求或限流触发，与只读低请求研究原则冲突。

实现必须采用保守策略：

- 401：保存 checkpoint，停止，要求用户重新登录。
- 403：立即停止，不换账号、Cookie、IP 或请求形态。
- 429：停止当前批次，记录并遵守 `Retry-After`，保存 checkpoint，不做代理/IP/账号轮换。

这些是客户端安全策略，不是对站点当前响应正文的观察结论。

## 20. 如何整理题目但不触发资料下载

基于真实页面行为，当前安全路径是：

```text
/api/products 正常列表/搜索
  -> 列表响应或正常卡片 URL 获得 paperId
  -> /api/product/detail/<paperId>
  -> 正常详情页产生的 /api/public/filepreview
  -> PDF.js 已渲染 Canvas（或预览响应的 PDF）
  -> 页图缓存与 SHA-256
  -> PageSegmenter
  -> VisionProvider
  -> SQLite / Markdown
```

明确禁止 crawler 点击或调用：

```text
下载
下载文档
加资料篮
资料篮下载
任何未经真实下载 UI 研究确认的下载 endpoint
```

### 下载额度研究统计

```text
下载按钮点击：0
资料篮操作：0
资料下载任务：0
已知资料下载额度消耗：0（本次未执行下载动作）
```

这里的“0”只表示本次研究没有执行下载动作；账户后台是否将普通预览计入其他非下载计数，尚未读取额度数值做前后对账，不能超出证据范围断言。

## 对实现架构的直接影响

1. 当前样本的实际优先级是：结构化题目 JSON（若后续正常响应证实存在） > DOM（当前样本无正文） > PDF/Canvas 多模态；不是逐页远程图片下载。
2. `preview` 模块应同时支持 `pdf_response` 和 `rendered_canvas`，而不是只接受图片 URL。
3. `paper_pages.remote_url` 对 Canvas 页可为空；记录 `source_preview_url_redacted` 或规范化预览请求，不保存 token。
4. PDF 只应正常获取一次；逐页 rasterize、裁剪、重试都在本地完成，避免重复站点请求。
5. 试卷显示“有答案”且预览请求带 `type=answer`。默认题目采集不得主动提取或导出答案/解析；只有页面正常显示且用户显式 `--include-answer` 时才允许导出数据库已有内容。
6. 页面一次请求后渲染整卷，符合“一次详情/预览解析整张试卷”的请求最小化目标。

## 尚待后续验收、不得猜测的项目

- `/api/myupload/choose_question` 的响应 schema 和业务含义。
- `filepreview` 响应是直接 PDF 二进制还是包含临时 PDF 地址的响应封装。（实现两种都兼容：只被动读取页面实际收到的 `%PDF-` 内容，含 HTTP 206 分段；见 `docs/implementation.md`。）
- 几何图题的实际裁剪效果。
- 明确跨页题的 pending/merge 检测效果。
- 下载 endpoint、扣额事务和额度接口字段含义（只有用户显式授权下载研究后才能验证）。
- 401/403/429 的站点响应正文。

在这些项目未通过正常页面行为验证前，实现必须采用 fail-closed 策略，不把猜测写成路由或业务逻辑。

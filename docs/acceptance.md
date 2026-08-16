# 真实采集验收记录

> 日期：2026-08-16  
> 样本：`paperId=192455`，2026 北京西城高一（下）期末数学  
> 模型：`Qwen/Qwen3-VL-32B-Instruct`

## Dry-run

```bash
npm run crawl -- --paper 192455 --dry-run
```

结果确认只计划正常详情与预览页面，AI 仅在 crop 未缓存时调用，资料下载为“否”，预计下载额度消耗为 0。

## 真实页面与数据来源

- 独立 Playwright 会话由用户本人完成登录并保存到 `.local/auth-state.json`。
- 正常详情一次渲染出 16 个 Canvas，Canvas 固定为自身 PNG 数据而非合成截图。
- 人工查看确认第 1–4 页为试题，第 5 页开始是“参考答案/详解”；采集器在第 5 页首个答案 crop 处停止，不处理后续答案页。
- 题目页分割为约 520 像素高的局部 crop，单次通常 1–3 道；过小尾部自动并入前一 crop。

## 最终采集结果

最终强制刷新：

```text
正常页面资源请求：37
页面：16（全部原图缓存命中）
试题页：4
答案边界：第 5 页
结构化题目：18
题号：1–18，无缺失、无重复
AI 新请求：3
Vision Cache 命中：13
二次验证：0
局部公式复核：0
资料下载额度消耗：0
STATUS: SUCCESS
```

3 次新请求用于相邻 crop 上下文修复：第 3、6 题的选项，以及跨页第 8 题的选项。人工对照关键结果：

- 第 3、6 题均恢复 A/B/C/D 四个选项。
- 第 8 题记录 `source_pages=[1,2]`，选项为 A=1、B=2、C=`1/2`、D=`1/3`，与原图一致。
- 第 15 题记录 `source_pages=[2,3]`，续页重复前言被去除。
- 第 13 题跨 crop 合并后来源页去重为 `[2]`。
- 图形题保留原始 crop 资产，不做 AI 重绘。
- 数据库中答案标记题数为 0，`answer`/`analysis` 非空题数为 0。

最终一次普通重复运行：

```text
页面图片缓存命中：16/16
整卷 content hash：未变化
题目处理：0
AI 请求：0
资料下载额度消耗：0
STATUS: SUCCESS
```

这验证了重复运行不会重新识别历史整卷。

## 导出

```text
output/192455/index.md
output/192455/index.json
output/192455/images/<sha256>.png
```

Markdown 默认只含题目、选项和原题图，不含答案或解析。

## 自动验证

```text
TypeScript typecheck：通过
Vitest：11 个测试文件、28 个测试全部通过
npm audit --omit=dev：0 vulnerabilities
Vision Provider 实际探针：严格 JSON 通过，confidence=0.98
```

测试覆盖标准化、去重、站点 schema、公式 Validator、分割、Vision schema、Qwen 思考控制、额度守卫、checkpoint、安全 allowlist、答案边界、跨页合并和题号/选项完整性。

# 多模态模型选择记录

> 验证日期：2026-08-16  
> 安全说明：模型查询和探针只从 `.env` 读取凭据；没有打印或持久化 API Key、API URL 或请求头。

## 模型发现

首先请求 OpenAI-compatible `GET <API_URL>/models`，成功获得 91 个可用模型。返回列表中可识别的视觉候选包括：

- `Qwen/Qwen3-VL-8B-Instruct`
- `Qwen/Qwen3-VL-30B-A3B-Instruct`
- `Qwen/Qwen3-VL-32B-Instruct`
- 对应的 Thinking 变体
- `zai-org/GLM-4.5V`

本项目选择 `Qwen/Qwen3-VL-32B-Instruct`：它支持图片输入，容量高于 8B 版本，同时是适合严格转录的非思考 `Instruct` 变体。

## Qwen 思考控制

服务端实测表明：给 `Qwen/Qwen3-VL-32B-Instruct` 显式发送 `enable_thinking=false` 会返回 HTTP 400，因为该 Instruct 变体不接受此参数；它本身已经是非思考版。因此实现采用以下规则：

1. `*-Thinking` 模型直接拒绝用于严格转录。
2. `Qwen ... *-Instruct` 不发送不兼容的 `enable_thinking`。
3. 其他可配置的 Qwen 模型在 `VISION_THINKING_PARAM_MODE=auto` 时显式发送 `enable_thinking=false`。
4. 无论模型名是什么，只要响应带非空 `reasoning_content` 或 `<think>...</think>`，就拒绝该响应。

如果供应商的兼容层行为不同，可把 `VISION_THINKING_PARAM_MODE` 设为 `always` 或 `never`，但仍保留响应侧推理内容拒绝机制。

## 实际探针

`npm run vision:probe` 将本地脱敏图片转换成 PNG，经正式 `OpenAICompatibleVisionProvider` 发送，并用生产 Zod schema 校验结果。本次结果：

```text
model: Qwen/Qwen3-VL-32B-Instruct
questionCount: 1
schemaValidated: true
type: fill_blank
confidence: 0.98
uncertainRegionCount: 0
elapsed: 约 5.2 秒
```

探针只输出结构摘要，不输出完整题干、答案、推理内容或凭据。对应的回归测试覆盖参数策略与推理字段拒绝。

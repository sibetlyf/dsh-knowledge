# 后台全自动笔记与对话知识整理 (Auto Note Organizer)

面向 DeepSeek Harness 的后台全自动个人知识库与笔记整理功能。支持在对话结束后自动沉淀知识、支持 PDF 资料文本解析，并以类似 Obsidian 的思维标题树与双向链接方式呈现工作内容与知识脉络。

## 核心特性

1. **对话后全自动整理沉淀**：
   - 监听 DSH Agent 轮次结束事件（`agent/turn-stopping`），自动捕获本轮会话关键交流与产出。
   - 结合知识库中未归档的碎片 Markdown 笔记与 PDF 资料进行联合聚类与提炼。
2. **原生 PDF 文本解析提取支持**：
   - 内置纯 TypeScript 健壮 PDF 文本流抽取引擎（`extractPdfText`）。
   - 自动识别解压 `FlateDecode` 压缩流，支持 `BT...ET`、`Tj`、`TJ` 操作符、八进制转义及 UTF-16BE 编码还原。
   - 上传或关联的 `.pdf` 文档无需第三方系统工具即可直接参与后台 AI 整理与知识分析。
3. **Obsidian 风格思维标题树与工作内容呈现**：
   - **思维标题树（知识脉络）**：使用严密的多级标题（`#`、`##`、`###`）构建大纲，并大量采用 Obsidian 风格双向链接（`[[关联概念或笔记]]`）构建网状图谱。
   - **对应工作内容与决策归集**：结构化提取已完成工作要点、代码架构方案及关键决策依据。
   - **待办与后续行动**：自动生成 Markdown 任务清单（`- [ ] 任务`）。
4. **安全待审阅草案机制（Review Proposals）**：
   - 后台整理结果先持久化存入 `note_proposals` 草案表（状态为 `pending`），**绝不直接覆写用户原有笔记**。
   - 提供差异预览与审批接口：人工确认通过后，自动在目标目录（如“整理归档”）下创建正规 Markdown 笔记并生成版本历史；若不满意可随时一键拒绝废弃。

## 配置项说明

在插件配置文件中支持以下参数：

| 参数 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `noteOrganizeEnabled` | `boolean` | `false` | 全局开关：是否开启后台自动整理 |
| `noteOrganizeTargetFolder` | `string` | `'整理归档'` | 整理生成的笔记存放的文件夹名称 |
| `noteOrganizePrompt` | `string` | 见说明 | 自定义提炼整理提示词与要求 |
| `noteOrganizeIntervalMinutes` | `number` | `60` | 后台定时扫描整理间隔（单位：分钟） |
| `noteOrganizeMinNotes` | `number` | `2` | 触发自动整理的未归档最少素材数量 |

## 控制与 REST API

插件提供以下管理端点：

- `GET /knowledge-control/v1/note-proposals`：查询草案列表（支持 `?status=pending` 筛选）。
- `GET /knowledge-control/v1/note-proposals/:id`：获取特定草案详情，包含生成的 Markdown 内容和解析后的 `mindmapJson`（树形大纲结构）。
- `POST /knowledge-control/v1/note-proposals/:id/approve`：审批通过，自动在目标目录创建 Markdown 笔记。
- `POST /knowledge-control/v1/note-proposals/:id/reject`：拒绝草案。
- `POST /knowledge-control/v1/note-organize/run`：手动立即触发一次后台整理扫描任务。

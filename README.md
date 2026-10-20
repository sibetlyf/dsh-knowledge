# DSH Knowledge

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的全栈个人知识库、笔记与工作日报插件。支持本地使用和远程中央知识库，完全基于 Cordis 依赖注入内核开发，**不修改 DSH Agent Loop**。

[![GitHub Repository](https://img.shields.io/badge/GitHub-sibetlyf%2Fdsh--knowledge-blue?logo=github)](https://github.com/sibetlyf/dsh-knowledge)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## 核心功能

- **后台全自动知识与笔记整理（新功能）**：
  - 对话结束后监听 `agent/turn-stopping` 自动捕获交流产出，后台提炼核心认知。
  - **支持 PDF 文本解析**：内置纯 TypeScript PDF 文本抽取引擎，无需外部工具即可自动解析 `.pdf` 资料并参与知识整理。
  - **Obsidian 风格思维标题树与双链**：输出 Obsidian 风格的多级标题大纲树（`#`、`##`、`###`）与网状双向链接（`[[主题]]`）。
  - **对应工作内容与任务清单呈现**：自动提炼出结构化的已完成工作记录、技术决策归集，以及 `- [ ]` 待办清单。
  - **安全待审阅草案流（Review Proposals）**：AI 整理产出存入草案表，支持人工预览与一键批准/拒绝，绝不直接覆盖原始笔记。
- **知识库与多范围挂载**：
  - 知识库与文档分组、FTS5 全文检索、项目和会话多层级挂载，按精确权限召回与回写。
  - 回答生成前注入有界摘要，回答完成后后台独立提取知识，具备版本历史、冲突保护、任务重试与文档封存机制。
- **独立笔记工作区与输入框 `@` 引用**：
  - 独立的树形笔记文档目录：支持 Markdown、文本编辑、图片与 PDF 就地预览、历史版本回退与分享。
  - 聊天输入框键入 `@` 可快速联想并引用笔记文档。
- **内置工作日报系统（Worklog）**：
  - 按本机工作目录选择采集范围，自动汇总会话与项目开发活动；支持人工补记、整理与 Markdown 导出。
- **灵活的部署模式**：
  - 支持本地单机 SQLite WAL 存储，或作为认证的中央知识库服务（提供 REST API，支持多客户端协同）。

---

## 安装与配置

### 运行环境
- 适配 DeepSeek Harness **0.2.1-rc.2**
- Node.js **^22.19.0 或 >=24.0.0**

### 安装方式

```bash
dsh plugin --profile web add dsh-knowledge
```

> 注：安装或更新后请重启对应的 DSH Profile。

### 配置说明

可在 DSH 的插件配置中开启后台自动笔记整理：

```yaml
noteOrganizeEnabled: true               # 是否开启后台自动整理（默认 false）
noteOrganizeTargetFolder: '整理归档'     # 整理生成的笔记存放的文件夹名
noteOrganizePrompt: '对所有对话产出、笔记及文档进行深度提炼，提取核心主题、工作产出，并生成思维树与双链'
noteOrganizeIntervalMinutes: 60        # 后台定时扫描轮询间隔（分钟）
noteOrganizeMinNotes: 2                # 触发自动整理的未归档最少素材数量
```

---

## 架构与实现设计

- **非侵入式设计**：不入侵修改 DSH 主循环，通过标准 Agent Tools、Prompt 挂载组装、InputTriggers 以及 Client Slots 扩展点无缝集成。
- **前后端同构插件**：
  - **后端（Node.js）**：基于 Cordis 微内核架构，注册 `LocalKnowledgeProvider`、`ExtractionCoordinator`、`NoteAutoOrganizer` 与 HTTP REST API。
  - **前端（Client UI）**：通过 esbuild 打包成标准 DSH 客户端脚本，无缝注入侧栏图标、输入框 `@` 触发器及实时回写任务视图。
  - **控制台（Web App）**：内嵌基于 Tiptap 富文本编辑器、Markdown 预览与变更审查界面的独立文档工作区。

---

## 文档索引

- [后台自动笔记整理与 PDF 支持详细说明](docs/auto-note-organizer.md)
- [使用、权限与部署配置说明](docs/usage.md)
- [输入框 @ 笔记文档引用指南](docs/note-mentions.md)
- [文档分组设计](docs/document-groups.md)
- [系统架构与实现形式分析](docs/architecture.md)

---

## 开源协议

本项目采用 [MIT 许可证](LICENSE)。

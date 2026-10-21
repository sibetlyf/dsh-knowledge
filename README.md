# DSH Knowledge

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的全栈个人知识库、笔记与工作日报插件。支持本地使用和远程中央知识库，完全基于 Cordis 依赖注入内核开发，**不修改 DSH Agent Loop**。

[![GitHub Repository](https://img.shields.io/badge/GitHub-sibetlyf%2Fdsh--knowledge-blue?logo=github)](https://github.com/sibetlyf/dsh-knowledge)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## 核心功能

- **任务文件自动归档与知识化（新功能）**：
  - 每轮对话结束自动识别**任务涉及的所有文件**：`present` 交付物、工具读取/写入/转换的文件、shell 与 workspace-changes 变更、用户上传附件与 `@` 引用，**无需确认或审批**即可归档并纳入知识库。
  - 归档副本内容寻址保存，默认支持**任意格式**（图片、PDF、Word、Excel、PowerPoint、ODF、压缩包、音视频、源码等），未知格式保留原始文件并提供下载。
  - **文件放在归档文件夹，数据库只保存链接、元数据与关键词**（默认不复制正文，`artifactArchiveStoreContent: false`）；知识文档给出绝对文件路径与 `read` 提示，PDF/Office 抽取文字仅用于生成关键词。
  - 自动创建并挂载 `制品归档` 知识库（仅召回、不参与对话回写），文件按类别自动归入 `文档 / 表格 / 演示 / 图片 / 压缩包 / 音视频 / 代码 / 其他` 栏目并参与双向链接。
  - 没有可写挂载时自动把「默认知识库」以可写模式挂载到项目；新建知识栏目与普通待审候选都会自动落盘，不再需要人工审核（冲突与凭据类内容仍保留安全拦截）。
  - 控制台新增「制品文件」页面：按格式预览图片、PDF、纯文本、音视频，下载任意文件，并一键打开对应知识文档进行编辑、调整分组或移动。
  - 默认排除密钥、数据库与依赖目录，可配置扩展名、大小上限与排除模式。详见 [制品自动归档](docs/artifacts.md)。
- **自动分类与免审核**：
  - AI 提取时优先复用已有知识库与文档分组；现有栏目都不适合时，可自动新建知识栏目（知识库）并直接写入。
  - 后台定期自动批准非冲突的待审核候选，笔记整理草案也直接落盘；仅凭据类内容和真实冲突保留人工确认。
- **后台全自动知识与笔记整理（新功能）**：
  - 对话结束后监听 `agent/turn-stopping` 自动捕获交流产出，后台提炼核心认知。
  - **支持 PDF 文本解析**：内置纯 TypeScript PDF 文本抽取引擎，无需外部工具即可自动解析 `.pdf` 资料并参与知识整理。
  - **Obsidian 风格思维标题树与双链**：输出 Obsidian 风格的多级标题大纲树（`#`、`##`、`###`）与网状双向链接（`[[主题]]`）。
  - **对应工作内容与任务清单呈现**：自动提炼出结构化的已完成工作记录、技术决策归集，以及 `- [ ]` 待办清单。
  - **自动落盘的整理草案**：AI 整理产出直接保存到目标笔记目录（`noteOrganizeAutoApprove`，默认开启）；关闭后仍可在草案表中人工预览与批准/拒绝。
- **知识库与多范围挂载**：
  - 知识库与文档分组、FTS5 全文检索、项目和会话多层级挂载，按精确权限召回与回写。
  - **全量双向链接**：每篇知识文档自动显示「关联文档 / 反向链接」，按共同标签、同一分组与标题主题计算关联；只读/定稿预览中的 `[[文档标题]]` 渲染为可点击链接并支持反向跳转，无需手工维护。
  - **思维链接图**：管理台「思维链接」页把整库文档画成动态力导向关系图，支持拖动、缩放、悬停高亮、点击打开文档与导出 PNG，并可从任意文档的「关系图」按钮直接进入。
  - **后台运行可视化**：顶栏右侧常驻后台状态卡实时显示自动归档、知识回写与日报整理的排队/进度，完成后短暂提示；空闲时显示“后台自动整理”已开启。
  - **阅读优先的布局**：正文、导航与目录字号整体放大；知识目录改为可滑出的抽屉，不再永久占用左侧第三列，文档区域默认占满宽度。
  - **自动恢复与自动保存**：再次打开知识文档会恢复上次阅读的文档，没有历史时自动打开最近更新的一篇；编辑后停止输入约 1.4 秒自动保存，减少“找文档、点保存”的重复操作。
  - 回答生成前注入有界摘要，回答完成后后台独立提取知识，具备版本历史、冲突保护、任务重试与文档封存机制。
- **独立笔记工作区与输入框 `@` 引用**：
  - 独立的树形笔记文档目录：支持 Markdown、文本编辑、图片与 PDF 就地预览、历史版本回退与分享。
  - 聊天输入框键入 `@` 可快速联想并引用笔记文档。
- **内置工作日报系统（Worklog）**：
  - 按本机工作目录选择采集范围，自动汇总会话与项目开发活动；支持人工补记、整理与 Markdown 导出。
  - **知识库更新后自动刷新日报**：对话知识回写与制品归档会实时写入当天日报素材，后台防抖整理并更新日报；首次使用自动为当前项目开启采集与每日生成，可用 `worklogAutoUpdateEnabled` 关闭。
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

制品自动归档默认开启，可在插件配置中调整：

```yaml
artifactArchiveEnabled: true           # 自动归档任务涉及的所有文件并纳入知识库（默认 true）
artifactArchiveBaseName: '制品归档'    # 目标知识库名称，不存在时自动创建
artifactArchiveExtensions: ['*']        # 默认归档所有格式；可改成扩展名列表收窄文件工具写入
artifactArchiveExclude: ['**/node_modules/**', '**/.env']     # 排除路径模式
artifactArchiveMaxFileBytes: 33554432  # 单文件上限（字节，默认 32 MiB）
artifactArchiveMaxChars: 46000          # 开启正文入库时的正文上限
artifactArchiveStoreContent: false      # 默认只存链接/元数据/关键词；true 才把抽取正文写入数据库
artifactArchiveAutoMount: true         # 自动挂载制品库到项目以参与召回
autoWritableMountEnabled: true         # 无可写知识库挂载时自动挂载「默认知识库」
autoWritableMountWriteMode: direct     # direct 直接写入；audit 进入待审核
autoCreateKnowledgeBases: true         # 现有栏目都不适合时自动新建知识栏目（知识库）
autoApprovePendingEnabled: true        # 自动批准非冲突待审候选，取消人工审核
autoApprovePendingIntervalMinutes: 2   # 自动批准轮询间隔（分钟）
noteOrganizeAutoApprove: true          # 笔记整理草案直接落盘
worklogAutoUpdateEnabled: true         # 知识库更新后自动记录素材并刷新当天日报
```

数据默认存放在非系统盘（Windows 下优先插件所在盘，如 `G:\dsh-knowledge`），可用 `DSH_KNOWLEDGE_HOME` 覆盖；首次启动会把旧 C 盘用户目录的知识库与归档复制到新目录，旧目录保留为备份。

---

## 架构与实现设计

- **非侵入式设计**：不入侵修改 DSH 主循环，通过标准 Agent Tools、Prompt 挂载组装、InputTriggers 以及 Client Slots 扩展点无缝集成。
- **前后端同构插件**：
  - **后端（Node.js）**：基于 Cordis 微内核架构，注册 `LocalKnowledgeProvider`、`ExtractionCoordinator`、`NoteAutoOrganizer` 与 HTTP REST API。
  - **前端（Client UI）**：通过 esbuild 打包成标准 DSH 客户端脚本，无缝注入侧栏图标、输入框 `@` 触发器及实时回写任务视图。
  - **控制台（Web App）**：内嵌基于 Tiptap 富文本编辑器、Markdown 预览与变更审查界面的独立文档工作区。

---

## 文档索引

- [制品自动归档与知识化说明](docs/artifacts.md)
- [后台自动笔记整理与 PDF 支持详细说明](docs/auto-note-organizer.md)
- [使用、权限与部署配置说明](docs/usage.md)
- [输入框 @ 笔记文档引用指南](docs/note-mentions.md)
- [文档分组设计](docs/document-groups.md)
- [系统架构与实现形式分析](docs/architecture.md)

---

## 开源协议

本项目采用 [MIT 许可证](LICENSE)。

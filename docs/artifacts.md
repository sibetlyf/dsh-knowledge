# 制品与任务文件自动归档

`dsh-knowledge` 会把**任务中涉及的所有文件**自动归档、分类并纳入知识库：交付物、工具读写的文件、shell 变更、用户上传与 `@` 引用的文件都走同一套流程。整个流程没有确认、审批或挂载步骤：插件在后台完成，不进入主 Agent 的上下文，也不修改 DSH Agent Loop。

## 什么会被归档

每轮对话结束（`agent/turn-stopping`）时，插件只读取**本轮自己的会话事件**，因此结果与断线恢复、分支和重放保持一致：

| 来源 | 说明 |
|---|---|
| `deliverables/presented` | Agent 用 `present` 声明的交付物，包括由 shell 命令生成、随后被声明的文件；任意格式 |
| `tool/call` 参数 | 所有工具调用中的 `file_path` / `path` / `files` 等路径：`read`、`read_image`、`str_replace_editor view` 读取的文件，`write` / `edit` 写入的文件，转换、处理类工具输入输出的文件 |
| shell 命令 | `bash` / `pwsh` 命令字符串中可识别的路径；命令中无法可靠推断时由 `workspace/changes` 事件补充 |
| `workspace/changes` | 已挂载 workspace-changes 插件时，本轮实际变更的文件（含 shell/git 修改，不依赖文件工具） |
| `user/message` 文本 | 用户输入中的 `@path` / `@"path"` 引用 |
| `user/message` 的 `file` / `image` 块 | 用户在输入框上传的附件，由 Host `attachments` 服务读取字节；任意格式 |

同一路径在一轮内只处理一次，并保留最强的来源（`present` > 文件工具 > 引用/变更）。所有候选都会校验存在性、常规文件、大小上限、排除规则与归档目录边界，命令或正文中的普通单词不会被当成文件。

## 自动分类与栏目

- **对话知识**：AI 提取时优先复用目标知识库中已有文档分组；没有合适分组时自动新建一个主题分组，写入不同栏目。
- **自动新建栏目**：当现有已挂载知识库的适用范围都不匹配时，提取模型可以请求一个全新的知识栏目（知识库）。插件按名称复用同名栏目或自动创建新知识库，说明文字作为后续路由依据，并立即以可写方式挂载到当前项目（默认 `direct`）。每轮最多新建一个栏目，避免知识库爆炸。
- **制品文件**：按文件类别自动归入 `制品 · 文档`、`制品 · 表格`、`制品 · 演示`、`制品 · 图片`、`制品 · 压缩包`、`制品 · 音视频`、`制品 · 代码`、`制品 · 其他` 栏目。

## 取消人工审核

自动流程默认直接落盘，不产生需要人工点击的审批：

- 新的可写挂载以 `direct` 模式创建；
- 自动新建栏目直接写入；
- 后台每 `autoApprovePendingIntervalMinutes`（默认 2 分钟）自动批准非冲突的待审核候选，并在每轮结束时触发一次；
- 笔记自动整理草案在 `noteOrganizeAutoApprove` 开启时直接落盘。

保留的两个安全例外：**真实冲突**（同一段原文被两方改写，无法自动判断）和**凭据类内容**（密码、令牌、私钥等）仍需人工确认，避免自动写入错误或泄密。可在配置中关闭自动批准。

## 工作日报联动

知识库写入会同步成为工作日报素材，并在后台刷新当天日报：

- 对话知识回写与制品归档完成后，插件记录一条 `知识库更新：<文档标题>` 来源（含知识库、文档、动作、项目、会话与轮次）；管理台手工编辑由后台巡检（约 1 分钟）补充发现；
- 连续写入按 8 秒防抖合并，交给日报整理队列在后台调用模型生成/更新日报，页面可查看进度；生成期间新增的素材会在完成后继续整理；
- 首次触发自动为该项目开启采集并启用每日生成；手工编辑过的日报不会被自动覆盖；
- 远程模式下来源进入上传队列，由中央按自身配置生成；
- 可用 `worklogAutoUpdateEnabled: false` 关闭联动，日报仍可按原有方式手动或定时使用。

详细说明见 [使用与配置 · 知识库更新触发自动日报](usage.md#知识库更新触发自动日报)。

## 归档副本

- 归档目录默认为知识库数据目录（非系统盘，如 `G:\dsh-knowledge`）下的 `artifacts/`，也可用 `artifactArchivePath` 指定。
- 内容寻址：`blobs/<sha256 前两位>/<sha256>.<扩展名>`。相同内容的多次归档只保存一份；每次内容变化都会保留旧版本字节，源文件被修改或删除后仍可回溯。
- 索引 `index.json` 记录每个路径的稳定编号、SHA-256、大小、媒体类型、来源、会话、轮次、版本号、知识文档编号和归档副本相对路径。写入使用原子替换，文件权限 `0600`。
- 同一路径再次变化时**原地更新**同一篇知识文档，产生新版本；版本历史、全文索引与 Markdown 投影由知识库统一维护。
- **文件保存在文件夹，数据库只存链接**：SQLite 中的知识文档保存源文件路径、归档副本路径、SHA-256、类型、大小、来源、会话、关键词和读取提示，不复制文件内容；完整字节只存在于 `blobs/` 目录，通过绝对文件路径链接。

## 知识文档

每篇制品文档：

- 标题：`制品 · <相对路径>`；上传附件为 `制品 · 用户上传/<文件名>`；无法相对化时使用绝对路径。
- 分组：按文件类别整理的 `制品 · <类别>` 栏目。
- 类型：`fact`；标签包含 `artifact`、`involved`、`deliverable`（上传为 `upload`）、扩展名和来源（`presented` / `file-tool` / `reference` / `workspace-change`）。
- 范围：会话工作目录对应的项目；没有工作目录时使用全局。
- 正文：源文件、归档副本、**绝对文件路径**、大小、媒体类型、SHA-256、来源、会话与轮次、可选说明、**关键词**，以及 `使用 read 工具读取` 的提示；默认**不写入抽取出的正文**。
- 来源证据为 `verified`，置信度为 1。

关键词从文件内容（或文件名）提取，最多 12 个，写入知识文档正文参与检索，并用于跨文件的双向链接/关系图关联。需要把正文也复制进数据库时，可设置 `artifactArchiveStoreContent: true`。

文本、Markdown、CSV/TSV/JSON/YAML/XML/HTML 直接读取；PDF 使用内置纯 TypeScript 解析器；`.docx`、`.pptx`、`.xlsx` 与 `.odt/.ods/.odp` 从 Open XML / ODF 容器里抽取可见文字（Word 正文、页眉页脚与脚注，演示文稿逐页，表格按行转 TSV）。图片、压缩包、音视频与其他二进制保留元数据，原始字节以归档副本为准。抽取文字默认只用于生成关键词，开启 `artifactArchiveStoreContent` 后才写入正文，并按 `artifactArchiveMaxChars` 截断。

## 手动查看、预览、下载、编辑与移动

管理台「知识工作区 → 制品文件」提供人工浏览界面：

- 按名称、类型或来源搜索，查看大小、类别、来源与更新时间；
- 预览图片、PDF、纯文本/代码/CSV/JSON 等、音频与视频；其他格式提示下载；
- 下载任意格式的原始文件；
- 「打开知识文档」跳转到自动生成的 Markdown 文档，在既有编辑器里修改正文、调整文档分组，或移动到其他知识库/分组，并保留版本历史。

知识文档本身同样支持重命名、编辑、分组拖拽、跨知识库移动与删除；归档副本保持不可变，作为原始依据。

## 自动挂载

第一次归档某个项目的制品时：

1. 查找 `artifactArchiveBaseName`（默认 `制品归档`）的生效知识库，不存在则自动创建，说明、默认标签与回写策略一并写入；
2. 在项目上写入一个 `writeMode: none`、`recallEnabled: true` 的挂载。

`writeMode: none` 让制品库只参与召回，**不会**把对话提取的普通知识写进去；后续 `knowledge_base_search` / `knowledge_search` / 自动召回可以直接找到这些制品文档。已有挂载（尤其是用户关闭了召回的挂载）不会被覆盖；知识库被人工归档后，插件停止自动归档，尊重这个决定。

## 自动补齐可写知识库

制品库是只读召回的，因此仅靠它无法完成对话知识回写。插件在每轮的第一个模型步骤（`agent/pre-step`）检查项目挂载：如果**没有任何可写挂载**（`enabled` 且 `writeMode` 不是 `none`），就自动把内置的「默认知识库」以 `autoWritableMountWriteMode`（默认 `direct`，可改为 `audit`）挂载到该项目，并在 `agent/turn-stopping` 再兜底检查一次。不再出现“未挂载可写知识库”导致无法写入的情况。

该行为尊重显式设置：

- 已有任意可写挂载时不做任何修改；
- 「默认知识库」的挂载被关闭（`enabled: false`）或被设为 `writeMode: none` 时保持原样，不强行覆盖；
- 连接切换（本地 ↔ 远程）后重新检查新 Provider 上的挂载；
- 没有工作目录的会话不创建任何挂载。

## 配置

```yaml
artifactArchiveEnabled: true            # 总开关，默认开启
artifactArchiveBaseName: '制品归档'      # 目标知识库名称，不存在时自动创建
# artifactArchivePath: 'D:/knowledge/artifacts'   # 默认与数据库相邻
artifactArchiveExtensions: ['*']          # 默认归档所有格式；可填扩展名列表收窄（只影响文件工具写入）
artifactArchiveExclude: ['**/node_modules/**', '**/.env']     # 默认已含密钥与数据库文件
artifactArchiveMaxFileBytes: 33554432   # 单文件上限 32 MiB
artifactArchiveMaxChars: 46000          # 开启正文入库时的正文上限
artifactArchiveStoreContent: false      # 默认只存链接/元数据/关键词；true 才把抽取正文写入数据库
artifactArchiveMaxEntries: 20000        # 索引记录上限（超出时淘汰最久未更新的记录）
artifactArchiveAutoMount: true          # 自动挂载制品库到项目以便召回
autoWritableMountEnabled: true          # 无可写挂载时自动挂载默认知识库
autoWritableMountWriteMode: direct      # direct 直接写入；audit 进入待审核
autoCreateKnowledgeBases: true          # 现有栏目都不适合时自动新建知识栏目
autoApprovePendingEnabled: true         # 自动批准非冲突待审候选
autoApprovePendingIntervalMinutes: 2    # 自动批准轮询间隔（分钟）
noteOrganizeAutoApprove: true           # 笔记整理草案直接落盘
worklogAutoUpdateEnabled: true          # 知识库更新后自动记录素材并刷新当天工作日报
```

默认归档**所有格式**（`artifactArchiveExtensions: ['*']`）：调用工具读写、shell 变更、`@` 引用、`present` 与上传的文件都会进入知识库。可把该项改成扩展名列表来收窄文件工具写入的归档范围，读取/引用/变更/交付/上传仍然按“任务涉及即归档”处理。

注意事项：

- 归档读取的是 Host 上的文件；Agent 的工具沙箱权限不改变 Host 的读取范围。
- 归档副本保存的是文件内容。**不要在任务文件中写入密钥**；默认排除规则会跳过 `.env`、`*.pem`、`*.key`、SQLite 数据库和 `node_modules`。
- 源码文件（`.ts`/`.js` 等代码类）会归档并参与双向链接，但不会写入工作日报素材，避免日报被代码文件淹没。
- 远程知识库模式下归档与自动挂载同样需要 `write` 权限；没有权限时只记录日志，不阻塞对话或其他回写。
- 上传附件通过 Host `attachments` 服务读取；服务不可用或超过大小上限时跳过该附件，不影响其他文件。图片归档的是准入后的规范化副本。
- 单个文件失败只影响该文件；归档任务串行执行，不阻塞 `agent/turn-stopping` 的返回。
- 只读接口：`GET /knowledge-control/v1/artifacts` 列出最近 500 条记录，`GET /knowledge-control/v1/artifacts/<id>` 下载归档副本。与其它管理接口一样，请求必须来自同源管理台并携带 `x-dsh-knowledge-client: management-web` 请求头。

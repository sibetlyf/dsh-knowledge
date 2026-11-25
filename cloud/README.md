# 团队知识库（独立云端服务）

一个轻量的团队协作知识库：团队成员用浏览器登录同一个知识库，浏览、搜索、下载和编辑文档。服务端只需要 Node.js 24 和一个持久化目录，不安装 DSH，也不运行模型。

```text
浏览器 ── HTTPS ── Caddy ── Node 服务
                               │
                       knowledge.sqlite
                       team.sqlite
```

## 当前范围

- 一个团队共用同一批知识库；所有成员都能看到相同的目录和文档。
- 角色：管理员、编辑者、阅读者。
- 管理员生成一次性邀请链接；成员用自己的邮箱和密码领取账号。
- 编辑采用文档级版本检查：两人同时编辑，后保存的人收到冲突提示，草稿保留，可载入新版后重试。
- 文档支持 Markdown 阅读、搜索、编辑、下载；保留原有知识库版本记录。
- 文档级分享、整库公开分享属于 DSH 侧功能；这个独立服务默认只对登录成员开放，不暴露匿名分享。

第一版没有逐字实时协同、没有在线附件上传、没有 SSO。适合 3–10 人的团队知识整理；并发很高或需要附件库时再扩展。

## 快速开始

### 1. 构建安装包

在开发机仓库根目录：

```powershell
npm run build
npm pack
```

得到类似：

```text
lemoncat7-dsh-knowledge-2.22.10-custom.1.tgz
```

### 2. 服务器安装 Node.js 24

以 Ubuntu/Debian 为例：

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs sqlite3
node -v   # 应为 v24.x
```

### 3. 安装应用

```bash
sudo mkdir -p /opt/team-kb/data
sudo useradd --system --home /opt/team-kb --shell /usr/sbin/nologin teamkb || true
sudo chown -R teamkb:teamkb /opt/team-kb
sudo -u teamkb npm install --prefix /opt/team-kb --omit=dev --ignore-scripts /tmp/lemoncat7-dsh-knowledge-2.22.10-custom.1.tgz
```

应用入口：

```text
/opt/team-kb/node_modules/@lemoncat7/dsh-knowledge/cloud/server.mjs
```

### 4. 配置环境变量

复制示例：

```bash
sudo cp /opt/team-kb/node_modules/@lemoncat7/dsh-knowledge/cloud/deploy/team-kb.env.example /etc/team-kb.env
sudo chmod 600 /etc/team-kb.env
```

首次启动可以用环境变量创建管理员：

```text
TEAM_ADMIN_EMAIL=you@example.com
TEAM_ADMIN_PASSWORD=至少十位的强密码
TEAM_ADMIN_NAME=管理员
```

也可以不设置，启动后打开 `/setup` 创建第一个管理员。创建后把 `TEAM_ADMIN_PASSWORD` 从环境文件删除并重启。

关键变量：

| 变量 | 说明 |
|---|---|
| `TEAM_DATA_DIR` | 数据目录，默认 `cloud-data`（部署时改成 `/opt/team-kb/data`） |
| `TEAM_KB_DB` | 知识库 SQLite，默认 `$TEAM_DATA_DIR/knowledge.sqlite` |
| `TEAM_TEAM_DB` | 成员和会话 SQLite，默认 `$TEAM_DATA_DIR/team.sqlite` |
| `TEAM_HOST` | 默认 `127.0.0.1`，不要直接改成公网 `0.0.0.0` 除非前面有防火墙 |
| `TEAM_PORT` | 默认 `8787` |
| `TEAM_PUBLIC_ORIGIN` | 例如 `https://kb.example.com`，用于安全 Cookie 和邀请链接 |
| `TEAM_TRUST_PROXY` | 在 Caddy/Nginx 后面设为 `1`，用于识别 HTTPS 和真实 IP |
| `TEAM_TITLE` | 页面标题 |
| `TEAM_SESSION_DAYS` | 登录会话天数，默认 7 |
| `TEAM_MAX_BODY_BYTES` | 单篇文档正文上限，默认 5 MiB |
| `TEAM_MAX_FILE_BYTES` | 单个文件上限，默认 100 MiB，可调到 1 GiB |

### 5. 导入原有知识库（可选）

先在 DSH 停止写入，使用 SQLite 的在线备份，避免直接复制正在写入的 WAL：

```bash
sqlite3 /path/to/knowledge.sqlite ".backup '/tmp/knowledge.sqlite'"
scp /tmp/knowledge.sqlite server:/tmp/knowledge.sqlite
ssh server
sudo -u teamkb cp /tmp/knowledge.sqlite /opt/team-kb/data/knowledge.sqlite
sudo chown teamkb:teamkb /opt/team-kb/data/knowledge.sqlite
```

服务启动后，原知识库的 3 个库、840+ 篇文档会直接出现在团队页。不要把 `team.sqlite` 覆盖到旧库。

### 6. 启动

```bash
sudo -u teamkb env $(cat /etc/team-kb.env | xargs) node /opt/team-kb/node_modules/@lemoncat7/dsh-knowledge/cloud/server.mjs
```

浏览器打开：

```text
http://服务器IP:8787
```

生产环境应只让 Caddy 访问该端口，见下一节。

## HTTPS 与反向代理

安装 Caddy 后写入 `/etc/caddy/Caddyfile`：

```caddyfile
kb.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787
}
```

```bash
sudo systemctl reload caddy
```

应用端环境：

```text
TEAM_HOST=127.0.0.1
TEAM_PUBLIC_ORIGIN=https://kb.example.com
TEAM_TRUST_PROXY=1
```

防火墙只开放 `80/443`，不要开放 `8787`。

## Docker（可选）

在仓库根目录构建（需要先生成 `lib/`）：

```bash
npm run build
docker build -f cloud/Dockerfile -t team-kb:local .
```

运行：

```bash
docker run -d --name team-kb \
  --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -v /opt/team-kb/data:/data \
  -e TEAM_PUBLIC_ORIGIN=https://kb.example.com \
  -e TEAM_TRUST_PROXY=1 \
  -e TEAM_ADMIN_EMAIL=you@example.com \
  -e TEAM_ADMIN_PASSWORD='至少十位的强密码' \
  team-kb:local
```

容器内服务监听 `0.0.0.0:8787`，宿主机发布只绑定 `127.0.0.1`；Caddy 仍放在前面。首次创建管理员后删除密码环境变量并重建容器。

## systemd

仓库提供：

```text
cloud/deploy/team-kb.service
```

安装：

```bash
sudo cp /opt/team-kb/node_modules/@lemoncat7/dsh-knowledge/cloud/deploy/team-kb.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now team-kb
sudo systemctl status team-kb
```

服务以 `teamkb` 用户运行，读写限制在 `/opt/team-kb/data`。

## 成员和权限

首次管理员进入后，打开左侧「成员与邀请」：

1. 选择角色：管理员 / 编辑者 / 阅读者。
2. 生成一次性邀请链接，7 天内有效。
3. 把链接单独发给成员；成员设置邮箱、姓名、密码后加入。
4. 停用成员会立即删除其所有会话。

权限：

| 操作 | 管理员 | 编辑者 | 阅读者 |
|---|---:|---:|---:|
| 浏览、搜索、下载 | ✓ | ✓ | ✓ |
| 新建、编辑文档 | ✓ | ✓ | — |
| 邀请成员、改角色、停用 | ✓ | — | — |

至少保留一个管理员；管理员不能停用自己。

## 文件库：所有类型

团队网页的「文件库」支持任意文件类型：PDF、Word、Excel、PPT、图片、ZIP、音视频、二进制数据等。上传后用原文件名下载；图片、PDF、文本等可以直接在浏览器打开，其他类型下载。

- 文件按知识库授权，只有登录成员可访问；
- 文件按上传者 `user_name` 分组显示，例如 `alice/docs/report.pdf`；
- 上传/删除需要管理员或编辑者；
- 文件内容保存在 `$TEAM_DATA_DIR/files/`，元数据在 `team.sqlite`；
- 单文件默认上限 100 MiB，通过 `TEAM_MAX_FILE_BYTES` 调整；
- 文件名、MIME、上传者和 SHA-256 都会记录；同一用户同一 `sourceKey` 幂等覆盖。

命令行上传任意类型：

```bash
curl -X POST http://127.0.0.1:8787/knowledge-api/v1/files \
  -H "Authorization: Bearer dshk_..." \
  -H "x-file-base-id: default" \
  -H "x-file-user-name: alice" \
  -H "x-file-name: $(python3 -c 'import urllib.parse;print(urllib.parse.quote("报告.pdf"))')" \
  -H "x-content-type: application/pdf" \
  --data-binary @报告.pdf
```

## 本地知识库与云端同步

仓库提供 `cloud/sync-local.mjs`，把本地 `knowledge.sqlite` 的知识库、文档和文件目录同步到云端团队库。重复执行是幂等的，会更新已同步文档；默认方向是**本地 → 云端**。

```bash
# 1) 云端管理员生成 DSH Token
# 2) 本地执行
node cloud/sync-local.mjs \
  --db "/path/to/local/knowledge.sqlite" \
  --url "https://你的域名/knowledge-api/v1" \
  --token "dshk_..." \
  --files "/path/to/files" \
  --base "默认知识库"
```

从云端拉取新增/更新到本地：

```bash
node cloud/sync-local.mjs \
  --db "/path/to/local/knowledge.sqlite" \
  --url "https://你的域名/knowledge-api/v1" \
  --token "dshk_..." \
  --pull \
  --files-out "/path/to/cloud-files"
```

参数：

| 参数 | 说明 |
|---|---|
| `--db` | 本地 `knowledge.sqlite` |
| `--url` | 云端 `/knowledge-api/v1` |
| `--token` | 云端 DSH Token（需要 `read/propose/write`） |
| `--files` | 可选，任意类型文件或目录；目录递归上传 |
| `--files-out` | 可选，把云端文件下载到此目录 |
| `--base` | 可选，只同步指定库名或本地 ID |
| `--map` | 可选，默认 `<db>.cloud-sync.json`，保存本地/云端映射 |
| `--pull` | 从云端拉取；不推本地 |
| `--mirror` | 拉取到独立本地镜像库 `云端·<库名>`，原本地库保持不变 |
| `--mirror-prefix` | 镜像库名前缀，默认 `云端·` |
| `--user` | 文件归属的用户名，默认本机用户名；云端按它建立子目录 |

也可以用环境变量：

```bash
LOCAL_KB_DB=/data/knowledge.sqlite \
CLOUD_URL=https://kb.example.com/knowledge-api/v1 \
CLOUD_TOKEN=dshk_... \
CLOUD_SYNC_FILES=/data/files \
CLOUD_SYNC_USER=alice \
node cloud/sync-local.mjs
```

从云端拉取时使用：

```bash
LOCAL_KB_DB=/data/knowledge.sqlite \
CLOUD_URL=https://kb.example.com/knowledge-api/v1 \
CLOUD_TOKEN=dshk_... \
CLOUD_SYNC_PULL=1 \
CLOUD_SYNC_MIRROR=1 \
CLOUD_SYNC_FILES_OUT=/data/cloud-files \
node cloud/sync-local.mjs
```

同步规则：

- 默认推送：本地内容变化才写云端；未变化跳过。
- `--pull`：云端内容变化且本地自上次同步未变化时才写本地。
- `--mirror`：不覆盖本地原库，而是新建本地库 `云端·默认知识库`、`云端·制品归档` 等；本地原库继续独立使用。
- 默认推送会跳过镜像库，避免把云端内容又推回云端。
- 本地和云端都发生变化时，默认**保留本地并报告冲突**，不静默覆盖。
- 映射文件 `cloud-sync.json` 要保留；删掉后再次推送会在云端新建文档。
- 云端文件下载用 `sourceKey` 保持目录层级；文件名只作为缺省路径。

## 插件界面自动同步（推荐）

更新本地插件到 `0a0c905` 或更新版本并重启 DSH 后，在：

```text
设置 → 插件 → 云端同步
```

填写：

- 云端服务地址：`https://你的域名/knowledge-api/v1`
- DSH Token（管理员在「成员与邀请 → 连接本地 DSH」生成）
- 文件归属用户名
- 自动同步间隔（默认 5 分钟）
- 本地文件上传目录（可选）
- 云端文件下载目录（可选）
- 指定本地知识库（可选；上传文件涉及多个库时必须指定）

点击「连接并立即同步」后：

1. 本地原有知识库推送到云端，云端缺少的库按本地名称创建；
2. 云端内容拉取到本地新增的 `云端·<库名>` 镜像库；
3. 原本地知识库继续保留，不切换 DSH 到远程模式；
4. 自动同步开启时，本地轮次结束、云端变化和定时轮询都会触发同步；
5. 文件按用户名分组上传；未变化文件不会重复传输。

镜像库用于查看云端内容；编辑本地原库会推送到云端，编辑镜像库不会反向推送，避免循环覆盖。

命令行脚本仍保留，适合批量导入和排障；日常使用不需要命令行。

## 连接本地 DSH

云端服务同时暴露 DSH 远程知识库协议：

```text
https://你的域名/knowledge-api/v1
```

本地 DSH 的「设置 → 插件 → 知识库连接」切换到远程，填入这个地址和 Token，点击「验证并连接」。每台 DSH 仍然使用自己的项目/会话挂载知识库。

Token 生成：

1. 云端管理员打开「成员与邀请」；
2. 在「连接本地 DSH」里输入名称，生成 Token；
3. Token 只显示一次，复制到本地 DSH；
4. 不再使用就在同一处撤销。

也可以直接调用 API：

```bash
curl -sS -X POST https://你的域名/api/admin/tokens \
  -H "content-type: application/json" \
  -b cookies.txt -H "x-csrf-token: ..." \
  -d '{"name":"我的 DSH"}'
```

**远程地址必须是 HTTPS。** 当前如果只有 `http://www.cmjt.asia:8787`，本地 DSH 会拒绝非回环 HTTP。两种做法：

- 用 Caddy 把域名映射到 8787 并上 HTTPS，然后使用 `https://www.cmjt.asia/knowledge-api/v1`；
- 或不暴露 HTTP，给本地建 SSH 隧道，再把 DSH 地址填成回环地址：

```bash
ssh -N -L 8787:127.0.0.1:8787 用户@www.cmjt.asia
```

```text
http://127.0.0.1:8787/knowledge-api/v1
```

`127.0.0.1` 是允许 HTTP 的测试地址；正式使用仍建议 HTTPS。

### 本地 DSH 配置示例

如果不用设置页，也可以直接写 profile 的 `cordis.patch.yml`：

```yaml
- id: knowledge
  config:
    backend: remote
    remoteUrl: https://www.cmjt.asia/knowledge-api/v1
    remoteToken: !!js process.env.DSH_KNOWLEDGE_REMOTE_TOKEN
    extractionEnabled: true
```

把 Token 放进环境变量 `DSH_KNOWLEDGE_REMOTE_TOKEN`，不要把 Token 写进 Git。

远程模式不会复制一份本地数据库；断网时无法召回或回写。网页端和 DSH 端看到的是同一个云端 `knowledge.sqlite`。

## 备份与恢复

```bash
sudo /opt/team-kb/node_modules/@lemoncat7/dsh-knowledge/cloud/deploy/backup.sh /opt/team-kb/data /var/backups/team-kb
```

备份包含：

```text
knowledge.sqlite
team.sqlite
files.tar.gz      # 任意类型文件
```

脚本使用 `sqlite3 .backup`，对运行中的 WAL 数据库是安全快照；文件目录单独打包。把备份目录同步到另一台机器或对象存储。

恢复：

```bash
sudo systemctl stop team-kb
sudo cp /var/backups/team-kb/20261125/knowledge.sqlite /opt/team-kb/data/knowledge.sqlite
sudo cp /var/backups/team-kb/20261125/team.sqlite /opt/team-kb/data/team.sqlite
sudo tar -xzf /var/backups/team-kb/20261125/files.tar.gz -C /opt/team-kb/data
sudo chown -R teamkb:teamkb /opt/team-kb/data
sudo systemctl start team-kb
```

## 安全边界

- 密码使用 `scrypt` 加盐哈希；会话 Cookie 为 `HttpOnly`、`SameSite=Lax`，HTTPS 下自动加 `Secure`。
- 所有修改 API 需要会话中的 CSRF Token；管理接口再次检查管理员角色。
- 邀请链接是一次性的，领取时原子占用。
- 登录按 IP 限速；响应带 CSP、禁止 iframe、`nosniff`。
- 公开网络必须走 HTTPS；应用默认只监听 `127.0.0.1`。
- 数据目录权限应为 `700`，备份文件不应公开。
- 这个服务不包含模型调用、不保存 DSH 会话、不暴露 DSH 管理台。

## 常见问题

**页面只有默认知识库、没有旧文档**  
检查 `TEAM_KB_DB` 是否指向导入的 `knowledge.sqlite`，以及服务是否以 `teamkb` 用户读取该文件。

**邀请链接打不开**  
确认链接没有过期、没有第二次使用，且 `TEAM_PUBLIC_ORIGIN` 与浏览器访问的域名一致。

**两人保存冲突**  
这是预期保护：后保存者不会覆盖先保存者。页面会提示载入最新版；草稿仍在编辑器里，可复制合并后重试。

**1 核 1 GB 能跑吗**  
可以试跑，但 Node、SQLite 和并发编辑会有峰值；3–5 人建议 2 GB 内存。文档正文上限默认 5 MiB，附件不在这一版。

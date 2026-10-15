# 消费端详解：`aml_skill_review/`

> 目录：`Rubick/backend/tests/skill_tests/aml_skill_review/`
> 角色：**浏览器唯一入口**。把分析产出的 xlsx 导入数据库 → 提供人工评审 → 统计人工与大模型一致率；同时把 Skill 管理 / 任务管理请求**代理**给 FastAPI 后端。
> 技术栈：Next.js **16.2.6**（App Router）+ React 19 + Tailwind 4 + 内置 `node:sqlite`（**需 Node.js ≥ 22**）。

> 注意：`package.json` 的 `name` 是 `skill-review`，但**文件夹名是 `aml_skill_review`**，两者不一致属正常现象。

---

## 1. 目录结构

```
aml_skill_review/
├── app/
│   ├── page.tsx                 # /            首页（欢迎页，未登录跳 /login）
│   ├── login/page.tsx           # /login       登录 / 首登改密
│   ├── analysis/page.tsx        # /analysis    质量分析（列表 + 导入 + 导出）
│   ├── review/[id]/page.tsx     # /review/:id  单条工单评审详情
│   ├── stats/page.tsx           # /stats       评审统计
│   ├── type-stats/page.tsx      # /type-stats  同 Skill 结果对比全览
│   ├── tasks/page.tsx           # /tasks       Skill 分析任务管理
│   ├── skills/page.tsx          # /skills      Skill 管理（上传/审核/浏览）
│   ├── users/page.tsx           # /users       用户管理（管理员）
│   └── api/                     # 服务端 API 路由（见 api-reference.md）
├── components/                  # 页面组件（每个 page 对应一个组件）
├── lib/                         # 配置、鉴权、数据库、字段、统计、导入
│   ├── config.ts   auth.ts   db.ts   columns.ts
│   ├── stats.ts    xlsx-import.ts    api-utils.ts   utils.ts
├── data/                        # 运行期数据（自动创建）
│   ├── user_account.db          # 账户库（users / sessions）
│   └── user_data/<用户名>/
│       ├── <用户名>.db          # 业务库（表名 = xlsx 文件名）
│       └── *.xlsx               # 导入/产出的数据文件
└── README.md                    # 旧版使用说明（架构描述偏旧，以 doc/ 为准）
```

---

## 2. 页面与组件对应关系

| 路由 | 页面文件 | 组件 | 主要功能 |
|---|---|---|---|
| `/` | [page.tsx](../aml_skill_review/app/page.tsx) | `WelcomePage` | 未登录 `redirect("/login")`；已登录展示欢迎与功能入口 |
| `/login` | `login/page.tsx` | `LoginPage` | 登录；首个账号首次登录强制改密 |
| `/analysis` | [analysis/page.tsx](../aml_skill_review/app/analysis/page.tsx) | `ListPage` | 选择数据文件 → 导入 → 过滤列表 → 导出 |
| `/review/[id]` | `review/[id]/page.tsx` | `ReviewPage` | 查看大模型结论、填写人工判定 |
| `/stats` | `stats/page.tsx` | `StatsPage` | 单表统计：四类分布、一致率、差异清单 |
| `/type-stats` | `type-stats/page.tsx` | `TypeStatsPage` | 跨表按 `jira_id` 对齐对比 |
| `/tasks` | `tasks/page.tsx` | `TasksPage` | 新建/停止任务、预设、计划任务、审批、并发配置 |
| `/skills` | `skills/page.tsx` | `SkillsPage` | 上传 Skill、审核、文件浏览、删除、设 owner |
| `/users` | `users/page.tsx` | `UsersPage` | 账号增改（仅管理员） |

全局组件：`AppNavbar`（导航 + 登出）、`NotificationCenter`（通知中心，聚合待办）、`VerdictBadge`（判定徽标）、`ui/*`（shadcn 基础组件）。

**导航结构**（`components/app-navbar.tsx`）：质量分析（`/analysis`，命中 `/review/*`、`/stats/*` 也高亮）· Skill 管理（`/skills`）· Skill 分析任务（`/tasks`）· 结果对比全览（`/type-stats`）· 用户管理（`/users`，仅管理员）。

`NotificationCenter` 是「待办聚合器」，同时轮询多个后端接口：待审 Skill（`/skills/reviews`）、我的通知（`/skills/notices`）、管理员审批（`/approvals`）、任务与计划任务，并在此处直接执行 approve/reject/withdraw/dismiss/accep/reject/停止 等动作。

---

## 3. `lib/` 模块详解

### 3.1 `lib/config.ts` —— 全局配置（**换目录只改这里**）

| 导出 | 含义 |
|---|---|
| `USER_DATA_ROOT` | user_data 根目录（env `USER_DATA_DIR_ROOT` 覆盖） |
| `AUTH_DB_PATH` | 账户库 `data/user_account.db` |
| `SESSION_COOKIE` | 会话 Cookie 名 `skill_review_session` |
| `JIRA_BASE_URL` | Jira 详情页前缀，用于列表点击跳转 |
| `SKILL_API_BASE` | FastAPI 地址（env `SKILL_API_BASE`，默认 `http://127.0.0.1:12371`） |
| `getBackendToken()` | 读内部 Token：`SKILL_API_TOKEN` 优先，否则读 `process_skills/server_data/.api_token` |
| `userDataDir(username)` | `user_data/<用户名>` |
| `userDbPath(username)` | `user_data/<用户名>/<用户名去特殊字符>.db` |
| `isValidUsername(username)` | 登录名校验：`^[A-Za-z0-9._-]{2,50}$` |

**Legacy（已废弃、当前无引用）**：`SKILL_DIR_ROOT`、`SKILL_OWNER_DB_PATH`、`TASK_DB_PATH`、`TASK_OUTPUT_DIR`、`DEFAULT_MAX_CONCURRENT_TASKS`、`SKILL_RUNNER_SCRIPT`、`RUBICK_ROOT`。
这些是「早期把 Skill/任务管理直接放在 Next.js」时代的产物，现已迁移到 FastAPI 后端，**仅在此定义、全站无引用**。改动 Skill/任务相关配置请去 `process_skills/server/config.py`；确认无引用后可以删除。

### 3.2 `lib/auth.ts` —— 账户与会话

- 账户库：`data/user_account.db`，表 `users`（含 `username` / `password_hash` / `is_admin` / `create_t`）与 `sessions`。
- 密码：`crypto.scryptSync` 加盐哈希（`hashPassword` / `verifyPassword`）。
- 会话：`createSession` → 写入 `sessions`；浏览器 Cookie 仅存**会话编号**。
- **首个用户自动成为管理员**（第 1 个登录/注册时 `userCount() === 0` → `is_admin = 1`）。
- 关键函数：`getAuthDb / hashPassword / verifyPassword / userCount / getUserByName / getUserById / listUsers / getPasswordHash / createUser / updateUser / verifyUser / createSession / getUserByToken / deleteSession / sessionCookie / getTokenFromRequest / getRequestUser / getPageUser`。
- `getRequestUser(request)` 供 API 路由用；`getPageUser()` 供服务端页面用（读 `next/headers` 的 `cookies()`）。

### 3.3 `lib/db.ts` —— 业务数据库（**按用户隔离**）

- 连接缓存 `dbCache`：每个登录名一个 `DatabaseSync`，首次打开时自动建目录与文件，并 `PRAGMA journal_mode = WAL`。
- **表 = 一份 xlsx**：表名就是 xlsx 文件名，列由 `lib/columns.ts` 的 `FIELD_NAMES` 决定，全部 `TEXT`。
- `sanitizeTableName` / `quoteIdent` 保证任意表名可安全进 SQL。
- 关键函数：`getDb / nowString / sanitizeTableName / quoteIdent / tableExists / createTable / insertRows / countRows / queryRows / distinctValues / listUserTables / getRowByJiraId / updateReview / getAllRows / queryAllFiltered`。

### 3.4 `lib/columns.ts` —— 字段映射（**全站唯一来源**）

- `FIELD_COLUMNS`：21 个字段的「英文列名 ↔ 中文显示名」，例如
  `jira_id / summary / description / root_cause / how_to_fix / comments / skill_raw / skill_final / judge_real_result / judge_verdict / judge_reason / judge_aligned / judge_conflict / human_judge / human_judge_reason / create_t / update_t`（另有 `skill_path / skill_name / jql / schedule_time`）。
- `HEADER_ALIASES`：xlsx 表头的中英文别名表（如 `root_cause` ← `根因 / rootcause`），配合 `normalizeHeader`（去空格/下划线/连字符/括号、转小写）与 `matchHeaderToField` 实现模糊匹配。
- **表格表头、详情标签、导出表头都必须从这里取值，禁止写死列名。**

### 3.5 `lib/stats.ts` —— 统计与对比（**与后端判定口径必须一致**）

- `VERDICT_CATEGORIES = ["命中","相关","错误","未知"]`
- `classifyVerdict(value)`：归一规则（空→未知；含「命中」→命中；含「相关」→相关；含「错误」→错误；其余→未知）。
- `finalVerdict(row)`：**人工优先、大模型兜底**——有人工判定取人工，否则取大模型判定。
- `computeStats(rows)`：总数、已评审/未评审、四类分布、概览占比、`agreed` / `agreementRatio`（一致率 = 一致条数 / 已评审条数）、`disagreements`（不一致清单）。
- `computeCompareStats(tablesRows)`：跨表对比——先算每表分布，再按 `jira_id` 对齐生成对比行（缺失显示 `-`），统计 `consistentCount` 与 `inconsistentJiraIds`。`extractTypeFromTable` 从表名（形如 `test-Nagracas-0801_220001`）取类型名。
- `formatPercent(ratio)`：`0.1234 → "12.3%"`。

### 3.6 `lib/xlsx-import.ts` —— xlsx 导入

`importXlsx(...)`：查同名表是否已存在 → 解析 xlsx → 用 `matchHeaderToField` 匹配表头 → `createTable` → 逐行转换并 `insertRows` 写入**当前用户**的库。表头匹配不上的列会告警并跳过。

### 3.7 `lib/api-utils.ts` —— API 公共工具

- `resolveDataOwner(requestUser, requested)`：管理员可通过 `user` 参数操作他人数据；普通用户传他人用户名直接拒绝。
- `resolveTable(searchParams, username)`：清洗并校验 `table` 存在于该用户库。
- `errorResponse(message, status)`：统一 `{ok:false,error}`。
- `isSafeFileName(name)`：拒绝含 `/`、`\`、`..` 的文件名，且必须 `.xlsx` 结尾（防目录穿越）。

---

## 4. 与 FastAPI 的代理与鉴权链路

浏览器**只与本机 Next.js（1237）通信**，所有 Skill/任务接口都走统一代理：

```
浏览器 /api/backend/xxx
   → app/api/backend/[...path]/route.ts   （proxy）
      ① getRequestUser(request) 校验 Cookie 登录（未登录 → 401）
      ② 目标 = `${SKILL_API_BASE}/api/backend/<segments>?<原 query>`
      ③ 注入头 X-INTERNAL-TOKEN / X-USER / X-IS-ADMIN
      ④ 透传 JSON / FormData(multipart，如 zip 上传) / 二进制下载
      ⑤ FastAPI 的 {detail} 错误归一成 {ok:false,error}
      ⑥ 后端不可用时返回 502 并提示启动 12371
```

关键点：
- **新增后端接口无需改前端代理**——`[...path]` 是通配透传，后端加了 `GET /api/backend/xxx` 前端立刻可用。
- **Token 从文件读**：后端启动时生成 `process_skills/server_data/.api_token`，前端 `getBackendToken()` 读同一文件，因此**后端必须先启动**（否则代理 502）。
- 鉴权是「信任代理」模型：FastAPI 只校验 `X-INTERNAL-TOKEN == 内部 Token`，用户身份来自 `X-USER` / `X-IS-ADMIN`，且只监听 `127.0.0.1`。

---

## 5. 组件 → 接口对照表（排查「点了没反应」用）

| 组件 | 调用的接口 |
|---|---|
| `login-page` | `GET /api/auth/status`、`POST /api/auth/login`、`POST /api/auth/change-password` |
| `app-navbar` | `POST /api/auth/logout` |
| `list-page` | `GET /api/files`、`GET /api/rows`、`POST /api/import`、`GET /api/export` |
| `review-page` | `GET /api/rows`、`GET /api/row`、`POST /api/review` |
| `stats-page` | `GET /api/stats` |
| `type-stats-page` | `GET /api/type-stats`（不带 `tables` 选表；带则出对比） |
| `skills-page` | `GET /api/backend/skills`、`GET /api/backend/skills/reviews`、`POST /api/backend/skills`（上传，同名 409 → 二次确认）、`POST .../reviews/{id}/approve\|reject\|withdraw`、`GET .../reviews/{id}/files`、`GET .../reviews/{id}/content?file=`、`GET .../skills/files?path=`、`GET .../skills/content?path=&file=`、`DELETE .../skills/delete?path=`、`PUT .../skills/owner`（body 带 `path`） |
| `tasks-page` | `GET /api/backend/tasks/stats`、`GET /api/backend/tasks`、`GET /api/backend/skills?mine=1`、`GET/POST /api/backend/presets`、`DELETE /api/backend/presets/{id}`、`GET /api/backend/scheduled-tasks`、`DELETE /api/backend/scheduled-tasks/{id}`、`GET /api/backend/approvals`、`POST /api/backend/approvals/{kind}/{id}/accept\|reject`、`GET/PUT /api/backend/admin/task-config`、`POST /api/backend/tasks`、`DELETE /api/backend/tasks/{id}`、`GET /api/backend/tasks/{id}/log`、下载 `.../download-log`、`.../download-output` |
| `notification-center` | `GET /api/backend/skills/notices`、`GET /api/backend/skills/reviews`、`GET /api/backend/approvals`（管理员）、`GET /api/backend/tasks`、`GET /api/backend/scheduled-tasks`；动作同上 |
| `users-page` | `GET /api/users`、`PUT /api/users` |

> 接口的完整参数/权限见 [api-reference.md](./api-reference.md)。

---

## 6. `SkillsPage` 展示行为（易被误报为 bug）

- **缩略图默认折叠**：Skill 缩略图区域默认收起，需要点击展开。
- **名称与描述不截断**：缩略图卡片完整展示 Skill 名称与描述。若出现描述被截断，根因通常在**后端数据**（历史上 `skills_mgr._extract_description` 的 `[:200]` 截断，已移除），前端不做截断处理。

---

## 7. 维护提示

- **换端口**：改 3 处——`package.json` 的 `-p 1237`、后端 `SKILL_API_PORT`、前端 `SKILL_API_BASE`。
- **换数据根目录**：改 `lib/config.ts`（`USER_DATA_ROOT` / `AUTH_DB_PATH`）；若同时动了后端复制目标，还要改 `process_skills/server/config.py` 的 `USER_DATA_ROOT`。
- **加字段**：优先改 `lib/columns.ts`（`FIELD_COLUMNS` + `HEADER_ALIASES`）；若该字段来自分析脚本输出，还要改 `run_jql_with_skill_demo.py` 的 `headers`。
- **`adm-zip`** 是 `package.json` 里声明但**全站无引用**的依赖（Skill zip 上传实际由 FastAPI 处理），属遗留，可清理。

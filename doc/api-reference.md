# 接口清单（API Reference）

本系统对外只有两类接口。**浏览器只调 Next.js（1237）**；`/api/backend/*` 由 Next.js 代理转发给 FastAPI（12371），浏览器不直接访问 FastAPI。

- 权限约定：**登录** = 任意已登录用户；**管理员** = `is_admin = 1`。
- 所有 `/api/backend/*` 请求都会由代理注入 `X-INTERNAL-TOKEN` / `X-USER` / `X-IS-ADMIN`，见 [frontend-aml_skill_review.md §4](./frontend-aml_skill_review.md#4-与-fastapi-的代理与鉴权链路)。

---

## 一、Next.js 接口（业务 / 账户，端口 1237）

定义于 `aml_skill_review/app/api/**/route.ts`。除 `/api/backend/*` 外，权限由 `getRequestUser` 校验。

### 账户与会话

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| POST | `/api/auth/login` | 公开 | body `{username, password}` | 登录成功后写 Cookie `skill_review_session` |
| POST | `/api/auth/logout` | 登录 | — | 删除会话 |
| GET | `/api/auth/me` | 登录 | — | 当前用户信息 |
| GET | `/api/auth/status` | 公开 | — | 系统状态（是否已有账号等），登录页用于「首个账号」判断 |
| POST | `/api/auth/change-password` | 公开* | body `{username, oldPassword, newPassword}` | 修改密码；首个账号首登改密走这里 |

> \* `change-password` 需校验旧密码，因此按业务需要在未登录（首登）场景也可调用。

### 用户管理

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/users` | 管理员 | — | 账号列表 |
| POST | `/api/users` | 管理员 | body `{username, password, isAdmin}` | 新增账号 |
| PUT | `/api/users` | 管理员 | body `{id, username, password}` | 修改用户名 / 重置密码 |

### 评审数据

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/files` | 登录 | `?user`（管理员可指定他人） | 列出该用户 user_data 下的 xlsx 文件 |
| POST | `/api/import` | 登录 | body `{fileName, user?}` | 校验文件名安全 → `importXlsx` 导入（表名 = 文件名） |
| GET | `/api/rows` | 登录 | `?table&user&judgeVerdict&humanJudge&page&pageSize` | 分页查询 + 返回过滤下拉选项 |
| GET | `/api/row` | 登录 | `?table&jiraId&user` | 取单条工单详情 |
| POST | `/api/review` | 登录 | body `{table, jiraId, humanJudge, humanJudgeReason, user?}` | 写回人工判定 |
| GET | `/api/stats` | 登录 | `?table&user` | 单表统计（服务端 `computeStats`） |
| GET | `/api/type-stats` | 登录 | `?user`；`?tables=表1,表2` | 不带 `tables` → 类型分组清单；带 → 跨表对比 |
| GET | `/api/export` | 登录 | `?table&user&judgeVerdict&humanJudge` | 导出过滤后的 xlsx |

> `user` 参数语义见 `lib/api-utils.ts` 的 `resolveDataOwner`：仅管理员可跨用户操作。
> `table` 统一经 `resolveTable` 校验存在性与安全性（`sanitizeTableName`）。

### 后端代理（通配）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET / POST / PUT / DELETE | `/api/backend/[...path]` | 登录 | 透传到 `SKILL_API_BASE/api/backend/<path>`，注入内部头，归一错误 |

**新增后端接口不需要改这个代理**。

---

## 二、FastAPI 接口（Skill / 任务，端口 12371）

定义于 `process_skills/server/main.py`，前缀统一 `/api/backend`。

### 健康检查

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/backend/health` | 内部 | 返回 `{ok, service, time}` |

### Skill 管理

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/backend/skills` | 登录 | `?mine` | Skill 列表（`mine=1` 只看自己负责的） |
| GET | `/api/backend/skills/types` | 登录 | — | 所有 Skill 类型 |
| GET | `/api/backend/skills/detail` | 登录 | `?path` | 单个 Skill 详情 |
| DELETE | `/api/backend/skills/delete` | **管理员** | `?path` | 删除 Skill |
| PUT | `/api/backend/skills/owner` | **管理员** | body `{path, owner}` | 修改 Skill 所有者 |
| GET | `/api/backend/skills/files` | 登录 | `?path` | Skill 文件树 |
| GET | `/api/backend/skills/content` | 登录 | `?path&file` | 读取单个文本文件内容 |
| POST | `/api/backend/skills` | 登录 | multipart：`owner`、`confirm_duplicate`、`files[]` | 上传 Skill（zip / 文件夹）。同名时返回 409，需带 `confirm_duplicate` 重试。普通用户 `owner` 强制为自己 |

### Skill 上传审核

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/backend/skills/reviews` | 登录 | — | 待审核记录（管理员看全部，普通用户看自己） |
| POST | `/api/backend/skills/reviews/{review_id}/approve` | **管理员** | — | 通过 → 移入正式目录 |
| POST | `/api/backend/skills/reviews/{review_id}/reject` | **管理员** | — | 拒绝 |
| POST | `/api/backend/skills/reviews/{review_id}/withdraw` | 登录 | — | 上传者撤回（仅本人或管理员） |
| GET | `/api/backend/skills/reviews/{review_id}/files` | 登录 | — | 待审文件树（仅 owner 或管理员） |
| GET | `/api/backend/skills/reviews/{review_id}/content` | 登录 | `?file` | 待审文件内容 |

### 通知

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/backend/skills/notices` | 登录 | — | 当前用户未读通知 |
| POST | `/api/backend/skills/notices/{notice_id}/dismiss` | 登录 | — | 读过并**永久移除**（之后不再发送） |

### 任务

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/backend/tasks` | 登录 | `?page&page_size&owner&skill&date_from&date_to` | 分页任务列表（普通用户仅自己，管理员全部） |
| GET | `/api/backend/tasks/stats` | 登录 | — | 运行中 / 排队中 / 我的排队位置 |
| POST | `/api/backend/tasks` | 登录 | body `CreateTaskBody` | 新建任务（`mode=immediate` 立即执行 / `once` 定时，`runAt` 形如 `YYYY-MM-DD HH:MM`） |
| GET | `/api/backend/tasks/{run_id}` | 登录 | — | 单个任务详情 |
| DELETE | `/api/backend/tasks/{run_id}` | 登录 | — | 停止运行中任务 / 撤回排队任务 |
| GET | `/api/backend/tasks/{run_id}/log` | 登录 | — | 日志文本（增量） |
| GET | `/api/backend/tasks/{run_id}/download-log` | 登录 | — | 下载日志文件 |
| GET | `/api/backend/tasks/{run_id}/download-output` | 登录 | — | 下载结果 xlsx |

`CreateTaskBody`：

```json
{ "name": "", "skill": "", "skillPath": "", "jql": "（必填）",
  "maxIssues": 0, "email": "", "mode": "immediate", "runAt": null }
```

### 任务预设

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/backend/presets` | 登录 | — | 当前用户保存的预设 |
| POST | `/api/backend/presets` | 登录 | body `CreatePresetBody`（字段同 `CreateTaskBody`） | 新建预设 |
| DELETE | `/api/backend/presets/{preset_id}` | 登录 | — | 删除预设（本人或管理员） |

### 计划任务

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/backend/scheduled-tasks` | 登录 | — | 尚未执行的计划任务。**普通用户仅自己创建的；管理员可见全部** |
| DELETE | `/api/backend/scheduled-tasks/{task_id}` | 登录 | — | 移除计划任务定义 |

### 审批（管理员）

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/backend/approvals` | **管理员** | — | 待审批的「立即任务」与「指定时间任务」 |
| POST | `/api/backend/approvals/run/{run_id}/accept` | **管理员** | body `{remark}` | 通过某个 run |
| POST | `/api/backend/approvals/run/{run_id}/reject` | **管理员** | body `{remark}` | 拒绝某个 run |
| POST | `/api/backend/approvals/def/{task_id}/accept` | **管理员** | body `{remark}` | 通过某条任务定义 |
| POST | `/api/backend/approvals/def/{task_id}/reject` | **管理员** | body `{remark}` | 拒绝某条任务定义 |

### 管理端

| 方法 | 路径 | 权限 | 参数 | 说明 |
|---|---|---|---|---|
| GET | `/api/backend/admin/task-defs` | **管理员** | — | 全部任务定义 |
| DELETE | `/api/backend/admin/task-defs/{task_id}` | **管理员** | — | 删除任务定义 |
| GET | `/api/backend/admin/task-config` | **管理员** | — | 读取配置（最大并发数） |
| PUT | `/api/backend/admin/task-config` | **管理员** | body `{max}`（1~16） | 修改最大并发数 |

---

## 三、鉴权与错误约定

- FastAPI `auth` 依赖：`X-INTERNAL-TOKEN` 必须等于内部 Token，否则 **401**；`X-USER` 缺失 → **401**；`admin_only` 校验失败 → **403**。
- FastAPI 错误返回 `{detail}`；Next.js 代理统一归一为 `{ok:false, error}` 后返回浏览器。
- 后端未启动时代理返回 **502**，并提示启动 `process_skills/start_backend_server.bat`。
- 业务 API（Next.js）统一错误格式：`{ok:false, error}`。

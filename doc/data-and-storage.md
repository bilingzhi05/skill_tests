# 数据与存储

本文列出系统所有**落盘文件**的格式与字段，供排查数据问题和迁移时参考。

---

## 1. 生产端数据：`process_skills/server_data/`

全部由 FastAPI 后端自动创建与维护（`config.DATA_DIR`）。

```
server_data/
├── task_state.json       # 运行态：并发配置 + 所有 run + cron 触发记录
├── skill_owners.json     # skill 路径 → 所有者/类型/描述
├── task_presets.json     # 任务预设列表
├── skill_reviews.json    # Skill 上传审核记录
├── skill_notices.json    # 审核结果通知（未读）
├── review_stage/         # 待审核 Skill 的暂存目录
│   └── <review_id>/...
├── runs/                 # 每次任务的输出目录
│   └── <run_id>/
│       ├── output.log               # 子进程标准输出（追加写）
│       ├── <时间戳>_<skill>.xlsx     # 分析结果
│       └── <时间戳>_<skill>-filtered.xlsx  # 仅在有 email 时生成（Final 非空）
└── .api_token            # 内部共享密钥
```

> 任务定义 `skills_tasks.yaml` 位于 `process_skills/` 根（人可编辑），不在 `server_data/`。

### 1.1 `task_state.json`

```json
{
  "config": { "max_concurrent_tasks": 2 },
  "runs": { "<run_id>": { ...run 记录... } },
  "cron_fired": { "<task_id>": "<已触发的分钟标记>" }
}
```

**run 记录字段**（`executor._make_run`）：

| 字段 | 含义 |
|---|---|
| `id` | run_id（`gen_task_id` 生成） |
| `name` / `owner` | 任务名 / 发起人登录名 |
| `skill` / `skillPath` | 使用的 Skill 名 / 路径 |
| `jql` / `maxIssues` / `email` | 分析参数 |
| `mode` | `immediate` \| `once` \| `cron` |
| `taskId` | 对应 yaml 任务定义 id（手动任务为 `null`） |
| `status` | `pending`(待审) \| `queued` \| `running` \| `succeeded` \| `failed` \| `stopped` 等 |
| `progress` / `progressTotal` / `progressMessage` | 进度 |
| `logPath` / `outputPath` | 日志与结果 xlsx 的绝对路径 |
| `pid` | 子进程 PID（排队时为 `null`） |
| `queuePosition` | 排队位置 |
| `createdAt` / `startedAt` / `finishedAt` | 时间戳 |
| `error` | 失败信息 |

### 1.2 `skill_owners.json`

```json
{ "<skill 相对路径>": { "owner": "...", "type": "...", "description": "...",
                        "create_t": "...", "update_t": "..." } }
```

### 1.3 其它 JSON（均为**列表**）

- `task_presets.json`：预设数组，元素字段同 `CreateTaskBody`（另有 `id` / `owner`）。
- `skill_reviews.json`：审核记录数组（含 `id`、上传者、暂存路径、`status` 等）。
- `skill_notices.json`：通知数组（含 `id`、接收人、文案、已读状态等）。

> 这些 JSON 的读写一律经过 `server/storage.py`（原子写 + 锁）。**要加字段就改 storage 的读写函数**，不要绕过。

---

## 2. 消费端数据：`aml_skill_review/data/`

```
data/
├── user_account.db                    # 账户库（全局共享）
└── user_data/
    └── <登录名>/
        ├── <登录名>.db                # 该用户业务库（表名 = xlsx 文件名）
        └── *.xlsx                     # 导入/产出的数据文件
```

**Legacy（已废弃，可清理）**：`data/skill_owners.db`、`data/tasks.db`、`data/task_output/` —— 早期 Next.js 自管理 Skill/任务的残留，现由 FastAPI 接管。

### 2.1 `user_account.db`

| 表 | 字段 |
|---|---|
| `users` | `id`、`username`、`password_hash`（scrypt 加盐）、`is_admin`、`create_t` |
| `sessions` | 会话编号 → 用户映射（供 Cookie `skill_review_session` 校验） |

**第一个创建/登录的账号自动 `is_admin = 1`**（见 `lib/auth.ts` 的 `userCount()` 判断）。

### 2.2 业务库 `<登录名>.db`

- **每个用户一个库**，互不可见（`lib/db.ts` 的 `getDb(username)` 按登录名打开并缓存）。
- 启用 WAL 模式。
- **表名 = 导入的 xlsx 文件名**（经 `sanitizeTableName` 清洗，非法字符 → 下划线）。
- 所有列为 `TEXT`，列清单来自 `lib/columns.ts` 的 `FIELD_NAMES`。

---

## 3. 字段字典（业务表列）

来源：`aml_skill_review/lib/columns.ts` 的 `FIELD_COLUMNS`（**全站唯一来源**）。

| 英文列名 | 中文显示名 | 来源 |
|---|---|---|
| `skill_path` | Skill 路径 | 可选（xlsx 可带） |
| `skill_name` | Skill 名称 | 可选 |
| `jql` | JQL | 可选 |
| `schedule_time` | 启动时间 | 可选 |
| `jira_id` | Jira ID | 分析脚本 `Jira ID` |
| `summary` | Summary | 分析脚本 `Summary` |
| `description` | Description | 分析脚本 `Description` |
| `root_cause` | Root Cause | 分析脚本 `Root Cause` |
| `how_to_fix` | How to Fix | 分析脚本 `How to Fix` |
| `comments` | Comments | 可选 |
| `skill_raw` | Skill Raw | 分析脚本 `Raw` |
| `skill_final` | Skill Final | 分析脚本 `Final` |
| `judge_real_result` | 根因总结 | 分析脚本 `Judge Real Result` |
| `judge_verdict` | 大模型判定 | 分析脚本 `Judge Verdict` |
| `judge_reason` | 判定原因 | 分析脚本 `Judge Reason` |
| `judge_aligned` | 判定相同点 | 分析脚本 `Judge Aligned` |
| `judge_conflict` | 判定不相同点 | 分析脚本 `Judge Conflict` |
| `human_judge` | 人工判定 | **人工评审写入** |
| `human_judge_reason` | 人工判定原因 | **人工评审写入** |
| `create_t` | 创建时间 | 导入时写入 |
| `update_t` | 最后更新时间 | 导入 / 评审时更新 |

### 3.1 xlsx 表头 → 数据库列的匹配

分析脚本输出的表头**与数据库列名不同**，靠 `HEADER_ALIASES` + `normalizeHeader`（去空格/下划线/连字符/括号、转小写）做模糊匹配：

| xlsx 表头 | → 数据库列 |
|---|---|
| `Jira ID` | `jira_id` |
| `Root Cause` | `root_cause` |
| `How to Fix` | `how_to_fix` |
| `Raw` | `skill_raw` |
| `Final` | `skill_final` |
| `Judge Verdict` | `judge_verdict` |
| `Judge Reason` | `judge_reason` |
| `Judge Aligned` | `judge_aligned` |
| `Judge Conflict` | `judge_conflict` |
| `Judge Real Result` | `judge_real_result` |
| `SKILL定位Owner` / `JIRA Component` / `JIRA Assignee Owner` | 无对应列，导入时告警并跳过 |

> **新增分析输出列**时，必须在两处同步：`run_jql_with_skill_demo.py` 的 `headers`（产出）与 `lib/columns.ts`（入库/展示）。只改一处会导致「xlsx 有列但入库丢失」。

---

## 4. 数据流中的文件传递

1. `executor._execute_run` 把结果写到 `runs/<run_id>/*.xlsx`。
2. 若任务带 `email`，`_make_filtered_xlsx` 生成 `*-filtered.xlsx`（只保留 `Final` 非空的行）。
3. `copy_to_user_dirs` 把 filtered 文件复制到 `aml_skill_review/data/user_data/<邮箱前缀小写>/*.xlsx`（邮箱 → 登录名，如 `lingzhi.bi@amlogic.com` → `lingzhi.bi`）。
4. 前端 `/analysis` 的「选择数据文件」列出这些 xlsx → `/api/import` 导入成表 → 评审。

> **用户名 = 数据文件夹名**，所以**任务 email 的邮箱前缀必须与登录名一致**，否则结果会落到一个不存在的用户目录里，该用户在前端看不到。

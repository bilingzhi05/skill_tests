# 维护指南

面向「要改代码」的人：常见修改场景的操作步骤 + 已知遗留与坑。

---

## 0. 全量目录清单（含遗留物）

```
skill_tests/
├── README.md                  # 项目功能说明（旧）
├── doc/                       # 本套文档
├── .env / .env.example        # 环境变量（首次编好 .env 再启动）
├── .gitignore / __init__.py
├── start_all.bat / start_all.sh      # 一键启动（后端 12371 + 前端 1237）
├── stop_all.bat  / stop_all.sh       # 按端口关闭
├── logs/                      # 启动脚本产生的日志与 pid：backend.log / frontend.log /
│                              #   backend_uvicorn.out.log / .err.log / *.pid
├── process_skills/            # 见 backend-process_skills.md
│   ├── cron_run_*.log         # 【遗留】早期调度器（run_skills_scheduler.py）的运行日志
│   ├── tmp/tmp/*.log          # 【遗留】临时日志
│   └── server_data/*.bak_test # 【遗留】测试备份
└── aml_skill_review/          # 见 frontend-aml_skill_review.md
    └── data/skill_owners.db、tasks.db、task_output/   # 【遗留】Next.js 自管 Skill/任务的残留
```

> 带【遗留】标记的可安全删除；删除前用全局搜索确认无引用。其余为线上文件，改动请对照本文档。

---

## 1. 目录与路径依赖（**最容易踩的坑**）

系统多处用「向上数几层」来定位 Rubick 根目录，**移动任何一层目录都会破坏它**：

| 位置 | 依赖 |
|---|---|
| `run_jql_with_skill_demo.py` | `_RUBICK = Path(__file__).parent.parents[3]` → 用于 `sys.path` 与 `import backend.api.*` |
| `process_skills/server/config.py` | `RUBICK_ROOT = HERE.parents[3]`、`SKILL_TESTS = HERE.parent` |
| 子进程启动 | `cwd = RUBICK_ROOT`（脚本按相对路径 import 后端模块） |

**结论**：`skill_tests` 必须始终位于 `<Rubick>/backend/tests/skill_tests`。若必须迁移，要同时改上述三处。

---

## 2. 启动 / 停止 / 端口

### 启动顺序很关键

1. **先起后端**（12371）：后端启动时会生成 `server_data/.api_token`，前端代理依赖它。若顺序颠倒，前端会拿到空 Token → 代理 502。
2. **再起前端**（1237）。

一键脚本 `start_all.*` 已按此顺序处理并写日志到 `logs/`。

### 换端口（3 处要一起改）

| 改动点 | 文件 |
|---|---|
| 后端监听 | `process_skills/server/config.py`（`PORT`，env `SKILL_API_PORT`） |
| 前端 dev/start | `aml_skill_review/package.json`（`next dev -p 1237`） |
| 前端代理目标 | `aml_skill_review/lib/config.ts`（`SKILL_API_BASE`，env 同名） |

### 后端不可用

前端任何 `/api/backend/*` 会返回 502 并提示启动后端；同时确认 `logs/backend_uvicorn.err.log`。

---

## 3. 修改字段（新增 / 重命名列）

### 3.1 只改人工评审列 / 展示名

改 `aml_skill_review/lib/columns.ts` 的 `FIELD_COLUMNS` 即可（表头、详情、导出共用）。注意：
- `FIELD_NAMES` 会随之变化，**业务库表结构是建表时快照**，已存在的表**不会自动加列**——需重建表（重新导入）或手动 `ALTER TABLE`。
- 重命名 `label` 不影响数据；重命名 `field`（英文名）会让旧表列对不上。

### 3.2 新增分析脚本输出列（**要改两处**）

1. `process_skills/run_jql_with_skill_demo.py` 的 `headers` —— 让 xlsx 真正产出该列。
2. `aml_skill_review/lib/columns.ts` —— `FIELD_COLUMNS` 加字段 + `HEADER_ALIASES` 加表头别名。

否则会出现「xlsx 有列 → 导入时被当作未知表头告警跳过 → 数据库里没有」的现象。

---

## 4. 换 Skill 根目录

Skill 实际存放根由后端 `config.SKILL_DIR_ROOT` 决定（默认 `Rubick/AmlAgent/expert-skills/log_analyse_skills`），可用同名 env 覆盖。

> `aml_skill_review/lib/config.ts` 里也有一个 `SKILL_DIR_ROOT`，但**当前无任何引用**（遗留），改它不生效——请改后端 `config.py` 或设 env。

---

## 5. 新增一个后端接口

1. 在 `process_skills/server/main.py` 加 `@app.<method>("/api/backend/...")`，用 `Depends(auth)` / `Depends(admin_only)`。
2. **前端无需改代理**——`/api/backend/[...path]` 通配透传，加上后立即可用。
3. 若要在页面调用，在对应组件里 `fetch("/api/backend/...")`。
4. 接口清单记得同步更新 [api-reference.md](./api-reference.md)。

---

## 6. 定时任务 / cron

- 任务定义在 `process_skills/skills_tasks.yaml`（字段见该文件顶部注释）。
- 触发由后端调度线程 `executor.start_scheduler` + `cron_match` 完成，**无需 crontab**。
- `trigger: once` 的一次性任务执行后自动 `enabled: false`；`cron_fired` 记录已触发分钟防重复。
- 改 cron 语法要动 `executor.cron_match`，并保证 yaml 里的格式与新实现一致。
- 管理员可在「任务管理」页面审批/删除任务定义（`admin/task-defs`、`approvals/def/*`）。

---

## 7. 改并发上限

- 初始值：`process_skills/server/config.py` 的 `DEFAULT_MAX_CONCURRENT`（默认 2）。
- 运行期值：存在 `server_data/task_state.json` 的 `config.max_concurrent_tasks`，管理员可在页面改（`PUT /admin/task-config`，范围 1~16）。
- 调度循环的轮询间隔在 `executor.py` 的调度循环里；清理阈值（默认 7 天）在 `_cleanup_old_runs`。

---

## 8. 改判定口径（**必须前后端一致**）

「命中 / 相关 / 错误 / 未知」的归一规则与「人工优先、大模型兜底」的口径同时出现在：

- 后端判定：`process_skills/llm_judge_agent_comment_accuracy.py`（产出 `Judge Verdict` 等）
- 前端统计：`aml_skill_review/lib/stats.ts` 的 `classifyVerdict` / `finalVerdict`

**改一处必须评估另一处**，否则统计页一致率与列表徽标会对不上。

---

## 9. 已知遗留与注意事项

| 项 | 说明 |
|---|---|
| `lib/config.ts` 的 7 个常量 | `SKILL_DIR_ROOT`、`SKILL_OWNER_DB_PATH`、`TASK_DB_PATH`、`TASK_OUTPUT_DIR`、`DEFAULT_MAX_CONCURRENT_TASKS`、`SKILL_RUNNER_SCRIPT`、`RUBICK_ROOT` —— **全站无引用**（早期 Next.js 自管 Skill/任务遗留），确认后可删 |
| `aml_skill_review/data/skill_owners.db`、`tasks.db`、`task_output/` | 同上来源的残留数据文件 |
| `adm-zip` 依赖 | `package.json` 声明但全站无引用（Skill zip 上传实际由 FastAPI 处理） |
| `ipml`/`run_skills_scheduler` | 仅剩 `__pycache__/run_skills_scheduler.cpython-311.pyc`，源码已删；`cron_run_*.log` 为其日志 |
| `aml_skill_review/README.md`、`skill_tests/README.md` | 描述偏旧（Skill/任务管理已迁 FastAPI），以 `doc/` 为准 |
| 文件夹名 vs 包名 | 目录叫 `aml_skill_review`，`package.json` 的 `name` 是 `skill-review` |
| Node 版本 | 前端用内置 `node:sqlite`，**必须 Node.js ≥ 22** |
| Python 版本 | `__pycache__` 显示为 cpython-311（3.11）；部署环境用 `/home/amlogic/.pyenv/shims/python` |
| 后端可选依赖 | `run_jql_with_skill_demo.py` 会 `MagicMock` 掉 jose/passlib/ldap3/psycopg2/smolagents/litellm/apscheduler/pytz；新增 `backend.*` 依赖前先确认不在该清单 |
| jira_analysis 同步 | 源码注释提示「每次要手动更新 jira_analysis 到 jira_analysis_for_skills.py」 |
| 邮箱前缀 = 登录名 | 任务结果复制到 `user_data/<邮箱前缀小写>/`，**邮箱前缀必须与登录名一致**，否则对应用户看不到结果 |
| Skill 描述 | 缩略图区默认折叠、且**不截断**名称/描述；若被截断通常是后端数据问题（`_extract_description` 的 `[:200]` 已移除） |

---

## 10. 常见故障速查

| 现象 | 排查 |
|---|---|
| 页面 `/skills`、`/tasks` 报「任务后端不可用」 | 后端未启动 → 看 `logs/backend_uvicorn.err.log`，确认 12371 在听 |
| 分析任务一直「排队中」 | 并发已满（`task_config` 的 max）；看 `task_state.json` 的 runs 状态 |
| 任务完成但前端「选择数据文件」看不到结果 | 任务 `email` 前缀与登录名不一致；排查 `copy_to_user_dirs` 目标目录 |
| 导入后某些列是空 | xlsx 表头没匹配上 `HEADER_ALIASES`，看导入告警；或该列不在 `FIELD_NAMES` |
| 统计一致率与直觉不符 | 口径是「人工优先、大模型兜底」，且只统计**已评审**条目的 `agreed / reviewed` |
| 上传 Skill 报 409 | 同名 Skill 已存在，需带 `confirm_duplicate` 覆盖确认 |
| 首个账号登录后要求改密 | 正常逻辑（首个账号首登强制改密） |
| 前端编译缓存异常 | 删 `aml_skill_review/.next` 重启；`tsconfig.tsbuildinfo` 也可删 |

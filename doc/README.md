# skill_tests 项目说明文档

> 本文档面向**后期维护人员**，用于理解与修改 `Rubick/backend/tests/skill_tests/` 下的全部代码。
> 目标是「读完就能定位改哪里」：每份文档都给出文件路径、函数名、接口路径与关键字段。

---

## 1. 这个系统是什么

`skill_tests` 是一个 **Jira 工单「大模型 Skill 分析 + 人工评审」一体化工具集**，由两个互相配合的子系统组成：

| 子系统 | 目录 | 角色 | 技术栈 |
|---|---|---|---|
| 生产端 | [`process_skills/`](../process_skills/) | 按 JQL 批量拉取 Jira 工单 → 调用大模型 Skill 分析 → 导出 xlsx | Python 3 + FastAPI + 内置调度线程 |
| 消费端 | [`aml_skill_review/`](../aml_skill_review/) | 把 xlsx 导入数据库 → Web 界面人工复核 → 统计人工 vs 大模型一致率 | Next.js 16 + SQLite |

一句话：**`process_skills` 负责「跑」，`aml_skill_review` 负责「审」。**

---

## 2. 系统全景图

```
┌─────────────────────────── 浏览器 ───────────────────────────┐
│  http://127.0.0.1:1237                                       │
│  Next.js 前端（aml_skill_review，端口 1237）                  │
│    /            欢迎页         /analysis   质量分析(列表/导入) │
│    /review/[id] 详情评审       /stats      评审统计           │
│    /type-stats  跨表对比       /skills     Skill 管理(上传/审核)│
│    /tasks       分析任务管理   /users      用户管理(管理员)    │
└───────────┬──────────────────────────────┬───────────────────┘
            │ 同源 fetch                    │ /api/backend/* 代理
            ▼                              ▼
   ┌────────────────────┐        ┌─────────────────────────────────┐
   │ Next.js API 路由    │        │ FastAPI 任务后端                 │
   │ app/api/auth/*      │        │ process_skills/server            │
   │ app/api/{files,rows,│        │ 端口 12371（只绑 127.0.0.1）      │
   │ import,row,review,  │        │ main.py / executor.py /          │
   │ stats,type-stats,   │        │ skills_mgr.py / storage.py       │
   │ export,users}       │        └──────────────┬──────────────────┘
   └─────────┬───────────┘                       │ subprocess（cwd=Rubick 根）
             │ node:sqlite                        ▼
             ▼                          ┌──────────────────────────────┐
   ┌──────────────────────┐             │ run_jql_with_skill_demo.py    │
   │ SQLite                │            │  Jira(JQL) → AI Skill 分析     │
   │ 账户库 user_account.db │            │  → llm_judge 结论判定 → xlsx  │
   │ 业务库 user_data/<u>/  │◀──(复制结果 filtered xlsx)──────────────┘
   │   <u>.db（表名=xlsx名）│
   └──────────────────────┘
```

三个进程彼此独立：

1. **Next.js 前端**（端口 1237）——浏览器唯一入口。
2. **FastAPI 任务后端**（端口 12371）——只监听本机，浏览器不直接访问，由前端代理转发。
3. **任务子进程** `run_jql_with_skill_demo.py`——由后端 `executor.py` 用 `subprocess.Popen` 拉起，工作目录为 Rubick 根。

---

## 3. 核心数据流

```
Jira ──JQL──▶ run_jql_with_skill_demo.py ──(AI Skill 分析 + Judge 判定)──▶ runs/<run_id>/*.xlsx
                                                                          │
                                       成功且有 email：生成「Final 非空」过滤副本
                                                                          ▼
                                 aml_skill_review/data/user_data/<邮箱用户名小写>/*.xlsx
                                                                          │
                                         前端「选择数据文件」→ /api/import 导入
                                                                          ▼
                                            SQLite（表名 = xlsx 文件名）→ 人工评审 → 统计一致率
```

---

## 4. 关键约束（改代码前必读）

- **目录位置不可随意移动**：`run_jql_with_skill_demo.py` 通过 `parents[3]` 向上定位 Rubick 根目录并 `import backend.api.*`，后端 `config.py` 同样依赖这个层级。移动会同时破坏两处。详见 [maintenance-guide.md](./maintenance-guide.md#1-目录与路径依赖)。
- **后端只绑 127.0.0.1**：前端通过 `X-INTERNAL-TOKEN` 共享密钥 + `X-USER` / `X-IS-ADMIN` 头鉴权，浏览器无法直接调 FastAPI。详见 [frontend-aml_skill_review.md](./frontend-aml_skill_review.md#4-与-fastapi-的代理与鉴权链路)。
- **每个用户数据隔离**：登录名 = 数据文件夹名，业务库为 `user_data/<登录名>/<登录名>.db`，互相看不到。详见 [data-and-storage.md](./data-and-storage.md)。
- **xlsx 表头 ↔ 数据库字段映射是「全站唯一来源」**：改字段只需改 `lib/columns.ts`，但**新增输出列还要同步改** `run_jql_with_skill_demo.py` 的 `headers`。详见 [maintenance-guide.md](./maintenance-guide.md#3-修改字段新增--重命名列)。

---

## 5. 文档索引

| 文档 | 内容 |
|---|---|
| [README.md](./README.md)（本文） | 总览、数据流、文档导航 |
| [backend-process_skills.md](./backend-process_skills.md) | 生产端：分析脚本 + Judge 判定 + FastAPI 服务（config/storage/skills_mgr/executor/main） |
| [frontend-aml_skill_review.md](./frontend-aml_skill_review.md) | 消费端：Next.js 页面、组件、lib、代理与鉴权 |
| [api-reference.md](./api-reference.md) | FastAPI 与 Next.js 全部接口清单（路径 / 方法 / 权限 / 参数） |
| [data-and-storage.md](./data-and-storage.md) | 所有落盘文件的格式、字段字典、数据库表结构 |
| [maintenance-guide.md](./maintenance-guide.md) | 常见修改场景的操作步骤 + 已知遗留问题与坑 |

> 项目根目录另有一份 [`../README.md`](../README.md)（功能与使用说明）和 [`../aml_skill_review/README.md`](../aml_skill_review/README.md)（评审端使用说明）。
> 注意：后者描述的是较早的架构，**新增的 Skill 管理 / 任务管理已迁移到 FastAPI 后端**，以本 `doc/` 目录为准。

---

## 6. 快速上手

### 一键启动（推荐）

```bash
# Windows
start_all.bat          # 自动装依赖 → 启动后端 12371 + 前端 1237

# Linux / macOS / Git Bash
chmod +x start_all.sh && ./start_all.sh
```

浏览器访问 **http://127.0.0.1:1237**。第一次打开登录页时，**第一个登录的人自动成为管理员**。

### 一键关闭

```bash
stop_all.bat           # 按端口 12371 / 1237 结束进程
./stop_all.sh
```

### 分别手动启动

```bash
# 后端（FastAPI）
cd process_skills
python -m uvicorn server.main:app --host 127.0.0.1 --port 12371

# 前端（Next.js）
cd aml_skill_review
pnpm install           # 仅首次
pnpm dev               # 端口 1237
```

### 手动跑一次分析（验证联调）

```bash
cd process_skills
python run_jql_with_skill_demo.py \
    --jql 'key in (OTT-84222, TV-252209)' \
    --skill aml-display-debug \
    --output skills_result_output/test-manual.xlsx \
    --max_issues 1 \
    --email lingzhi.bi@amlogic.com
```

### 环境依赖

| 工具 | 版本 | 用途 |
|---|---|---|
| Python | 3.x（部署环境用 `/home/amlogic/.pyenv/shims/python`） | 跑 `process_skills` |
| Node.js | v22 以上（用到内置 `node:sqlite`） | 跑 `aml_skill_review` |
| pnpm | 任意现代版本 | 前端包管理 |
| Rubick 后端 | 同分支可运行 | 分析脚本 `import backend.api.*` 依赖 |
| FastAPI 依赖 | `process_skills/server_requirements.txt` | fastapi / uvicorn / python-multipart / PyYAML（openpyxl 复用环境已有） |

### 环境变量

放 `skill_tests/.env`（首次运行会兜底加载，进程已有变量优先）：

| 变量 | 含义 |
|---|---|
| `JIRA_BOT_USERNAME` / `JIRA_BOT_PASSWORD` | Jira Bot 凭据 |
| `JIRA_BOT_SERVER` | Jira 地址（默认 `https://jira.amlogic.com`） |
| `RUN_JQL_QUERY` | 默认 JQL（`--jql` 优先） |
| `BATCH_ANALYSIS_EMAIL` | 默认收件人（`--email` 优先） |
| `SMTP_HOST` / `SMTP_PORT` | SMTP（默认 `mail-sh.amlogic.com:587`） |
| `SMTP_USERNAME` / `SMTP_PASSWORD` / `SMTP_SENDER` | 发件凭据 |
| `SKILL_API_HOST` / `SKILL_API_PORT` | FastAPI 监听（默认 `127.0.0.1:12371`） |
| `SKILL_API_TOKEN` | 内部共享密钥（不设则自动生成 `server_data/.api_token`） |
| `SKILL_API_BASE` | 前端代理的目标地址（默认 `http://127.0.0.1:12371`） |
| `SKILL_DIR_ROOT` | Skill 根目录（默认 `Rubick/AmlAgent/expert-skills/log_analyse_skills`） |
| `USER_DATA_DIR_ROOT` | 前端 user_data 根目录（默认 `aml_skill_review/data/user_data`） |

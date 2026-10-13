# skill_tests

Jira 工单「Skill 大模型分析 + 人工评审」一体化工具集。

本仓库由两个互相配合的子系统组成：

| 子目录 | 角色 | 技术栈 |
|---|---|---|
| [`process_skills/`](process_skills/) | **生产端**：按 JQL 批量拉取 Jira 工单 → 调用大模型 Skill 分析 → 输出 xlsx | Python 3 + cron |
| [`aml_skill_review/`](aml_skill_review/) | **消费端**：把上一步生成的 xlsx 导入数据库 → Web 评审界面做人工校验 → 统计一致率 | Next.js 16 + SQLite |

整体数据流：

```
Jira ─ JQL ─▶ run_jql_with_skill_demo.py ──(AI Skill 分析)──▶ test-*.xlsx
                                                              │  (复制到 user_data/<登录名>/)
                                                              ▼
                                          aml_skill_review  Web 评审 ──▶ 人工判定入库 + 统计
```

`process_skills` 负责「跑」——按 cron 定时跑各种 JQL，让 Skill 给出根因判定；
`aml_skill_review` 负责「审」——把 Skill 跑出来的 xlsx 拉进网页，让人逐条复核、最终统计人工 vs 大模型的一致率。

---

## 新增功能

### 1. Skill 管理系统

在 `aml_skill_review` 中新增了 Skill 管理页面（`/skills`），支持：

- **浏览全部 Skill**：侧边栏对所有用户显示全部 Skill，点击名称可折叠/展开查看 SKILL.md 的 description
- **上传需审核（含同名二次确认）**：上传 zip 包后进入待审核状态；若与已有 Skill 同名，会弹出二次确认，确认后需等待管理员审核通过才会覆盖原 Skill；管理员审核通过后才放入正式目录，方可使用
- **撤销上传**：审核通过前，上传者可在「上传审核」区域撤销自己的上传（暂存内容被丢弃，审核记录移除）；管理员也可撤销任意待审核上传
- **审核（管理员）**：对待审核上传可「通过」（放入正式目录，同名先覆盖）或「拒绝」（丢弃暂存内容）
- **审批通知**：管理员审核通过 / 拒绝都会通知上传者；上传者查看后点「取消通知」可将其永久移除，之后不再发送
- **上传前检查**：上传新 Skill 前请先查看已有 Skill 的 description，确认没有包含要上传的 Skill 的触发条件，避免重复
- **预览 Skill**：查看 skill 目录文件树和文件内容（SKILL.md 等）；审核通过前，上传者与管理员可提前预览待审核暂存内容
- **删除 Skill**：从磁盘和数据库中删除，仅管理员可用（普通用户不提供删除功能）
- **Owner 权限**：每个 skill 有一个 owner；所有用户都能查看全部 skill，管理员可为 skill 设置 owner

Skill 目录位于 `AmlAgent/expert-skills/log_analyse_skills/`，结构如下：
```
log_analyse_skills/
├── log_analyse/          ← 一个 skill
├── wifi_bt_skills/       ← skill 类型组
│   ├── wifi-bug-analyzer/
│   └── analyze-bt-log/
└── kernel_skills/
    ├── timer/
    ├── kernel-debug/
    └── ...
```

### 2. 任务管理系统

在 `aml_skill_review` 中新增了任务管理页面（`/tasks`），支持：

- **启动分析任务**：选择自己的 skill，输入 JQL，启动一次 AI 分析
- **最大并发控制**：管理员可配置最大并发任务数（默认 2），超过则排队
- **任务状态**：查看任务进度（queued / running / completed / failed / stopped）
- **队列位置**：owner 可以看到当前有多少任务运行中、自己排在第几位
- **日志查看**：实时查看任务运行日志，支持下载日志文件
- **手动停止**：可手动停止运行中或排队中的任务
- **结果下载**：下载分析结果 xlsx 文件

---

## 一、应该放在哪个位置？

**必须放在**：

```
<Rubick 根目录>/backend/tests/skill_tests/
```

也就是默认部署路径：

```
/home/amlogic/FAE/disk02/AutoLog/lingzhi.bi/Rubic/aml_seprime_kit/Rubick/backend/tests/skill_tests/
```

### 为什么必须放在这个位置？

`process_skills/run_jql_with_skill_demo.py` 通过相对路径向上找 Rubick 根目录，并 `import` 后端的业务模块：

```python
_HERE    = Path(__file__).resolve().parent      # process_skills/
_RUBICK  = _HERE.parents[3]                     # Rubick 根目录
_AMLAGENT = _RUBICK / "AmlAgent"

import backend.api.jira_analysis_for_skills as ja
import backend.api.batch_jql_runner as batch
```

- `parents[3]` 要求本目录正好位于 `<Rubick>/backend/tests/skill_tests/process_skills/` 这一层；
  放浅了或放深了，`import backend.api...` 都会失败。
- 后端服务（`process_skills/server/executor.py`）任务成功后会把分析结果 xlsx 复制到
  `skill_tests/aml_skill_review/data/user_data/<登录名小写>/`，供 Web 评审端读取。

如果改成其他路径，需要同步修改上面两处相对路径逻辑。

---

## 二、目录结构

```
skill_tests/
├── README.md                      ← 本文件
├── .gitignore
├── __init__.py
│
├── process_skills/                ← skill 任务服务：FastAPI 调度后端 + 分析脚本
│   ├── __init__.py
│   ├── run_jql_with_skill_demo.py  ← 单次任务：JQL → AI Skill 分析 → 导出 xlsx
│   ├── skills_tasks.yaml            ← 任务配置（cron / run_at / JQL / skill / email）
│   ├── server/                      ← FastAPI 后端（main / executor 内置调度 / storage / config）
│   └── skills_result_output/        ← 旧版 cron 调度的历史输出（已停用，可清理）
│
└── aml_skill_review/              ← Next.js 评审 Web 端
    ├── README.md                   ← 评审系统详细文档（运行 / 架构 / 接口 / 数据库表结构）
    ├── package.json
    ├── pnpm-workspace.yaml
    ├── next.config.mjs
    ├── tsconfig.json
    ├── postcss.config.mjs
    ├── app/                        ← Next.js 路由 + API
    ├── components/                 ← 页面组件
    ├── lib/                       ← 业务逻辑（auth / db / xlsx-import / stats / config ...）
    └── data/                       ← 运行时数据（不入库：user_account.db + user_data/）
```

> 详细的评审端文档（账号体系、API 列表、数据库列结构、常见问题）见
> [aml_skill_review/README.md](aml_skill_review/README.md)。

---

## 三、如何使用 / 启动

### 前置依赖

| 工具 | 版本要求 | 用途 |
|---|---|---|
| Python | 3.x（项目使用 `/home/amlogic/.pyenv/shims/python`） | 跑 `process_skills` 脚本 |
| Node.js | v22 以上 | 跑 `aml_skill_review` 前端 |
| pnpm | 任意现代版本 | 前端包管理 |
| Rubick 后端 | 同分支可运行 | `run_jql_with_skill_demo.py` 依赖 `backend.api.*` |

### 必需的环境变量（仅 `process_skills` 用到）

| 变量 | 含义 |
|---|---|
| `JIRA_BOT_USERNAME` / `JIRA_BOT_PASSWORD` | Jira Bot 账号凭据 |
| `JIRA_BOT_SERVER` | Jira 服务器地址（默认 `https://jira.amlogic.com`） |
| `RUN_JQL_QUERY` | JQL 查询语句（命令行 `--jql` 优先级更高） |
| `BATCH_ANALYSIS_EMAIL` | 收件人邮箱（逗号分隔，`--email` 优先级更高） |
| `SMTP_HOST` / `SMTP_PORT` | SMTP 服务器（默认 `mail-sh.amlogic.com:587`） |
| `SMTP_USERNAME` / `SMTP_PASSWORD` / `SMTP_SENDER` | SMTP 发件凭据 |

### 1）启动 Web 评审端（`aml_skill_review`）

```bash
cd skill_tests/aml_skill_review
pnpm install      # 第一次使用时安装依赖（只需一次）
pnpm dev          # 启动开发服务器
```

启动成功后浏览器访问：**http://localhost:1237**

> 第一次打开会要求登录，第一个登录的人自动成为管理员。
> 详细使用步骤（登录、选 xlsx、过滤、详情评审、统计、对比页、用户管理）见
> [aml_skill_review/README.md](aml_skill_review/README.md) 的「一、如何运行」一节。

### 2）手动跑一次 Skill 分析（验证联调）

```bash
cd skill_tests/process_skills
python run_jql_with_skill_demo.py \
    --jql 'key in (OTT-84222,TV-252209)' \
    --skill analyze_bt_log \
    --output skills_result_output/test-manual.xlsx \
    --max-issues 1 \
    --email lingzhi.bi@amlogic.com
```

- `--jql`：Jira JQL 查询语句
- `--skill`：调用的 Skill 名称（与 Rubick/AmlAgent 中注册的技能对应）
- `--output`：输出 xlsx 路径
- `--max-issues`：最多送 AI 分析的条数（0 = 不限）
- `--email`：分析结果会按邮箱用户名小写复制到 `aml_skill_review/data/user_data/<用户名>/` 下，
  方便 Web 端直接选中导入。

### 3）定时 / 一次性任务调度

定时 / 一次性任务无需 crontab：由后端服务 `server/executor.py` 内置的
调度线程（`start_scheduler()`）按 `skills_tasks.yaml` 中的配置自动触发。

任务配置在 [`process_skills/skills_tasks.yaml`](process_skills/skills_tasks.yaml)：

```yaml
tasks:
  - name: over_60round_BT        # 任务名
    trigger: cron                # cron（周期）| once（指定时间一次）
    cron: "48 14 * * *"          # 5 段 cron：分 时 日 月 周（trigger=cron 时生效）
    run_at: "2026-10-12 18:00"   # 一次性时间（trigger=once 时生效）
    skill: "analyze_bt_log"      # Skill 名（留空则不指定技能）
    jql: |-                      # JQL 查询
      key in (OTT-84222,TV-252209,...)
    email: "lingzhi.bi@amlogic.com"   # 收件人；同时决定 user_data/<用户名>/ 落盘位置
    max_issues: 1                # 最多分析条数，0=不限
```

调度特性：

- 立即执行 / 一次性 / cron 统一排队，按 `max_concurrent_tasks` 并发执行；
- 按 cron 表达式判断任务是否该执行（支持 `* , - /`），once 任务执行后自动停用；
- 任务日志与结果 xlsx 落盘到 `server_data/runs/<run_id>/`，
  xlsx 命名为 `<时间>_<skill名>.xlsx`；
- 任务成功 + 配置了 email 时，会自动生成「Final 列非空」过滤副本并复制到
  `aml_skill_review/data/user_data/<邮箱用户名小写>/`，前端即可直接选文件导入。

---

## 四、忽略入库的文件清单

详见 [.gitignore](.gitignore)。简而言之，下列内容**不会**进入 git：

- 前端依赖：`aml_skill_review/node_modules/`
- 前端构建产物：`aml_skill_review/.next/`、`next-env.d.ts`、`*.tsbuildinfo`
- pnpm 本地缓存：`.pnpm-store/`、`.pnpm-cache/`
- 运行时数据库：`*.db`、`*.db-journal`、`*.db-shm`、`*.db-wal`
- 用户数据目录：`data/user_data/`、`**/user_data/`
- 服务运行数据：`process_skills/server_data/`（runs/ + json 状态）
- 旧版 cron 输出：`process_skills/skills_result_output/`（已停用，可清理）
- 全部日志：`*.log`
- 全部 xlsx/xls 数据文件：`*.xlsx`、`*.xls`、`*.xlsm`
- Python 缓存：`__pycache__/`、`*.pyc`

重新部署时只需：

```bash
# 前端
cd skill_tests/aml_skill_review && pnpm install

# Python（建议在 Rubick 根目录的虚拟环境里）
#   无需额外安装，依赖来自 Rubick 后端
```

---

## 五、相关链接

- 评审端独立仓库：<https://github.com/bilingzhi05/aml_skill_review>
- Jira：<https://jira.amlogic.com>
- Rubick 后端：本仓库 `skill_tests/` 的上一级（4 层之上）即 Rubick 根目录。

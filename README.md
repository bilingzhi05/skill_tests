# skill_tests

Jira 工单「Skill 大模型分析 + 人工评审」一体化工具集。

本仓库由两个互相配合的子系统组成：

| 子目录 | 角色 | 技术栈 |
|---|---|---|
| [`process_skills/`](process_skills/) | **生产端**：按 JQL 批量拉取 Jira 工单 → 调用大模型 Skill 分析 → 输出 xlsx | Python 3 + cron |
| [`aml_skill_review/`](aml_skill_review/) | **消费端**：把上一步生成的 xlsx 导入数据库 → Web 评审界面做人工校验 → 统计一致率 | Next.js 14 + SQLite |

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
- `run_skills_scheduler.py` 还会把分析结果 xlsx 复制到
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
├── process_skills/                ← Python 调度与分析脚本
│   ├── __init__.py
│   ├── run_jql_with_skill_demo.py  ← 单次任务：JQL → AI Skill 分析 → 导出 xlsx
│   ├── run_skills_scheduler.py      ← cron 调度器：按 skills_tasks.yaml 跑多个任务
│   ├── skills_tasks.yaml            ← 任务配置（cron / JQL / skill / email / max_issues）
│   └── skills_result_output/        ← 运行时输出（不入库：log + xlsx + pid 锁）
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

### 3）启用 cron 定时调度

`run_skills_scheduler.py` 设计为每分钟由 crontab 唤起，按 `skills_tasks.yaml` 中的 cron 表达式判断哪些任务该执行：

```cron
* * * * * cd /home/amlogic/FAE/disk02/AutoLog/lingzhi.bi/Rubic/aml_seprime_kit/Rubick/backend/tests/skill_tests/process_skills && /home/amlogic/.pyenv/shims/python run_skills_scheduler.py >> /dev/null 2>&1
```

任务配置在 [`process_skills/skills_tasks.yaml`](process_skills/skills_tasks.yaml)：

```yaml
tasks:
  - name: over_60round_BT        # 任务名（用于输出文件命名）
    cron: "48 14 * * *"          # 5 段 cron：分 时 日 月 周
    skill: "analyze_bt_log"      # Skill 名（留空则不指定技能）
    jql: |-                      # JQL 查询
      key in (OTT-84222,TV-252209,...)
    email: "lingzhi.bi@amlogic.com"   # 收件人；同时决定 user_data/<用户名>/ 落盘位置
    max_issues: 1                # 最多分析条数，0=不限
```

调度器特性：

- 按 cron 表达式判断任务是否该执行（支持 `* , - /`）；
- 任务已在运行则跳过（基于 pid 锁文件，超过 24h 自动清理死锁）；
- 子进程输出落盘到 `skills_result_output/cron_run_<task>_jql_<时间>.log`；
- 分析结果 xlsx 落盘到 `skills_result_output/test-<task>-<时间>.xlsx`；
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
- 任务运行输出：`process_skills/skills_result_output/`（xlsx + log + pid 锁）
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

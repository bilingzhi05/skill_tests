# Jira Skill 评审系统

一个用于查看 Jira 工单 Skill（大模型）分析结果、并进行人工评审判定的本地 Web 工具。

功能：登录（账号按人隔离）→ 选择 xlsx 文件自动导入数据库 → 按判定结果过滤查看列表 → 进入详情页保存人工判定 → 统计页查看分布与一致性。

### 账号与数据隔离规则

- 系统**第一次**打开登录页时，第一个登录的人会自动成为**管理员（admin）**；之后的人在「注册」页签创建普通用户。
- **管理员**：可以在「用户管理」页修改所有人（包括管理员）的登录名和密码、新增用户。
- **普通用户**：可以在登录页「修改密码」页签改自己的密码（需要原密码）。
- **登录名 = 数据文件夹名**：每个用户只能看到、加载自己文件夹
  （`user_data/<登录名>/`）里的 xlsx；导入时会在自己文件夹里创建独立数据库
  （例如 `lingzhi.bi` → `user_data/lingzhi.bi/lingzhi_bi.db`）。

---

## 一、如何运行

> 前提：电脑已安装 Node.js（v22 以上）和 pnpm。

在本文件夹（`skill-review`）目录下打开终端，依次执行：

```bash
pnpm install   # 第一次使用时安装依赖（只需执行一次）
pnpm dev       # 启动开发服务器
```

启动成功后浏览器访问：**http://localhost:1237**

停止服务：在终端按 `Ctrl + C`。

### 使用步骤

1. 打开 **http://localhost:1237**，未登录会自动跳到登录页。
   第一次使用时输入登录名和密码登录，即自动创建管理员账号。
2. 登录后在首页**左侧「选择数据文件」**下拉框中选择一个 xlsx 文件
   （只列出你自己文件夹里的文件）。
3. 首次选择时系统会解析 xlsx 并写入你自己的数据库（表名 = 文件名）；
   再次选择同一文件会直接读取数据库，不会重复导入。
4. 用表格上方的**「大模型判定」「人工判定」**两个下拉框过滤数据（都含「未判定」选项），
   右上角显示总条数，点**「导出 xlsx」**可把当前过滤结果导出为 Excel。
5. 点每行的**「详情」**进入评审页，选择人工判定（可选「未判定」清空）、填写原因后点**「保存」**。
6. 点**「同Skill结果对比全览」**进入对比页：勾选任意数据表（按类型分组，可随时加入/取消），
   按 Jira ID 对齐多张表对比最终判定（人工优先、大模型兜底），不一致的行会高亮，
   同时显示每张选中表的三类判定（命中/相关/错误，含未知）汇总。
7. 点**「评审统计」**查看总数、四类判定分布、一致率和差异清单。
8. 管理员点左侧**「用户管理」**可新增账号、修改任何人的登录名/密码；
   所有用户都可以点**「退出登录」**。

### 关键位置说明

| 内容 | 位置 |
|---|---|
| 账户数据库 | `skill-review/data/user_account.db`（账号 + 登录会话，密码只存哈希） |
| 每个用户的数据库 | `user_data/<登录名>/<登录名下划线化>.db`（如 `lingzhi.bi/lingzhi_bi.db`），删除即清空该用户数据 |
| xlsx 数据源根目录 | `c:\Users\lingzhi.bi\Downloads\jira\user_data\`（可在 `lib/config.ts` 修改） |
| Jira 工单链接 | 详情页标题会跳转到 `https://jira.amlogic.com/browse/<JiraID>` |

---

## 二、代码架构总览

```
请求流程（以列表页为例）：

浏览器页面 (components/*.tsx)
   │  fetch 请求
   ▼
API 路由 (app/api/**/route.ts)      ← 负责接收请求、校验参数
   │  调用函数
   ▼
业务逻辑层 (lib/*.ts)               ← 负责解析 xlsx、计算统计、拼 SQL
   │  读写
   ▼
SQLite 数据库
 ├─ 账户库 data/user_account.db（所有用户共用：账号、会话）
 └─ 业务库 user_data/<登录名>/<登录名>.db（每人一个，互相隔离）
```

- **页面层**（`app/` + `components/`）：用户看得见的界面，全部通过 `fetch` 调 API，不直接碰数据库。
- **API 层**（`app/api/`）：登录账户接口 + 7 个数据接口，负责登录校验、参数校验和错误处理。
- **逻辑层**（`lib/`）：账户与会话、数据库操作、xlsx 解析、统计计算、字段映射。

---

## 三、每一个文件的作用

### 配置文件

| 文件 | 作用 |
|---|---|
| `package.json` | 项目依赖与启动脚本（`pnpm dev` 等命令的定义处） |
| `pnpm-workspace.yaml` | 声明本目录为独立 pnpm 工作区，并配置本地缓存目录、复制式安装等兼容参数 |
| `next.config.mjs` | Next.js 构建配置 |
| `tsconfig.json` | TypeScript 编译配置 |
| `postcss.config.mjs` | Tailwind CSS 4 的样式编译配置 |
| `.gitignore` | 告诉 git 哪些文件不用提交（node_modules、数据库等） |

### lib/（业务逻辑层）

| 文件 | 作用 |
|---|---|
| `lib/config.ts` | 全局配置：数据根目录、账户库位置、Cookie 名、按登录名计算用户文件夹/数据库路径 |
| `lib/auth.ts` | **登录账户与会话**：账户库建表、密码加盐哈希、登录校验、会话 token、读取当前登录用户 |
| `lib/columns.ts` | **统一字段映射**：英文列名 ↔ 中文显示名 ↔ xlsx 表头别名，全站表头唯一来源 |
| `lib/db.ts` | 数据库操作大全（每个函数第一个参数是登录名，操作该用户自己的库）：建表、插入、分页查询、保存评审等 |
| `lib/xlsx-import.ts` | xlsx 导入：解析文件、模糊匹配表头、逐行容错写入用户自己的数据库 |
| `lib/stats.ts` | 统计逻辑：人工优先、大模型兜底归一为命中/相关/错误/未知四类，计算分布、一致率、差异清单 |
| `lib/api-utils.ts` | API 公共工具：表名校验、文件名安全校验、统一错误返回 |
| `lib/utils.ts` | 样式小工具：合并 CSS 类名 |

### app/api/（账户接口 + 7 个数据接口）

| 接口 | 方法 | 作用 |
|---|---|---|
| `/api/auth/login` | POST | 登录；系统无任何账号时，第一个登录的人自动成为管理员 |
| `/api/auth/register` | POST | 注册普通用户（注册成功自动登录） |
| `/api/auth/change-password` | POST | 自助修改密码（校验原密码） |
| `/api/auth/logout` | POST | 退出登录（删除会话、清除 Cookie） |
| `/api/auth/me` | GET | 查询当前登录用户（名字、是否管理员） |
| `/api/auth/status` | GET | 登录页用：是否已有账号、是否已登录 |
| `/api/users` | GET/POST/PUT | 仅管理员：列出全部用户 / 新增用户 / 修改任意用户登录名和密码 |
| `/api/files` | GET | 扫描当前用户自己的目录，返回可选 xlsx 文件列表 |
| `/api/import` | POST | 导入 xlsx：已有同名表直接复用，否则解析建表（写入用户自己的库） |
| `/api/rows` | GET | 列表页取数：按过滤条件分页查询 + 返回过滤选项 |
| `/api/row` | GET | 按 Jira ID 查询单条详情 |
| `/api/review` | POST | 保存人工判定与原因（判定传空 = 清空为未判定） |
| `/api/stats` | GET | 计算并返回统计页全部指标 |
| `/api/type-stats` | GET | 同Skill结果对比全览：列出用户全部表按类型分组；传 tables 参数时按 jira_id 对齐多表对比最终判定 |
| `/api/export` | GET | 按过滤条件返回全部数据，供前端导出 xlsx |

### app/ 与 components/（页面与组件）

| 文件 | 作用 |
|---|---|
| `app/layout.tsx` | 全站外壳：网页标题、全局样式、全局提示框 |
| `app/globals.css` | 全局样式与主题色变量 |
| `app/login/page.tsx` | 登录页路由入口 |
| `app/page.tsx` | 首页路由入口（未登录自动跳登录页） |
| `app/review/[id]/page.tsx` | 详情页路由入口：从网址取出 Jira ID 和表名 |
| `app/stats/page.tsx` | 统计页路由入口：从网址取出表名 |
| `app/users/page.tsx` | 用户管理页路由入口（仅管理员，否则跳回首页） |
| `components/login-page.tsx` | **登录页**：登录 / 注册 / 修改密码三个页签 |
| `components/users-page.tsx` | **用户管理页**：新增用户、修改任何人的登录名和密码 |
| `components/list-page.tsx` | **列表页**：文件选择 + 过滤 + 表格 + 导出 + 当前用户信息/退出登录 |
| `components/review-page.tsx` | **详情评审页**：完整分析内容展示 + 人工判定保存表单 |
| `components/stats-page.tsx` | **统计页**：概览卡片、占比与一致率、差异清单 |
| `components/type-stats-page.tsx` | **同Skill结果对比全览页**：按类型分表勾选、jira_id 对齐跨表判定对比 |
| `components/verdict-badge.tsx` | 判定彩色标签：命中绿/相关黄/错误红/未知灰/未判定虚线框 |
| `components/ui/*` | shadcn/ui 基础组件（按钮、表格、下拉框、卡片、输入框等） |

### 数据库表结构（所有列均为文本类型）

| 英文列名 | 中文含义 |
|---|---|
| skill_path / skill_name / jql / schedule_time | Skill 路径 / 名称 / JQL / 启动时间 |
| jira_id / summary / description | Jira ID / Summary / Description |
| root_cause / how_to_fix / comments | Root Cause / How to Fix / Comments |
| skill_raw / skill_final | Skill Raw / Skill Final |
| judge_real_result | 根因总结（Judge Real Result） |
| judge_verdict / judge_reason | 大模型判定 / 判定原因 |
| judge_aligned / judge_conflict | 判定相同点 / 判定不相同点 |
| human_judge / human_judge_reason | 人工判定 / 人工判定原因 |
| create_t / update_t | 创建时间 / 最后更新时间 |

表名 = xlsx 文件名（去掉 `.xlsx` 后缀）。

---

## 四、常见问题

- **忘记管理员密码**：删除 `data/user_account.db` 后重启服务，
  第一个登录的人会重新成为管理员（注意：所有账号和会话都会清空，业务数据不受影响）。
- **想重新导入某个文件**：删除该用户文件夹里的 `<登录名>.db` 后重启服务，再重新选择文件即可。
- **换了 xlsx 但看不到新文件**：新文件必须放进「自己的」数据文件夹（`user_data/<登录名>/`），再刷新首页。
- **修改登录名的影响**：登录名就是数据文件夹名，改名后旧文件夹不会自动迁移，
  请在改名前把旧文件夹改名为新登录名。

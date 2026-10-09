// ============================================================
// 全局配置文件
// 作用：集中存放「数据根目录、账户数据库位置、会话 Cookie 名、
// Jira 网址」等常量，以及按登录名计算「每个用户自己的文件夹 /
// 数据库文件路径」的工具函数。
// 如果以后换了电脑或目录位置，只需要改这一个文件。
// ============================================================

import path from "path"

/**
 * user_data 根目录（每个用户名对应它下面的一个子文件夹）。
 * 默认取「本项目目录 / data / user_data」，
 * 也就是 skill-review/data/user_data，与账户数据库同放在 data 目录下。
 * 也可以通过环境变量 USER_DATA_DIR_ROOT 覆盖。
 */
export const USER_DATA_ROOT =
  process.env.USER_DATA_DIR_ROOT || path.resolve(process.cwd(), "data", "user_data")

/**
 * 账户数据库文件位置：skill-review/data/user_account.db。
 * 里面存所有登录账号（users 表）和登录会话（sessions 表），
 * 与每个人的业务数据库分开，互相不影响。
 */
export const AUTH_DB_PATH = path.resolve(process.cwd(), "data", "user_account.db")

/** 登录后浏览器 Cookie 的名字（里面存的是会话编号，不是密码） */
export const SESSION_COOKIE = "skill_review_session"

/** Jira 工单详情页网址前缀（Jira ID 会拼接在后面） */
export const JIRA_BASE_URL = "https://jira.amlogic.com/browse"

// ============================================================
// Skill 管理相关配置
// ============================================================

/**
 * Skill 根目录（log_analyse_skills）。
 * 默认取 Rubick/AmlAgent/expert-skills/log_analyse_skills，
 * 也可通过环境变量 SKILL_DIR_ROOT 覆盖。
 */
export const SKILL_DIR_ROOT =
  process.env.SKILL_DIR_ROOT ||
  path.resolve(
    process.cwd(),
    "..", // 从 aml_skill_review 退到 skill_tests
    "..", // 退到 tests
    "..", // 退到 backend
    "..", // 退到 Rubick
    "AmlAgent",
    "expert-skills",
    "log_analyse_skills",
  )

/**
 * Skill 所有者映射数据库：data/skill_owners.db
 * 存储每个 skill 的 owner（登录名）和 skill 类型。
 */
export const SKILL_OWNER_DB_PATH = path.resolve(process.cwd(), "data", "skill_owners.db")

// ============================================================
// 任务管理相关配置
// ============================================================

/**
 * 任务数据库：data/tasks.db
 * 存储任务队列、状态、进度、日志路径。
 */
export const TASK_DB_PATH = path.resolve(process.cwd(), "data", "tasks.db")

/**
 * 任务输出目录：data/task_output/
 * 存储任务运行日志和 xlsx 结果文件。
 */
export const TASK_OUTPUT_DIR = path.resolve(process.cwd(), "data", "task_output")

/**
 * 最大并发任务数（默认 2，管理员可在页面上修改）。
 * 也可通过环境变量 MAX_CONCURRENT_TASKS 覆盖初始值。
 */
export const DEFAULT_MAX_CONCURRENT_TASKS = parseInt(
  process.env.MAX_CONCURRENT_TASKS || "2",
  10,
)

/**
 * run_jql_with_skill_demo.py 脚本路径。
 * 位于 skill_tests/process_skills/ 下。
 */
export const SKILL_RUNNER_SCRIPT = path.resolve(
  process.cwd(),
  "..", // 从 aml_skill_review 退到 skill_tests
  "process_skills",
  "run_jql_with_skill_demo.py",
)

/**
 * Rubick 根目录（run_jql_with_skill_demo.py 子进程的 cwd，
 * 脚本里用 `import backend.api.xxx`，需要以 Rubick 为根）。
 */
export const RUBICK_ROOT = path.resolve(
  process.cwd(),
  "..", // skill_tests/
  "..", // tests/
  "..", // backend/
  "..", // Rubick/
)

// ============================================================
// FastAPI 任务后端（process_skills/server）
// ============================================================

/** FastAPI 后端地址（只绑定本机） */
export const SKILL_API_BASE =
  process.env.SKILL_API_BASE || "http://127.0.0.1:1238"

/** 后端内部 Token 文件（后端启动时自动生成） */
const SKILL_API_TOKEN_FILE = path.resolve(
  process.cwd(),
  "..", // skill_tests/
  "process_skills",
  "server_data",
  ".api_token",
)

/**
 * 读取后端内部 Token：优先环境变量 SKILL_API_TOKEN，
 * 否则读取 FastAPI 服务生成的 server_data/.api_token。
 */
export function getBackendToken(): string {
  const envToken = process.env.SKILL_API_TOKEN
  if (envToken) return envToken
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("fs").readFileSync(SKILL_API_TOKEN_FILE, "utf-8").trim()
  } catch {
    return ""
  }
}

/**
 * 某个用户的数据文件夹：user_data/<登录名>。
 * 例如登录名 lingzhi.bi → user_data/lingzhi.bi。
 * 每个用户只能看到、加载自己文件夹里的 xlsx 文件。
 */
export function userDataDir(username: string): string {
  return path.join(USER_DATA_ROOT, username)
}

/**
 * 某个用户自己的数据库文件路径：放在该用户文件夹内，
 * 文件名 = 登录名里的字母数字以外字符替换成下划线 + .db。
 * 例如登录名 lingzhi.bi → user_data/lingzhi.bi/lingzhi_bi.db。
 */
export function userDbPath(username: string): string {
  const base = username.replace(/[^\w]/g, "_") || "user"
  return path.join(userDataDir(username), `${base}.db`)
}

/**
 * 校验登录名是否合法。
 * 作用：登录名同时是文件夹名，只允许字母、数字、点、下划线、连字符，
 * 长度 2~50，防止出现路径符号或特殊字符。
 */
export function isValidUsername(username: string): boolean {
  return /^[A-Za-z0-9._-]{2,50}$/.test(username)
}

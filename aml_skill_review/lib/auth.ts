// ============================================================
// 登录账户与会话文件
// 作用：管理所有登录账号和登录状态，使用独立的账户数据库
// data/user_account.db（和业务数据库分开）。包含：
//  1. users 表：登录名、密码哈希（不明文保存密码）、是否管理员；
//  2. sessions 表：登录后发给浏览器的会话编号（token）；
//  3. 密码加盐哈希（scrypt）与校验；
//  4. 服务端页面 / API 读取 Cookie 判断「当前是谁在访问」。
// ============================================================

import { DatabaseSync } from "node:sqlite"
import crypto from "crypto"
import fs from "fs"
import path from "path"
import { cookies } from "next/headers"
import { AUTH_DB_PATH, SESSION_COOKIE } from "@/lib/config"
import { nowString } from "@/lib/db"

/** 账户数据库连接（单例） */
let authDb: DatabaseSync | null = null

/** 用户记录类型（与 users 表对应） */
export type AuthUser = {
  id: number
  username: string
  is_admin: number // 1 = 管理员，0 = 普通用户
  create_t: string
}

/**
 * 获取账户数据库连接。
 * 作用：第一次调用时打开（并自动创建）data/user_account.db，
 * 并建好 users / sessions 两张表。
 */
export function getAuthDb(): DatabaseSync {
  if (authDb) return authDb
  fs.mkdirSync(path.dirname(AUTH_DB_PATH), { recursive: true })
  authDb = new DatabaseSync(AUTH_DB_PATH)
  authDb.exec("PRAGMA journal_mode = WAL")
  // 账户表：登录名唯一；密码只保存加盐哈希，不保存原文
  authDb.exec(`CREATE TABLE IF NOT EXISTS "users" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL UNIQUE,
    "password_hash" TEXT NOT NULL,
    "is_admin" INTEGER NOT NULL DEFAULT 0,
    "create_t" TEXT NOT NULL
  )`)
  // 会话表：token 是随机字符串，浏览器 Cookie 里保存的就是它
  authDb.exec(`CREATE TABLE IF NOT EXISTS "sessions" (
    "token" TEXT PRIMARY KEY,
    "username" TEXT NOT NULL,
    "create_t" TEXT NOT NULL
  )`)
  console.log("[账户] 已打开账户数据库:", AUTH_DB_PATH)
  return authDb
}

// ---------- 密码加盐哈希 ----------

/**
 * 把密码转成「盐:哈希」格式的字符串。
 * 作用：数据库里不存明文密码，即使数据库泄露也看不到原密码。
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex")
  const hash = crypto.scryptSync(password, salt, 64).toString("hex")
  return `${salt}:${hash}`
}

/**
 * 校验密码是否正确。
 * 作用：用同样的盐重新计算哈希再比较（恒定时间比较，防时序攻击）。
 */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":")
  if (!salt || !hash) return false
  const check = crypto.scryptSync(password, salt, 64)
  const expected = Buffer.from(hash, "hex")
  return check.length === expected.length && crypto.timingSafeEqual(check, expected)
}

// ---------- 用户增删改查 ----------

/** 统计账户总数（用于判断是否是「第一次使用」） */
export function userCount(): number {
  const row = getAuthDb()
    .prepare('SELECT COUNT(*) AS n FROM "users"')
    .get() as { n: number | bigint }
  return Number(row.n)
}

/** 按登录名查用户，找不到返回 null */
export function getUserByName(username: string): AuthUser | null {
  const row = getAuthDb()
    .prepare('SELECT "id", "username", "is_admin", "create_t" FROM "users" WHERE "username" = ?')
    .get(username) as unknown as AuthUser | undefined
  return row ?? null
}

/** 按编号查用户，找不到返回 null */
export function getUserById(id: number): AuthUser | null {
  const row = getAuthDb()
    .prepare('SELECT "id", "username", "is_admin", "create_t" FROM "users" WHERE "id" = ?')
    .get(id) as unknown as AuthUser | undefined
  return row ?? null
}

/** 列出全部用户（管理员的用户管理页使用） */
export function listUsers(): AuthUser[] {
  return getAuthDb()
    .prepare('SELECT "id", "username", "is_admin", "create_t" FROM "users" ORDER BY "id"')
    .all() as unknown as AuthUser[]
}

/** 按登录名取密码哈希（登录校验、修改密码校验原密码时使用） */
export function getPasswordHash(username: string): string | null {
  const row = getAuthDb()
    .prepare('SELECT "password_hash" FROM "users" WHERE "username" = ?')
    .get(username) as { password_hash: string } | undefined
  return row?.password_hash ?? null
}

/**
 * 创建新用户。
 * 作用：注册 / 管理员添加账号时调用。密码只保存哈希。
 */
export function createUser(username: string, password: string, isAdmin: boolean): AuthUser {
  const result = getAuthDb()
    .prepare('INSERT INTO "users" ("username", "password_hash", "is_admin", "create_t") VALUES (?, ?, ?, ?)')
    .run(username, hashPassword(password), isAdmin ? 1 : 0, nowString())
  console.log(`[账户] 创建用户「${username}」，管理员=${isAdmin ? "是" : "否"}`)
  return getUserById(Number(result.lastInsertRowid))!
}

/**
 * 修改用户账号信息（登录名 和/或 密码）。
 * 作用：管理员在用户管理页修改任何人的账号；登录名变更时，
 * 同步把该用户已有会话里的用户名也改掉，保持登录不掉线。
 * 返回是否修改成功（用户不存在时为 false）。
 */
export function updateUser(
  id: number,
  changes: { username?: string; password?: string },
): boolean {
  const db = getAuthDb()
  const user = getUserById(id)
  if (!user) return false
  if (changes.username && changes.username !== user.username) {
    db.prepare('UPDATE "users" SET "username" = ? WHERE "id" = ?').run(changes.username, id)
    // 同步会话里的用户名，避免改名后旧会话失效
    db.prepare('UPDATE "sessions" SET "username" = ? WHERE "username" = ?').run(
      changes.username,
      user.username,
    )
    console.log(`[账户] 用户「${user.username}」登录名改为「${changes.username}」`)
  }
  if (changes.password) {
    db.prepare('UPDATE "users" SET "password_hash" = ? WHERE "id" = ?').run(
      hashPassword(changes.password),
      id,
    )
    console.log(`[账户] 用户「${changes.username || user.username}」密码已更新`)
  }
  return true
}

/** 校验「登录名 + 密码」，成功返回用户，失败返回 null */
export function verifyUser(username: string, password: string): AuthUser | null {
  const stored = getPasswordHash(username)
  if (!stored) return null
  if (!verifyPassword(password, stored)) return null
  return getUserByName(username)
}

// ---------- 会话（登录状态） ----------

/** 会话有效期：7 天（秒） */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7

/**
 * 创建会话并返回 token。
 * 作用：登录成功后调用；token 会写进浏览器 Cookie。
 */
export function createSession(username: string): string {
  const token = crypto.randomBytes(32).toString("hex")
  getAuthDb()
    .prepare('INSERT INTO "sessions" ("token", "username", "create_t") VALUES (?, ?, ?)')
    .run(token, username, nowString())
  return token
}

/** 根据 token 查当前登录用户；token 无效或用户已被删除时返回 null */
export function getUserByToken(token: string): AuthUser | null {
  if (!token) return null
  const row = getAuthDb()
    .prepare('SELECT "username" FROM "sessions" WHERE "token" = ?')
    .get(token) as { username: string } | undefined
  if (!row) return null
  return getUserByName(row.username)
}

/** 删除会话（退出登录时调用） */
export function deleteSession(token: string): void {
  if (!token) return
  getAuthDb().prepare('DELETE FROM "sessions" WHERE "token" = ?').run(token)
}

/**
 * 生成写 Cookie 用的 Set-Cookie 字符串。
 * 作用：HttpOnly 保证前端脚本读不到 token，更安全。
 * maxAge 传 0 表示清除 Cookie（退出登录）。
 */
export function sessionCookie(token: string, maxAge: number = SESSION_MAX_AGE): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
}

/** 从请求头的 Cookie 里取出 token */
export function getTokenFromRequest(request: Request): string {
  const raw = request.headers.get("cookie") || ""
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=")
    if (k === SESSION_COOKIE) return rest.join("=")
  }
  return ""
}

/**
 * API 路由用：取当前登录用户。
 * 作用：所有需要登录的 API 第一步都调用它；返回 null 表示未登录。
 */
export function getRequestUser(request: Request): AuthUser | null {
  return getUserByToken(getTokenFromRequest(request))
}

/**
 * 服务端页面用：取当前登录用户（内部读取 Next.js 的 cookies()）。
 * 作用：页面渲染前判断是否已登录，未登录就跳转到 /login。
 */
export async function getPageUser(): Promise<AuthUser | null> {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value || ""
  return getUserByToken(token)
}

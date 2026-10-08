// ============================================================
// API 公共工具文件
// 作用：存放所有 API 路由共用的小工具函数：
// 校验表名是否合法存在、统一错误返回格式等，避免每个路由重复写。
// ============================================================

import { sanitizeTableName, tableExists } from "@/lib/db"
import type { AuthUser } from "@/lib/auth"

/**
 * 解析「数据所属用户」。
 * 作用：管理员可以通过 user 参数查看/操作任何用户的数据；
 * 普通用户只能操作自己的数据（传了别人的用户名直接拒绝）。
 * 未传或传的就是自己时，返回请求者自己的用户名。
 */
export function resolveDataOwner(
  requestUser: AuthUser,
  requested?: string | null,
): { ok: true; owner: string } | { ok: false; error: string } {
  const target = String(requested || "").trim()
  if (!target || target === requestUser.username) {
    return { ok: true, owner: requestUser.username }
  }
  if (requestUser.is_admin !== 1) {
    return { ok: false, error: "只有管理员可以查看其他用户的数据" }
  }
  return { ok: true, owner: target }
}

/**
 * 从请求参数中取出并校验表名。
 * 作用：先清洗表名，再检查该表是否存在于「当前登录用户自己的数据库」。
 * 返回 { ok: true, table } 或 { ok: false, error: 错误信息 }。
 */
export function resolveTable(
  searchParams: URLSearchParams,
  username: string,
): { ok: true; table: string } | { ok: false; error: string } {
  const raw = searchParams.get("table") || ""
  if (!raw) return { ok: false, error: "缺少参数 table（表名）" }
  const table = sanitizeTableName(raw)
  if (!tableExists(username, table)) {
    return { ok: false, error: `数据表「${table}」不存在，请先在列表页选择并导入 xlsx 文件` }
  }
  return { ok: true, table }
}

/**
 * 统一的错误返回。
 * 作用：所有 API 出错时都返回 { ok:false, error } 结构，前端好统一处理。
 */
export function errorResponse(message: string, status = 400) {
  return Response.json({ ok: false, error: message }, { status })
}

/**
 * 校验前端传来的文件名是否安全。
 * 作用：防止文件名里夹带路径符号（../ 或 \）访问到别的目录。
 * 只允许「普通文件名.xlsx」这种形式。
 */
export function isSafeFileName(fileName: string): boolean {
  return (
    !!fileName &&
    !fileName.includes("/") &&
    !fileName.includes("\\") &&
    !fileName.includes("..") &&
    fileName.toLowerCase().endsWith(".xlsx")
  )
}

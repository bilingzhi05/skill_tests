// ============================================================
// API：POST /api/import
// 作用：接收前端选中的 xlsx 文件名，执行「查表 → 缺则导入」：
// 当前用户数据库中已有同名表就直接复用；没有就解析 xlsx 建表导入。
// 文件只从「当前登录用户自己的文件夹」读取，表建在用户自己的库里。
// 请求体：{ fileName: "xxx.xlsx" }
// 返回：{ ok, table, rowCount, fromCache, skipped }
// ============================================================

import path from "path"
import { userDataDir } from "@/lib/config"
import { getRequestUser } from "@/lib/auth"
import { sanitizeTableName } from "@/lib/db"
import { importXlsx } from "@/lib/xlsx-import"
import { errorResponse, isSafeFileName, resolveDataOwner } from "@/lib/api-utils"

export async function POST(request: Request) {
  try {
    // 1. 登录校验：未登录直接拒绝
    const user = getRequestUser(request)
    if (!user) return errorResponse("请先登录", 401)

    // 2. 解析请求体（网络传输的 JSON 可能损坏，这里做异常保护）
    let body: { fileName?: string; user?: string }
    try {
      body = await request.json()
    } catch {
      return errorResponse("请求体不是合法的 JSON")
    }
    const fileName = String(body.fileName || "")
    // 管理员可指定 user 为其他用户导入；普通用户只能给自己导入
    const ownerResolved = resolveDataOwner(user, body.user)
    if (!ownerResolved.ok) return errorResponse(ownerResolved.error, 403)
    const owner = ownerResolved.owner
    console.log(`[API import] 请求者「${user.username}」为用户「${owner}」导入, fileName =`, fileName)

    // 3. 文件名校验（防止路径穿越）
    if (!isSafeFileName(fileName)) {
      return errorResponse(`文件名不合法：${fileName}`)
    }

    // 4. 表名 = 文件名去掉 .xlsx 后缀，再清洗特殊字符
    const tableName = sanitizeTableName(fileName.replace(/\.xlsx$/i, ""))

    // 5. 执行导入（读数据所属用户文件夹里的文件，写入该用户自己的库）
    const result = importXlsx(path.join(userDataDir(owner), fileName), tableName, owner)
    console.log("[API import] 导入完成:", result)
    return Response.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : "导入失败，请查看服务端日志"
    console.error("[API import] 导入失败:", err)
    return errorResponse(message, 500)
  }
}

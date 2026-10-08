// ============================================================
// API：GET /api/files
// 作用：扫描数据目录（user_data/<登录名>/），返回其中所有
// xlsx 文件名列表，供列表页左侧下拉菜单展示。
// 默认扫描当前登录用户自己的文件夹；管理员可通过 ?user=xxx
// 查看任意用户的文件夹。文件夹不存在时自动创建。
// 管理员访问时额外返回 users（全部注册用户名），供切换下拉使用。
// ============================================================

import fs from "fs"
import { userDataDir } from "@/lib/config"
import { getRequestUser, listUsers } from "@/lib/auth"
import { errorResponse, resolveDataOwner } from "@/lib/api-utils"

export async function GET(request: Request) {
  try {
    // 1. 登录校验：未登录直接拒绝
    const user = getRequestUser(request)
    if (!user) return errorResponse("请先登录", 401)

    // 2. 解析数据所属用户（非管理员只能看自己的）
    const sp = new URL(request.url).searchParams
    const ownerResolved = resolveDataOwner(user, sp.get("user"))
    if (!ownerResolved.ok) return errorResponse(ownerResolved.error, 403)
    const owner = ownerResolved.owner

    // 3. 扫描该用户的数据文件夹
    const dir = userDataDir(owner)
    // 文件夹不存在时自动创建（新用户第一次打开页面）
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      console.log(`[API files] 用户「${owner}」的数据目录不存在，已自动创建:`, dir)
    }
    // 4. 读取目录，只保留 .xlsx 文件（忽略临时文件 ~$ 开头和数据库文件）
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".xlsx") && !f.startsWith("~$"))
      .sort()
    console.log(
      `[API files] 请求者「${user.username}」扫描用户「${owner}」目录 ${dir}，找到 ${files.length} 个 xlsx 文件`,
    )
    // 管理员额外拿到全部用户名，用于列表页的「数据所属用户」下拉
    const users = user.is_admin === 1 ? listUsers().map((u) => u.username) : undefined
    return Response.json({ ok: true, files, dir, owner, users })
  } catch (err) {
    console.error("[API files] 扫描目录失败:", err)
    return Response.json({ ok: false, error: "扫描数据目录失败，请查看服务端日志" }, { status: 500 })
  }
}

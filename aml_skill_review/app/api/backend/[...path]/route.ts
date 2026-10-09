// ============================================================
// 统一后端代理：/api/backend/* → FastAPI (127.0.0.1:1238)/api/backend/*
//
// 浏览器只访问 Next.js（沿用现有 Cookie 登录），本路由负责：
//   1. 校验登录，取出 username / is_admin；
//   2. 注入内部头 X-INTERNAL-TOKEN / X-USER / X-IS-ADMIN；
//   3. 透传 query、JSON、multipart（zip 上传）和二进制下载；
//   4. 把 FastAPI 的 {detail} 错误归一为前端约定的 {ok:false,error}。
//
// FastAPI 只监听 127.0.0.1，不直接对浏览器暴露。
// ============================================================

import { getRequestUser } from "@/lib/auth"
import { errorResponse } from "@/lib/api-utils"
import { SKILL_API_BASE, getBackendToken } from "@/lib/config"

type ProxyCtx = { params: Promise<{ path: string[] }> }

/** 核心转发函数 */
async function proxy(request: Request, segments: string[]): Promise<Response> {
  // 1. 登录校验
  const user = getRequestUser(request)
  if (!user) return errorResponse("未登录", 401)

  // 2. 拼接目标 URL（保留 query string）
  const reqUrl = new URL(request.url)
  const target =
    `${SKILL_API_BASE}/api/backend/${segments.join("/")}` +
    (reqUrl.search ? `?${reqUrl.searchParams.toString()}` : "")

  // 3. 组装转发头
  const headers = new Headers()
  headers.set("X-INTERNAL-TOKEN", getBackendToken())
  headers.set("X-USER", user.username)
  headers.set("X-IS-ADMIN", String(user.is_admin))

  // 4. 透传请求体（multipart 重建 FormData；JSON/文本原样转发）
  const init: RequestInit = { method: request.method, headers }
  const contentType = request.headers.get("content-type") || ""
  if (!["GET", "HEAD"].includes(request.method) && contentType) {
    if (contentType.includes("multipart/form-data")) {
      init.body = await request.formData()
    } else {
      const text = await request.text()
      headers.set("content-type", contentType)
      init.body = text
    }
  }

  // 5. 请求后端（服务未启动时给用户明确提示）
  let res: Response
  try {
    res = await fetch(target, init)
  } catch {
    return errorResponse(
      "任务后端不可用，请先启动 FastAPI 服务（process_skills/start_backend_server.bat，端口 1238）",
      502,
    )
  }

  // 6. JSON 响应：错误时把 {detail} 归一为 {ok:false,error}
  const resType = res.headers.get("content-type") || ""
  if (resType.includes("application/json")) {
    const data = await res.json()
    if (!res.ok && data && typeof data === "object" && "detail" in data) {
      return Response.json(
        { ok: false, error: String((data as { detail: unknown }).detail) },
        { status: res.status },
      )
    }
    return Response.json(data, { status: res.status })
  }

  // 7. 二进制响应（日志/xlsx 下载）：透传内容和下载文件名
  const buf = await res.arrayBuffer()
  const outHeaders = new Headers()
  const disposition = res.headers.get("content-disposition")
  if (disposition) outHeaders.set("content-disposition", disposition)
  outHeaders.set("content-type", resType || "application/octet-stream")
  return new Response(buf, { status: res.status, headers: outHeaders })
}

export async function GET(request: Request, ctx: ProxyCtx) {
  const { path } = await ctx.params
  return proxy(request, path)
}

export async function POST(request: Request, ctx: ProxyCtx) {
  const { path } = await ctx.params
  return proxy(request, path)
}

export async function PUT(request: Request, ctx: ProxyCtx) {
  const { path } = await ctx.params
  return proxy(request, path)
}

export async function DELETE(request: Request, ctx: ProxyCtx) {
  const { path } = await ctx.params
  return proxy(request, path)
}

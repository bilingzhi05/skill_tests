// ============================================================
// LDAP 认证桥接文件
// 作用：把「登录名 + 密码」交给 FastAPI 后端（process_skills/server/ldap_auth.py）
// 做 LDAP bind 校验。密码只在本次请求中使用，不落库、不写日志。
// 若后端未配置 LDAP（LDAP_SERVER 为空）或后端不可用，返回 enabled=false，
// 登录路由据此回退到本地密码校验。
// ============================================================

import { SKILL_API_BASE, getBackendToken } from "@/lib/config"

/** LDAP 校验结果：enabled=后端是否配置了 LDAP；authenticated=本次是否通过 */
export type LdapResult = {
  enabled: boolean
  authenticated: boolean
}

const LDAP_DISABLED: LdapResult = { enabled: false, authenticated: false }

/**
 * 调用后端做 LDAP 校验。
 * 作用：登录流程的「LDAP 优先」步骤；任何异常（后端未启动 / 未配置 LDAP）
 * 都按「未启用」处理，返回 { enabled:false, authenticated:false }。
 */
export async function ldapVerify(username: string, password: string): Promise<LdapResult> {
  try {
    const res = await fetch(`${SKILL_API_BASE}/api/backend/auth/ldap/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-INTERNAL-TOKEN": getBackendToken(),
      },
      body: JSON.stringify({ username, password }),
      cache: "no-store",
    })
    if (!res.ok) {
      console.warn(`[LDAP] 后端返回 ${res.status}，跳过 LDAP 校验`)
      return LDAP_DISABLED
    }
    const data = (await res.json()) as { enabled?: boolean; authenticated?: boolean }
    return { enabled: !!data.enabled, authenticated: !!data.authenticated }
  } catch (err) {
    // 后端不可用：登录不受影响，回退本地密码校验
    console.warn("[LDAP] 后端不可用，跳过 LDAP 校验:", err)
    return LDAP_DISABLED
  }
}

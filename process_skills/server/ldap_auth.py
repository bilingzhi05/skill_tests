# -*- coding: utf-8 -*-
"""LDAP 认证模块（迁移自 pmlist_niko_labeller/dashboard 的 ldap_auth.py）。

登录时通过 LDAPS 绑定验证用户身份：
  1. 用服务账号（LDAP_BIND_DN）绑定，搜索用户 DN；
  2. 用「用户 DN + 密码」再次绑定验证。

密码仅在本次 bind 中即时使用，**绝不落库、不写日志**。

配置全部来自环境变量（或 skill_tests/.env），键名见本文件 `_cfg_*` 函数调用处。
FastAPI 侧通过 `/api/backend/auth/ldap/verify` 暴露给 Next.js 登录流程调用。
"""
from __future__ import annotations

import logging
import os
import ssl
from typing import Optional

from . import config

# 进程环境变量优先，缺失的键从 skill_tests/.env 兜底加载（LDAP_* 配在这里）
config.load_env_file()

logger = logging.getLogger(__name__)


def _get_ldap3():
    """Lazy import ldap3，便于未安装时模块仍可导入。"""
    import ldap3

    return ldap3


def _cfg_str(key: str, default: str = "") -> str:
    return (os.environ.get(key) or default).strip()


def _cfg_int(key: str, default: int) -> int:
    try:
        return int((os.environ.get(key) or "").strip() or default)
    except (TypeError, ValueError):
        return default


def _cfg_bool(key: str, default: bool) -> bool:
    val = (os.environ.get(key) or "").strip().lower()
    if not val:
        return default
    return val in ("1", "true", "yes", "on", "y")


def is_ldap_enabled() -> bool:
    """LDAP 是否已配置（LDAP_SERVER 非空）。"""
    return bool(_cfg_str("LDAP_SERVER"))


def _get_server(*, verify_ssl: Optional[bool] = None):
    """创建 LDAP Server 对象（未配置时返回 None）。"""
    if not is_ldap_enabled():
        return None
    ldap3 = _get_ldap3()
    use_ssl = _cfg_bool("LDAP_USE_SSL", True)
    verify = _cfg_bool("LDAP_VERIFY_SSL", True) if verify_ssl is None else verify_ssl
    tls = None
    if use_ssl and not verify:
        tls = ldap3.Tls(validate=ssl.CERT_NONE)
    return ldap3.Server(
        _cfg_str("LDAP_SERVER"),
        port=_cfg_int("LDAP_PORT", 636),
        use_ssl=use_ssl,
        get_info=ldap3.NONE,
        connect_timeout=_cfg_int("LDAP_CONNECT_TIMEOUT", 10),
        tls=tls,
    )


def _get_search_scope():
    ldap3 = _get_ldap3()
    scope = _cfg_str("LDAP_SEARCH_SCOPE", "SUBTREE").upper()
    return {
        "BASE": ldap3.BASE,
        "ONELEVEL": ldap3.LEVEL,
        "SUBTREE": ldap3.SUBTREE,
    }.get(scope, ldap3.SUBTREE)


def authenticate_via_ldap(username: str, password: str) -> bool:
    """通过 LDAP 绑定验证用户身份；成功返回 True，失败/异常返回 False。

    密码不做任何持久化、不写日志。
    """
    if not is_ldap_enabled():
        return False
    if not username or not password:
        return False

    try:
        ldap3 = _get_ldap3()
    except ImportError:
        logger.warning("ldap3 not installed, LDAP authentication unavailable")
        return False

    try:
        service_server = _get_server(verify_ssl=False)
        if service_server is None:
            return False
        service_conn = ldap3.Connection(
            service_server,
            user=_cfg_str("LDAP_BIND_DN"),
            password=_cfg_str("LDAP_BIND_PASSWORD"),
            receive_timeout=_cfg_int("LDAP_CONNECT_TIMEOUT", 10),
        )
        if not service_conn.bind():
            logger.warning("LDAP service account bind failed")
            return False

        search_filter = _cfg_str("LDAP_USER_SEARCH_FILTER", "(sAMAccountName={username})").replace(
            "{username}", ldap3.utils.conv.escape_filter_chars(username)
        )
        service_conn.search(
            search_base=_cfg_str("LDAP_BASE_DN"),
            search_filter=search_filter,
            search_scope=_get_search_scope(),
            attributes=[ldap3.ALL_ATTRIBUTES],
            size_limit=2,
        )

        if len(service_conn.entries) == 0:
            logger.info("LDAP user not found: %s", username)
            service_conn.unbind()
            return False
        if len(service_conn.entries) > 1:
            logger.warning(
                "LDAP search returned %d results for %s, using first",
                len(service_conn.entries),
                username,
            )

        entry = service_conn.entries[0]
        user_dn = entry.entry_dn

        display_name_attr = _cfg_str("LDAP_DISPLAY_NAME_ATTR", "displayName")
        email_attr = _cfg_str("LDAP_EMAIL_ATTR", "mail")
        ldap_display_name = None
        ldap_email = None
        if hasattr(entry, display_name_attr):
            val = getattr(entry, display_name_attr)
            if val:
                ldap_display_name = str(val.value) if hasattr(val, "value") else str(val)
        if hasattr(entry, email_attr):
            val = getattr(entry, email_attr)
            if val:
                ldap_email = str(val.value) if hasattr(val, "value") else str(val)

        service_conn.unbind()

        user_server = _get_server(verify_ssl=False)
        if user_server is None:
            return False
        user_conn = ldap3.Connection(
            user_server,
            user=user_dn,
            password=password,
            receive_timeout=_cfg_int("LDAP_CONNECT_TIMEOUT", 10),
        )
        bind_ok = user_conn.bind()
        user_conn.unbind()

        if not bind_ok:
            logger.info("LDAP bind failed for user: %s", username)
            return False

        logger.info(
            "LDAP authentication succeeded: %s%s",
            username,
            f" ({ldap_display_name or ldap_email})" if (ldap_display_name or ldap_email) else "",
        )
        return True

    except ldap3.core.exceptions.LDAPSocketOpenError:
        logger.warning("LDAP server unreachable: %s", _cfg_str("LDAP_SERVER"))
        return False
    except ldap3.core.exceptions.LDAPBindError as e:
        logger.warning("LDAP bind error: %s", e)
        return False
    except ldap3.core.exceptions.LDAPException as e:
        logger.warning("LDAP error: %s", e)
        return False
    except Exception as e:  # noqa: BLE001 - 任何异常都视为认证失败，不影响本地兜底
        logger.warning("LDAP auth unexpected error: %s", e)
        return False

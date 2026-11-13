#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BossClaw 隐身引擎 —— 本地 Python 桥服务（仅 Camoufox 原生隐身内核）
============================================================
为 Boss-claw 桌面版提供隐身采集 / 投递能力。**只用 Camoufox 隐身引擎**：
实测 BOSS 会对 Playwright 驱动的系统 Chrome/Edge 返回空壳页（约 39 字节空 HTML），
因此**本地浏览器内核不能复用**，必须使用 `camoufox fetch` 下载的原生内核
（C++ 级指纹伪装 + humanize，可正常加载 BOSS 并完成登录/沟通）。

  - 引擎：Camoufox 原生内核（需先 `pip install "camoufox[geoip]" && camoufox fetch`）
  - 未装内核 → /status 返回 not ready，前端提示安装隐身引擎内核

能力（对齐 boss-auto-job-main）：
  - /status  检测可用内核与引擎状态
  - /search  隐身搜索（humanize/stealth，自动处理 code 37 环境检查）
  - /send    隐身发送招呼语（friend/add.json API + 页面真实点击兜底）
  - /login   打开可见窗口扫码登录，Cookie 持久化到 ~/.bossclaw/camoufox-cookies.json

安全边界（与 Boss-claw AGENTS.md 一致）：
  - code 36/32 立即返回风险信号，绝不重试、绝不绕过
  - 只降低「正常操作被误判为机器人（code 37）」的概率，不绕过验证码 / 账户验证
  - 招呼语非空校验；发送间隔由渲染层限速器控制

协议：HTTP + token（默认 127.0.0.1:18767）
用法：python camoufox_server.py [--port 18767] [--token xxx]
"""

import argparse
import hmac
import json
import os
import re
import sys
import time
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, urlencode

# ===== 平台公共基座（浏览器 / 人类化 / Cookie 按平台持久化）=====
# BOSS 之外的平台（猎聘/智联/51Job）在 platforms/ 包内实现，复用本基座
from platforms.common import (
    log, human_delay, human_sleep, type_greeting_human, normalize_pace,
    open_browser, goto_stable, load_cookies, save_cookies, clear_cookies, clear_session,
    load_identity, cookie_file, detect_kernel, PLATFORMS,
)
import platforms as platform_mods
# BOSS 隐身通道的「基础求职条件」翻译层（issue #7 第五节）：
# 与 platform_mods 内部同一份实现，码值口径与 src/lib/bossclaw/searchUrl.ts 逐字一致。
from platforms.filters import build_filter_params, summarize_applied

# ============================================================
# BOSS 直聘专用风控文案与外部网申检测（聊天投递链路用）
# ============================================================
VERSION = '2.2.0'


# ============================================================
# 单次搜索页数上限（issue #7 P2）
# ============================================================
# 历史实现把上限硬编码成 min(5)，用户改配置/改前端都突破不了 5 页，
# 而「多翻几页才能捞到标题偏离关键词的岗位」是真实需求（issue #7）。
# 现在改成「默认常量 + 环境变量 BOSSCLAW_MAX_SEARCH_PAGES 覆盖」。
#
# 上限本身仍然保留：每页约 30 条，单页之间有多秒类人节奏延迟，无节制翻页会
# 显著抬高风控暴露面（更快命中 code 36/32/35），所以不是「越大越好」。
# 前端 Settings 的输入框上限与此处同源（camoufox.ts 的 CAMOUFOX_MAX_PAGES），改动需同步。
DEFAULT_MAX_SEARCH_PAGES = 10
HARD_MAX_SEARCH_PAGES = 20


def max_search_pages() -> int:
    """单次搜索页数上限（环境变量优先，夹在 1~20，非法值回落默认 10）。"""
    try:
        value = int(os.environ.get('BOSSCLAW_MAX_SEARCH_PAGES') or DEFAULT_MAX_SEARCH_PAGES)
    except (TypeError, ValueError):
        value = DEFAULT_MAX_SEARCH_PAGES
    return max(1, min(value, HARD_MAX_SEARCH_PAGES))


def clamp_pages(raw) -> int:
    """把请求里的 pages 归一化到 `[1, max_search_pages()]`（bool / 字符串 / 负数都兜住）。"""
    try:
        pages = int(raw or 1)
    except (TypeError, ValueError):
        pages = 1
    return max(1, min(pages, max_search_pages()))



# ============================================================
# 搜索（对齐 search_camoufox.py：joblist API + code 37 自动处理）
# ============================================================
def boss_search_params(query: str, city: str, page_num: int, filters: dict | None = None) -> dict:
    """BOSS 列表页 URL 与 joblist 接口共用的查询参数。

    筛选参数必须**同时**出现在列表页与接口请求里：只筛页面会出现「页面显示本科、
    抓回来却是全学历」；只筛接口则页面翻页时平台可能按未筛选条件重排（issue #7 第五节）。
    """
    return {'query': query, 'city': city, 'page': int(page_num), **(filters or {})}


def boss_api_params(query: str, city: str, page_num: int, filters: dict | None = None) -> dict:
    """joblist.json 参数 = 搜索参数 + 接口固定参数（scene / pageSize）。"""
    params = boss_search_params(query, city, page_num, filters)
    params['scene'] = 1
    params['pageSize'] = 30
    return params


def search_jobs(query: str, city: str, pages: int = 1, os_name: str | None = None,
                criteria: dict | None = None, pace: float = 1.0) -> dict:
    """BOSS 隐身搜索：逐页请求 joblist.json。

    `criteria` = 设置页「基础求职条件」，由 `platforms.filters` 翻译成 BOSS 的
    `jobType / experience / degree / salary / scale`（码值与 `searchUrl.ts` 逐字一致）。

    `pace` = 设置页「采集速度」倍率（1~3），放大列表页加载后的等待与翻页间隔；
    安全检查 / 1006 限速等固定等待不随倍率变化。

    历史缺陷（issue #7 第五节）：本函数原先只拼 query / city / page，criteria 被完全忽略，
    导致隐身通道采回来的是**未过滤**结果 —— 同一份设置在内置浏览器通道生效、隐身通道不生效。
    """
    pace = normalize_pace(pace)
    boss_filters = build_filter_params('boss', criteria)
    applied = summarize_applied('boss', boss_filters)
    log('🔍', f'搜索：{query} / city={city} / pages={pages} / 速度 {pace:g}×'
             + (f' / 已应用：{applied}' if applied else ' / 未设置筛选条件'))
    all_jobs = []
    last_code = None
    last_msg = ''

    with open_browser(os_name=os_name, platform='boss') as page:
        cookies = load_cookies()
        for page_num in range(1, pages + 1):
            try:
                if cookies:
                    try:
                        page.context.add_cookies(cookies)
                    except Exception as e:
                        log('⚠️', f'注入 Cookie 失败：{e}')

                # 列表页 URL 与接口共用同一份参数（筛选在两处都必须带，否则页面与数据不一致）
                url = f"https://www.zhipin.com/web/geek/job?{urlencode(boss_search_params(query, city, page_num, boss_filters))}"
                log('📄', f'Page {page_num}: {url}')

                # BOSS 页面有持续轮询脚本（warlock/patas 心跳），networkidle 不可靠 → domcontentloaded
                resp = page.goto(url, wait_until="domcontentloaded", timeout=30000)
                # 等待页面稳定：跳过可能的 JS challenge / 安全检查跳转（参考 SKILL.md：
                # evaluate 时若页面仍在导航会抛 Execution context was destroyed，需等稳定后重试）
                human_sleep(4.5 * pace, 0.35, 2.5 * pace)
                try:
                    page.wait_for_function("() => document.body && document.body.innerText.length > 0", timeout=15000)
                except Exception:
                    pass
                human_sleep(0.8, 0.4, 0.4)
                current_url = page.url
                log('🔗', f'URL: {current_url[:110]} (status={resp.status if resp else "?"})')

                if "security-check" in current_url:
                    log('⚠️', '触发安全检查页，等待自动处理…')
                    human_sleep(7.5, 0.3, 5.0)
                    current_url = page.url
                    if "security-check" in current_url:
                        log('❌', '仍停留在安全检查页')
                        last_code, last_msg = 37, 'security-check 未自动通过'
                        break
                if "verify" in current_url:
                    log('❌', '命中验证页（需人工）')
                    last_code, last_msg = 35, 'verify page'
                    break
                if "403" in current_url:
                    log('❌', '403 禁止访问')
                    last_code, last_msg = 403, '403 forbidden'
                    break

                # 调用岗位列表 API（DOM 是 canvas 渲染，无法抓取）。
                # evaluate 可能因页面持续导航抛 Execution context destroyed，重试最多 3 次。
                # B2（转义正确性）：参数走 evaluate 传参 + URLSearchParams，禁止 f-string 拼 JS/URL。
                # issue #7 第五节：接口必须带上与列表页相同的筛选参数，否则筛了页面不筛数据。
                api_params = boss_api_params(query, city, page_num, boss_filters)
                api_result = None
                for attempt in range(3):
                    try:
                        api_result = page.evaluate(
                            "({p}) => fetch('/wapi/zpgeek/search/joblist.json?' + new URLSearchParams(p).toString()).then(r => r.json()).catch(e => ({error: e.message}))",
                            {"p": api_params},
                        )
                        break
                    except Exception as e:
                        log('⚠️', f'evaluate 第 {attempt + 1} 次失败：{str(e)[:60]}，等待 2s 重试…')
                        time.sleep(2)
                if api_result is None:
                    log('❌', 'API evaluate 重试耗尽')
                    break
                # H-7：fetch 的 .catch(e => ({error: e.message})) 只回 {error}，无 code；
                # 原实现 code=None → 收口 `last_code not in (0, None)` 判为「成功但 0 岗位」，
                # 下游无法区分「确实为空」与「抓取失败」。这里显式置失败码 37。
                if isinstance(api_result, dict) and api_result.get('error') and api_result.get('code') is None:
                    last_code, last_msg = 37, f'接口请求失败：{str(api_result.get("error"))[:80]}'
                    log('❌', last_msg)
                    break
                code = api_result.get('code')
                msg = api_result.get('message', '')
                log('🧾', f'API code={code} msg={str(msg)[:40]}')
                last_code, last_msg = code, msg
                # H-7：响应结构异常（有响应但既无 code 也无 error）→ 同样 fail-safe 上报失败，
                # 不再当成「成功但 0 岗位」。
                if code is None:
                    last_code, last_msg = 37, '接口返回缺少 code（响应结构可能已变更）'
                    log('❌', last_msg)
                    break

                if code == 0:
                    jobs = api_result.get('zpData', {}).get('jobList', [])
                    log('✅', f'Page {page_num}: {len(jobs)} 个岗位')
                    all_jobs.extend(jobs)
                elif code == 37:
                    # 环境检查：自动访问 security-check 生成 zp_stoken 后重试一次
                    zp = api_result.get('zpData', {})
                    seed, name, ts = zp.get('seed', ''), zp.get('name', ''), zp.get('ts', '')
                    if seed and name:
                        sec_url = (f"https://www.zhipin.com/web/common/security-check.html"
                                   f"?seed={seed}&name={name}&ts={ts}"
                                   f"&callbackUrl=%2Fweb%2Fgeek%2Fjob%3Fquery%3D{query}%26city%3D{city}%26page%3D{page_num}")
                        page.goto(sec_url, wait_until="domcontentloaded", timeout=20000)
                        time.sleep(8)
                        if "security-check" not in page.url:
                            retry = page.evaluate(
                                "({p}) => fetch('/wapi/zpgeek/search/joblist.json?' + new URLSearchParams(p).toString()).then(r => r.json())",
                                {"p": api_params},
                            )
                            if retry.get('code') == 0:
                                jobs = retry.get('zpData', {}).get('jobList', [])
                                log('✅', f'zp_stoken 后重试：{len(jobs)} 个岗位')
                                all_jobs.extend(jobs)
                                last_code = 0
                            else:
                                log('❌', f'重试失败：code={retry.get("code")}')
                                last_code, last_msg = retry.get('code'), retry.get('message', '')
                        else:
                            log('❌', 'security-check 未通过')
                    else:
                        log('❌', '缺少 seed/name/ts，无法自动处理')
                        last_code, last_msg = 37, 'missing seed/name/ts'
                elif code in (36, 32):
                    log('🚫', f'Code {code}：{msg} — 立即停止')
                    break
                elif code in (35, 37, 38):
                    # 35 需人工验证 / 37 环境检查 / 38 环境异常未登录 —— 透传给渲染层分类处理
                    log('⚠️', f'Code {code}：{msg} — 透传渲染层')
                    break
                elif code == 1006:
                    log('⏳', 'Code 1006 限速，等待 10s…')
                    time.sleep(10)
                elif code == 17:
                    log('⚠️', 'Code 17 未登录，搜索受限')
                    break
                else:
                    log('❌', f'Code {code}: {msg}')
                    break
            except Exception as e:
                log('❌', f'搜索异常：{e}')
                break
            if page_num < pages:
                delay = (3 + (page_num % 3)) * pace
                log('⏳', f'等待约 {delay:g}s 再取下一页…')
                human_sleep(delay, 0.4, 1.5 * pace)

    # 保存会话 Cookie（登录态可能已在访问中刷新）
    try:
        # context 已随 with 关闭，Cookie 由后续 login/send 保存；此处仅记录
        pass
    except Exception:
        pass

    # 失败码收口：仅「显式成功」（code=0，或整批一页未跑且无失败码）才算成功。
    # 未列入已知风险码的码值一律 fail-safe 上报（对齐 platforms.ts::collectFaultScope 的未知码口径：
    # 命中 queue → 整批中止交人工；403 等归属 PLATFORM_FAULT_CODES → 平台级，其余平台继续）。
    if last_code not in (0, None):
        return {"ok": False, "code": last_code, "message": last_msg or f'采集失败（code {last_code}）', "jobs": []}

    formatted = format_jobs(all_jobs)
    log('🎉', f'搜索完成：共 {len(formatted)} 个岗位')
    return {"ok": True, "code": 0, "jobs": formatted}


def _fmt_publish_time(raw) -> str:
    """把 BOSS 的发布时间字段归一成前端 priority.ts::freshnessPriority 能判级的文本。

    只做格式归一，不做业务猜测；无法解析一律返回 ''（与「未识别」同义，不参与排序加权）。
    兼容 BOSS joblist 的 lastModifyTime（毫秒时间戳）/ lastModifyTimeStr（文本）/ publishTime。
    """
    s = str(raw or '').strip()
    if not s:
        return ''
    # 已是文本形态（如「3日内更新」「今天」）→ 原样返回，交给前端正则判级
    if not s.isdigit():
        return s[:40]
    try:
        ms = int(s)
        # 秒级时间戳兼容（10 位视为秒，13 位视为毫秒）
        ts = ms / 1000.0 if ms > 10 ** 11 else float(ms)
        delta = datetime.now() - datetime.fromtimestamp(ts)
        days = delta.days
        if days < 0:
            return ''
        if days == 0:
            return '今日更新'
        if days == 1:
            return '1天前更新'
        return f'{days}天前更新'
    except Exception:
        return ''


def format_jobs(raw_jobs: list) -> list:
    """BOSS 原始岗位字段 → Boss-claw JobMeta 兼容结构。"""
    output = []
    for j in raw_jobs:
        job_id = j.get('encryptJobId') or j.get('jobId')
        if not job_id:
            continue
        output.append({
            "jobId": job_id,
            "title": j.get('jobName', ''),
            "company": j.get('brandName', ''),
            "salary": j.get('salaryDesc', ''),
            "location": f"{j.get('cityName', '')} {j.get('areaDistrict', '')}".strip(),
            "experience": j.get('jobExperience', ''),
            "degree": j.get('jobDegree', ''),
            "labels": j.get('jobLabels', []),
            "skills": j.get('skills', []),
            # 福利/工作制度标签（如「周末双休」）：日薪折算月薪的工作日基数识别来源
            "welfare": j.get('welfareList', []),
            # 岗位发布时间（僵尸岗位过滤 + 新鲜度排序的唯一数据源）。
            # 此前该字段从未透传 → TS 侧 publishTime 恒为空，priority.ts 的 freshnessPriority
            # 永远返回 0，新鲜度维度实际失效。这里统一转成前端能判级的文本。
            "publishTime": _fmt_publish_time(j.get('lastModifyTime') or j.get('lastModifyTimeStr') or j.get('publishTime')),
            "description": j.get('jobDesc', ''),
            "recruiterName": j.get('bossName', ''),
            "bossTitle": j.get('bossTitle', ''),
            "companySize": j.get('scaleName', ''),
            "companyType": j.get('typeName', ''),
            "url": f"https://www.zhipin.com/job_detail/{job_id}.html",
        })
    return output


# ============================================================
# 发送（对齐 send_camoufox.py + send_v2.py 的双通道策略）
# ============================================================
def send_greeting(job_id: str, greeting: str, os_name: str | None = None, send_resume_image: bool = False) -> dict:
    greeting = str(greeting or '').strip()
    if not greeting:
        return {"ok": False, "code": 400, "message": "招呼语为空，拒绝发送", "sent": False}
    if SERIALIZATION_ARTIFACT_RE.search(greeting):
        return {"ok": False, "code": 400, "message": "招呼语异常（[object Object] 等序列化残留），拒绝发送", "sent": False}
    # P6-06：前端权威长度口径见 greetings.ts::GREETING_MAX_CHARS（200）与 GREETING_LENGTH_RULE；
    # 此处 800 仅为服务端防御上限（拦截异常超长输入），不承担「内容长度规范」职责。
    if len(greeting) > 800:
        return {"ok": False, "code": 400, "message": "招呼语过长（>800 字），拒绝发送", "sent": False}

    log('📨', f'发送招呼语 → job={job_id}（{len(greeting)} 字）')

    with open_browser(os_name=os_name, platform='boss') as page:
        cookies = load_cookies()
        if cookies:
            try:
                page.context.add_cookies(cookies)
                log('🍪', f'注入 {len(cookies)} 条 Cookie')
            except Exception as e:
                log('⚠️', f'注入 Cookie 失败：{e}')

        # Step 1: 访问搜索页建立会话（触发 zp_stoken / 环境检查）
        page.goto("https://www.zhipin.com/web/geek/job?query=Python&city=101010100&page=1",
                  wait_until="domcontentloaded", timeout=30000)
        human_sleep(2.8, 0.3, 1.5)
        if "security-check" in page.url:
            log('⚠️', '会话页触发安全检查，等待…')
            human_sleep(7.5, 0.3, 5.0)
        if "verify" in page.url:
            log('🚫', '命中验证页，需人工')
            return {"ok": False, "code": 35, "message": "需要人工安全验证", "sent": False}

        # Step 2: 登录态检测（页面 DOM 判断 + card API 探测）
        login_ok = False
        try:
            check = page.evaluate("""
                () => !!document.querySelector('.nav-resume-box') ||
                      !!document.querySelector('[ka*="resume"]') ||
                      document.body.innerText.includes('在线简历')
            """)
            login_ok = bool(check)
        except Exception:
            login_ok = False
        if not login_ok:
            log('🔑', '未检测到登录态，尝试 card API 验证…')
            try:
                card = page.evaluate(
                    "({jid}) => fetch('/wapi/zpgeek/job/card.json?encryptJobId=' + encodeURIComponent(jid), {credentials: 'include', headers: {'X-Requested-With': 'XMLHttpRequest'}}).then(r => r.json()).catch(e => ({error: e.message}))",
                    {"jid": job_id},
                )
                if card.get('code') in (0,):
                    login_ok = True
                elif card.get('code') == 17:
                    login_ok = False
            except Exception:
                pass
        if not login_ok:
            log('🚫', '未登录：请先在设置页执行「Camoufox 扫码登录」')
            return {"ok": False, "code": 31, "message": "未登录 BOSS（Camoufox 会话），请先扫码登录", "sent": False}

        # Step 3: 获取 encryptUserId（friend/add.json 需要）
        encrypt_user_id = ''
        job_info = {}
        try:
            card = page.evaluate(
                "({jid}) => fetch('/wapi/zpgeek/job/card.json?encryptJobId=' + encodeURIComponent(jid), {credentials: 'include', headers: {'X-Requested-With': 'XMLHttpRequest'}}).then(r => r.json()).catch(e => ({error: e.message}))",
                {"jid": job_id},
            )
            if card.get('code') == 0:
                zp = card.get('zpData', {})
                encrypt_user_id = zp.get('encryptUserId', '') or ''
                job_info = {
                    "jobName": zp.get('jobName', ''), "brandName": zp.get('brandName', ''),
                    "bossName": zp.get('bossName', ''), "bossTitle": zp.get('bossTitle', ''),
                }
                log('👤', f"目标：{job_info.get('jobName')} @ {job_info.get('brandName')}（{job_info.get('bossName')}）")
        except Exception as e:
            log('⚠️', f'card API 失败：{e}')

        # Step 4: 优先走 friend/add.json API（返回 code 0 = 成功）
        if encrypt_user_id:
            try:
                # L-10：原实现把 json.dumps 用 f-string 拼进 page.evaluate 的**源码**（且另有一份
                # 未使用的 `body` 死代码）。改经 evaluate 参数传值，由 JS 侧 JSON.stringify ——
                # 既消除 U+2028/U+2029 等字符破坏 JS 字面量的风险，也去掉死代码。
                payload_body = {
                    "encryptJobId": job_id,
                    "encryptBossId": encrypt_user_id,
                    "greeting": greeting,
                }
                send_result = page.evaluate(
                    """(payload) => fetch('/wapi/zpgeek/friend/add.json', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest'},
                        body: JSON.stringify(payload)
                    }).then(r => r.json()).catch(e => ({error: e.message}))""",
                    payload_body,
                )
                code = send_result.get('code')
                log('🧾', f'friend/add.json code={code} msg={send_result.get("message", "")[:40]}')
                if code == 0:
                    save_cookies(page.context)
                    log('✅', '消息发送成功（API）')
                    return {"ok": True, "code": 0, "sent": True, "method": "api"}
                if code in (36, 32):
                    save_cookies(page.context)
                    return {"ok": False, "code": code, "message": send_result.get('message', ''), "sent": False}
                if code == 17:
                    save_cookies(page.context)
                    return {"ok": False, "code": 31, "message": "登录已失效，请重新扫码登录", "sent": False}
                if code == 37:
                    # 环境检查：走 security-check 后再试一次（对齐搜索逻辑）
                    log('⚠️', 'code 37 环境检查，尝试自动处理…')
                    zp = send_result.get('zpData', {})
                    seed, name, ts = zp.get('seed', ''), zp.get('name', ''), zp.get('ts', '')
                    if seed and name:
                        sec_url = (f"https://www.zhipin.com/web/common/security-check.html"
                                   f"?seed={seed}&name={name}&ts={ts}&callbackUrl=%2Fweb%2Fgeek%2Fjob")
                        page.goto(sec_url, wait_until="domcontentloaded", timeout=20000)
                        human_sleep(7.5, 0.3, 5.0)
                        if "security-check" not in page.url:
                            retry = page.evaluate(f"""
                                () => fetch('/wapi/zpgeek/friend/add.json', {{
                                    method: 'POST',
                                    headers: {{'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest'}},
                                    body: JSON.stringify({json.dumps({
                                        "encryptJobId": job_id,
                                        "encryptBossId": encrypt_user_id,
                                        "greeting": greeting,
                                    }, ensure_ascii=False)})
                                }}).then(r => r.json()).catch(e => ({{error: e.message}}))
                            """)
                            if retry.get('code') == 0:
                                save_cookies(page.context)
                                log('✅', '消息发送成功（API 重试）')
                                return {"ok": True, "code": 0, "sent": True, "method": "api"}
                            log('❌', f'API 重试失败：code={retry.get("code")}')
                            save_cookies(page.context)
                            if retry.get('code') in (36, 32):
                                return {"ok": False, "code": retry.get('code'), "message": retry.get('message', ''), "sent": False}
                log('⚠️', f'API 未成功（code={code}），尝试页面点击兜底…')
            except Exception as e:
                log('⚠️', f'API 发送异常：{e}')

        # Step 5: 页面点击「立即沟通」兜底（真实鼠标，最可靠）
        try:
            page.goto(f"https://www.zhipin.com/job_detail/{job_id}.html",
                      wait_until="domcontentloaded", timeout=30000)
            human_sleep(4.5, 0.35, 2.5)
            state = page.evaluate("""
                () => {
                    const all = Array.from(document.querySelectorAll('*'));
                    const liji = all.filter(el => el.textContent.trim() === '立即沟通');
                    const jixu = all.filter(el => el.textContent.trim() === '继续沟通');
                    return {state: jixu.length ? '继续沟通' : (liji.length ? '立即沟通' : 'not_found')};
                }
            """)
            log('🖱️', f'按钮状态：{state["state"]}')
            if state['state'] == '继续沟通':
                save_cookies(page.context)
                # P13（对齐 /chat 气泡确认、AGENTS 2.1）：到此仅为「已建立会话」，API 发送已失败，
                # 招呼语**文字气泡未确认**，不得计成功 → 返回非成功，交由 /chat 气泡确认路径处理。
                log('⚠️', '已建立会话但招呼语气泡未确认（API 发送未成功），不计成功')
                return {"ok": False, "code": 500, "message": "已建立会话但招呼语气泡未确认（API 发送未成功），请走自动沟通或人工补充", "sent": False}
            if state['state'] == 'not_found':
                save_cookies(page.context)
                return {"ok": False, "code": 404, "message": "未找到沟通按钮（可能岗位已下架）", "sent": False}
            page.locator("text=立即沟通").first.click(timeout=5000)
            human_sleep(4.5, 0.35, 2.5)
            final_state = page.evaluate("""
                () => {
                    const all = Array.from(document.querySelectorAll('*'));
                    const liji = all.filter(el => el.textContent.trim() === '立即沟通');
                    const jixu = all.filter(el => el.textContent.trim() === '继续沟通');
                    return {state: jixu.length ? '继续沟通' : (liji.length ? '立即沟通' : 'not_found')};
                }
            """)
            save_cookies(page.context)
            if final_state['state'] == '继续沟通':
                # P13：同样未确认招呼语气泡，不计成功
                log('⚠️', '已通过页面点击建立会话，但招呼语气泡未确认，不计成功')
                return {"ok": False, "code": 500, "message": "已建立会话但招呼语气泡未确认，请走自动沟通或人工补充招呼语", "sent": False}
            return {"ok": False, "code": 500, "message": "点击「立即沟通」后状态未变化", "sent": False}
        except Exception as e:
            save_cookies(page.context)
            return {"ok": False, "code": 500, "message": f"页面点击兜底失败：{e}", "sent": False}


# 序列化残留（渲染层把对象当文本传入时出现）：发现即拒绝发送，绝不把 "[object Object]" 发给 HR
SERIALIZATION_ARTIFACT_RE = re.compile(r'\[object [A-Za-z]+\]|^\s*(undefined|null|NaN)\s*$')


# ============================================================
# 扫码登录（打开可见窗口，等待用户扫码）——goto_stable 已移至 platforms/common.py
# ============================================================
def do_login(timeout: int = 180, os_name: str | None = None) -> dict:
    log('🔐', '打开登录窗口，请用手机 BOSS App 扫码')
    with open_browser(os_name=os_name, headless=False, platform='boss') as page:
        cookies = load_cookies()
        if cookies:
            try:
                page.context.add_cookies(cookies)
            except Exception:
                pass
        if not goto_stable(page, "https://www.zhipin.com/web/user/?ka=header-login"):
            return {"ok": False, "code": 35,
                    "message": "BOSS 未能加载出登录页（可能被反爬拦截），请重试或改用「内置浏览器」登录"}
        log('🔗', f'登录页 URL：{page.url[:120]}')

        start = time.time()
        last_count = 0
        while time.time() - start < timeout:
            current = (page.url or '').strip().lower()
            # 1) 忽略非法/空白页（about:blank、data: 等新开页初始 URL），避免误判成功
            if not current or not current.startswith('http'):
                time.sleep(2)
                continue
            # 2) 关键判断：仅当 URL 是真实 zhipin 页面、已离开登录/用户页、且不在安全验证页才算成功
            is_zhipin = 'zhipin.com' in current
            challenge = 'security-check' in current or 'verify' in current
            still_login = '/user/' in current or 'login' in current
            if is_zhipin and not still_login and not challenge:
                # 已跳离登录页（登录成功后 BOSS 会跳到工作台/首页）
                log('✅', f'URL 已跳转：{current[:80]}')
                save_cookies(page.context)
                return {"ok": True, "loggedIn": True}
            # 3) 仍在登录页等待扫码：只统计 cookie 变化，不做任何成功判定
            try:
                cookies_now = page.context.cookies()
                if len(cookies_now) != last_count:
                    last_count = len(cookies_now)
                    log('👀', f'等待扫码中…（cookies: {last_count}）')
            except Exception:
                pass
            time.sleep(2)

        log('❌', '登录超时')
        return {"ok": False, "code": 31, "message": "扫码登录超时，请重试"}


# ============================================================
# HTTP 服务
# ============================================================
def _token_ok(expected: str, given: str) -> bool:
    """L-11：常量时间令牌比较（避免时序侧信道）。长度不等也应正常返回 False。"""
    try:
        return hmac.compare_digest(str(expected or ''), str(given or ''))
    except Exception:
        return False


class CamoufoxHandler(BaseHTTPRequestHandler):
    server_version = f'BossClaw-Camoufox/{VERSION}'

    def _send(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        # L-9：Content-Length 非法（非数字 / 负数）不应抛出未捕获异常；一律按「无 body」处理
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except (TypeError, ValueError):
            return {}
        if length <= 0:
            return {}
        # 上限保护：避免恶意/异常的超大 Content-Length 让本进程按声明值阻塞读
        if length > 64 * 1024 * 1024:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode('utf-8'))
        except Exception:
            return {}

    def do_OPTIONS(self):
        self._send(200, {})

    def do_GET(self):
        parsed = urlparse(self.path)
        token = parse_qs(parsed.query).get('token', [''])[0]
        if not _token_ok(self.server.token, token):
            return self._send(403, {"ok": False, "error": "token denied"})
        if parsed.path == '/status':
            # 平台名归一化口径与 do_POST 一致（审查 #49）：原实现只 .strip() 不 .lower()，
            # 客户端传 "BOSS" / "Boss " 时 engine_status 拿不到对应注册项，静默回落到默认状态。
            platform = str(parse_qs(parsed.query).get('platform', ['boss'])[0] or 'boss').strip().lower() or 'boss'
            payload = engine_status(platform)
            return self._send(200, payload)
        return self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        token = parse_qs(parsed.query).get('token', [''])[0]
        if not _token_ok(self.server.token, token):
            return self._send(403, {"ok": False, "error": "token denied"})
        body = self._read_body()
        platform = str(body.get('platform') or 'boss').strip().lower() or 'boss'
        if platform not in PLATFORMS:
            return self._send(400, {"ok": False, "error": f"不支持的平台：{platform}"})

        try:
            if parsed.path == '/search':
                query = str(body.get('query') or '').strip()
                city = str(body.get('city') or '101010100').strip()
                # issue #7 P2：上限由 clamp_pages() 统一收口（默认 10，BOSSCLAW_MAX_SEARCH_PAGES 可覆盖）
                pages = clamp_pages(body.get('pages'))
                os_name = body.get('os') or None
                # 设置页「基础求职条件」（全平台共用）：猎聘/智联/前程无忧 由 platforms.filters
                # 翻译为各平台筛选参数（BOSS 走 searchUrl.ts + webview，此处忽略）。
                criteria = body.get('criteria') if isinstance(body.get('criteria'), dict) else {}
                # 定向重新采集（「任务进度」页「开始/继续」）：忽略断点续采，强制重采
                force = body.get('force') is True
                # 设置页「采集速度」倍率：夹在 1~3，缺失/非法按 1（标准，改造前节奏）
                pace = normalize_pace(body.get('pace'))
                if not query:
                    return self._send(400, {"ok": False, "error": "缺少 query"})
                if platform == 'boss':
                    # issue #7 第五节：BOSS 分支原先丢弃 criteria → 隐身通道不筛基础求职条件
                    result = search_jobs(query, city, pages, os_name, criteria, pace)
                else:
                    # M-11：透传配置（渲染层只发非敏感子集 {platforms}），供断点续采 TTL 读取
                    cfg = body.get('config') if isinstance(body.get('config'), dict) else None
                    result = platform_mods.search_jobs(platform, query, city, pages, os_name, criteria, force, cfg, pace)
                return self._send(200, result)

            if parsed.path == '/send':
                job_id = str(body.get('jobId') or body.get('job_id') or '').strip()
                greeting = str(body.get('greeting') or '').strip()
                os_name = body.get('os') or None
                if not job_id:
                    return self._send(400, {"ok": False, "error": "缺少 jobId"})
                if not greeting:
                    return self._send(400, {"ok": False, "error": "缺少 greeting", "code": 400})
                if platform == 'boss':
                    result = send_greeting(job_id, greeting, os_name)
                else:
                    job = {
                        "jobId": job_id,
                        "url": str(body.get('url') or ''),
                        "company": str(body.get('company') or ''),
                        "recruiterName": str(body.get('recruiterName') or ''),
                        "title": str(body.get('jobTitle') or ''),
                    }
                    result = platform_mods.deliver(platform, job, greeting, os_name)
                return self._send(200, result)

            if parsed.path == '/login':
                timeout = max(30, min(600, int(body.get('timeout') or 180)))
                os_name = body.get('os') or None
                if platform == 'boss':
                    result = do_login(timeout, os_name)
                else:
                    result = platform_mods.do_login(platform, timeout, os_name)
                return self._send(200, result)

            if parsed.path == '/logout':
                clear_session(platform)
                return self._send(200, {"ok": True, "loggedIn": False})

            if parsed.path == '/clear':
                clear_session(platform)
                return self._send(200, {"ok": True})

            # 平台能力矩阵（对齐 BossHunter collection/capabilities.py）：
            # 设置页 / 工作台据此判断某平台是否支持 collect / deliver / attach 等动作。
            if parsed.path == '/platforms':
                return self._send(200, {"ok": True, **platform_mods.platform_capabilities()})

            # 断点续采进度：查询 / 清除（clear=true 时清除，platform 可限定单平台）
            if parsed.path == '/collection-progress':
                if body.get('clear') is True:
                    target = platform if body.get('platform') else None
                    return self._send(200, platform_mods.clear_collection_progress(target))
                progress_cfg = body.get('config') if isinstance(body.get('config'), dict) else None
                return self._send(200, {"ok": True, **platform_mods.collection_progress(platform, progress_cfg)})

            return self._send(404, {"ok": False, "error": "not found"})
        except Exception as e:
            log('❌', f'处理异常：{e}')
            return self._send(500, {"ok": False, "error": str(e)})

    def log_message(self, fmt, *args):
        pass  # 静默访问日志


# 各平台登录态判定 Cookie（名称含关键字即视为已登录）
# 与 main.cjs `WEBVIEW_AUTH_COOKIE_HINTS` 同源：`=name` 精确匹配 / 嵌套元组 = 成对条件（需同时存在）。
PLATFORM_AUTH_COOKIE_HINTS = {
    'boss': ('wt2',),
    'liepin': ('lp_login', 'lp_token', 'token'),
    'zhaopin': ('zp_auto', 'zp_sign', 'swordman', 'zm_job_pc', ('=at', '=rt')),
    'job51': ('j_ticket', 'sajssp', '51job', 'job51'),
}


def _cookie_name_matches(name: str, hint: str) -> bool:
    """`=name` 精确匹配；其余子串匹配（沿用历史宽松语义）。"""
    if hint.startswith('='):
        return name == hint[1:]
    return name.startswith(hint) or hint in name


def _cookie_usable(c: dict) -> bool:
    """cookie 是否既非空值、又未过期。

    过期判定不能省：`wt2` 值还在文件里但早已过期时，原实现仍把它认成「已登录」，
    界面亮着绿灯、用户点开始，平台却回「身份验证失效」—— 现场看到的正是这个矛盾。
    `expires` 为 -1 / 缺省 = 会话 cookie（浏览器关闭即失效），仍算有效。
    """
    if not c.get('value'):
        return False
    exp = c.get('expires', -1)
    try:
        exp = float(exp)
    except (TypeError, ValueError):
        return True
    # 兼容毫秒时间戳（个别来源会写成 ms，若不归一会被直译成公元 5 万年后的未来）
    if exp > 1e12:
        exp /= 1000.0
    return exp <= 0 or exp > time.time()


def _auth_hint_hit(cookies, hint) -> bool:
    """单个 hint（字符串=任一 cookie 命中；元组=成对条件需同时命中）。"""
    pats = hint if isinstance(hint, tuple) else (hint,)
    return all(
        any(_cookie_usable(c) and _cookie_name_matches(str(c.get('name', '')).lower(), p) for c in cookies)
        for p in pats
    )


def engine_status(platform: str = 'boss') -> dict:
    """检测隐身引擎可用性（不启动浏览器）：内核检测 + 指定平台 Cookie 状态。"""
    import importlib.util
    cf = cookie_file(platform)
    cookie_count = 0
    logged_in = False
    if cf.exists():
        try:
            with open(cf, encoding='utf-8') as f:
                cookies = json.load(f).get('cookies', [])
                cookie_count = len(cookies)
            # 登录态独立判定：仅按该平台鉴权 Cookie 命中（不靠匿名 cookie 数量，避免误判已登录）
            hints = PLATFORM_AUTH_COOKIE_HINTS.get(platform, PLATFORM_AUTH_COOKIE_HINTS['boss'])
            logged_in = any(_auth_hint_hit(cookies, hint) for hint in hints)
        except Exception:
            pass
    info = {
        "ok": False,
        "version": VERSION,
        "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "camoufox": False,
        "camoufoxVersion": "",
        "playwright": False,
        "kernel": "none",
        "kernelPath": "",
        "kernelMessage": "",
        "platform": platform,
        "cookies": cf.exists(),
        "cookieCount": cookie_count,
        "loggedIn": logged_in,
        # issue #7 P2：单次搜索页数上限（前端用它渲染输入框上限，避免两处各写一个 5）
        "maxPages": max_search_pages(),
        "message": "",
    }
    spec = importlib.util.find_spec('camoufox')
    if spec is not None:
        info["camoufox"] = True
        try:
            # 注意：camoufox 0.5.4 的 camoufox.__version__ 是 module 而非字符串，
            # 必须用 importlib.metadata 读版本号（否则 JSON 序列化报错）
            import importlib.metadata
            info["camoufoxVersion"] = importlib.metadata.version('camoufox')
        except Exception:
            pass
    if importlib.util.find_spec('playwright') is not None:
        info["playwright"] = True

    # 内核检测：仅 Camoufox 原生内核可用（本地 Chrome/Edge 不可复用，BOSS 反爬对 Playwright 驱动浏览器返回空壳）
    kernel = detect_kernel()
    info["kernel"] = kernel["kind"]
    info["kernelPath"] = kernel.get("path") or ""
    info["kernelMessage"] = kernel.get("message") or ""
    if kernel["kind"] != "none":
        info["ok"] = True
        info["message"] = kernel["message"]
    else:
        info["message"] = kernel["message"]
    return info


def main():
    parser = argparse.ArgumentParser(description='BossClaw Camoufox 隐身引擎桥')
    parser.add_argument('--port', type=int, default=18767)
    # M-2：令牌优先取环境变量（主进程随机生成后经 env 注入）；--token 仍可显式覆盖。
    # 兜底默认值仅为「脱离主进程单独手工启动本服务」时的可用性，正式链路不会用到。
    parser.add_argument('--token', default=os.environ.get('BOSSCLAW_CAMOUFOX_TOKEN') or 'bossclaw-camoufox')
    args = parser.parse_args()

    # 启动前先检测引擎可用性（内核 + Cookie）
    status = engine_status()
    log('🧪', f"内核={'✅ ' + status['kernel'] if status['kernel'] != 'none' else '❌ none'} "
              f"camoufox={'✅' if status['camoufox'] else '—'} "
              f"cookies={'✅' if status['cookieCount'] else '—'}")
    log('📦', status['message'])

    server = ThreadingHTTPServer(('127.0.0.1', args.port), CamoufoxHandler)
    server.token = args.token
    log('🚀', f'隐身引擎桥 listening on 127.0.0.1:{args.port} (v{VERSION})')

    # 预热固定浏览器身份：fpgen 首次会下载指纹模型，可能耗时数十秒。
    # 放在后台线程做，避免用户第一次扫码/投递时才现生成（表现为「点了没反应」）。
    def _warm_identity():
        try:
            load_identity('boss')
        except Exception:
            pass
    threading.Thread(target=_warm_identity, name='bossclaw-identity-warm', daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == '__main__':
    main()

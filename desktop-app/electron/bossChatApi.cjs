// 消息预警 · 主进程 BOSS 会话只读 API
//
// 职责：保存 wt2（safeStorage 加密）→ 经「内存分区」的 Electron Chromium 网络栈调用 3 个只读接口
//   geekFilterByLabel → getGeekFriendList.json → historyMsg（口径见 doc/boss_chatapi.md）。
// 红线：
//   · 只读：绝不调用 geekEnter / friend/add / 任何发送接口；
//   · wt2 只存在于主进程（加密文件 + 内存 cookie jar），任何返回值都不含 cookie；
//   · 分区名不带 persist: 前缀 → cookie jar 仅内存，不会把明文 wt2 写进磁盘；
//   · code 7 = 登录失效 → 停止并上报 expired；35/36/32 = 风控 → 上报 risk，由渲染层进冷却，绝不重试。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BASE = 'https://www.zhipin.com';
const PARTITION = 'bossclaw-alert'; // 无 persist: 前缀 = 内存分区
const VAULT_FILE = 'boss-alert-cookie.bin';
const ENCRYPT_SYSTEM_ID = '8cee15b718bda27e0Hx6';
const REFERER = BASE + '/web/geek/chat';
const RISK_CODES = new Set([32, 35, 36]);
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_FRIENDS = 60;

/**
 * 解析粘贴的 wt2：纯值，或整行 `wt2=xxx; Domain=...; Expires=...`。
 * 与 src/lib/bossclaw/chatAlert.ts 的 parseCookieInput 同口径（主进程是权威，渲染层仅做预览）。
 */
function parseCookieInput(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  let value = text;
  let expiresAt = null;
  const named = text.match(/(?:^|[;\s])wt2=([^;\s]+)/i);
  if (named) {
    value = named[1];
    const exp = text.match(/expires=([^;]+)/i);
    if (exp) {
      const t = Date.parse(exp[1].trim().replace(/-(\w{3})-/, ' $1 '));
      if (Number.isFinite(t)) expiresAt = t;
    }
  } else if (/[;=\s]/.test(text)) {
    return null;
  }
  if (!/^[A-Za-z0-9_\-~%.+/]{16,512}$/.test(value)) return null;
  return { value, expiresAt };
}

const clampStr = (v, max) => {
  const s = typeof v === 'string' ? v : '';
  return s.length > 0 && s.length <= max ? s : '';
};
const pick = (o, keys) => {
  const out = {};
  for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k];
  return out;
};

function trimFriend(f) {
  const lm = f && f.lastMessageInfo;
  return {
    ...pick(f, ['uid', 'name', 'brandName', 'title', 'encryptBossId', 'securityId', 'lastMsg']),
    lastMessageInfo: lm ? pick(lm, ['msgId', 'fromId', 'toId', 'msgTime']) : undefined,
  };
}

function trimMessage(m) {
  const b = (m && m.body) || {};
  const jd = b.jobDesc;
  return {
    mid: m && m.mid,
    time: m && m.time,
    type: m && m.type,
    from: pick(m && m.from, ['uid', 'name']),
    to: pick(m && m.to, ['uid']),
    body: {
      type: b.type,
      text: typeof b.text === 'string' ? b.text : undefined,
      headTitle: typeof b.headTitle === 'string' ? b.headTitle : undefined,
      jobDesc: jd ? pick(jd, ['title', 'salary', 'company', 'city']) : undefined,
    },
  };
}

/**
 * 工厂：依赖全部可注入，便于离线测试。
 * @param {object} deps
 * @param {object} deps.safeStorage  Electron safeStorage（isEncryptionAvailable/encryptString/decryptString）
 * @param {() => object} deps.getSession  返回内存分区 session（需 fetch / cookies / setUserAgent / webRequest）
 * @param {object} deps.stealth  stealth.cjs（resolveProfile/buildUserAgent/buildRequestHeaderOverrides）
 * @param {string} deps.userDataDir
 * @param {(ms:number)=>Promise<void>} [deps.sleep]
 * @param {()=>number} [deps.now]
 * @param {(level:string,msg:string,extra?:object)=>void} [deps.log]
 */
function createBossChatApi(deps) {
  const { safeStorage, getSession, stealth, userDataDir } = deps;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || (() => Date.now());
  const log = deps.log || (() => {});
  const vaultPath = path.join(userDataDir, VAULT_FILE);

  let ses = null;
  let sessionReady = false; // cookie 已写入内存分区
  let identity = null; // { uid, name }
  let lastExpired = false;

  // ---------- 加密存储 ----------
  function encryptionOk() {
    try {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) return false;
      // Linux 无钥匙串时会退回明文 basic_text，等于没加密 → 拒绝保存
      if (typeof safeStorage.getSelectedStorageBackend === 'function'
        && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
      return true;
    } catch { return false; }
  }

  function readVault() {
    try {
      const buf = fs.readFileSync(vaultPath);
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
      const obj = JSON.parse(safeStorage.decryptString(buf));
      return obj && typeof obj.value === 'string' ? obj : null;
    } catch { return null; }
  }

  function writeVault(obj) {
    fs.mkdirSync(path.dirname(vaultPath), { recursive: true });
    const tmp = vaultPath + '.tmp';
    fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(obj)), { mode: 0o600 });
    fs.renameSync(tmp, vaultPath);
  }

  // ---------- 会话（内存分区）----------
  function getSes() {
    if (ses) return ses;
    ses = getSession();
    const profile = stealth.resolveProfile();
    ses.setUserAgent(stealth.buildUserAgent(profile));
    const overrides = stealth.buildRequestHeaderOverrides(profile);
    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      const h = details.requestHeaders;
      for (const k of Object.keys(overrides)) h[k] = overrides[k];
      cb({ requestHeaders: h });
    });
    return ses;
  }

  async function injectCookie(rec) {
    const s = getSes();
    const cookie = {
      url: BASE, name: 'wt2', value: rec.value, domain: '.zhipin.com', path: '/',
      secure: true, httpOnly: true,
    };
    if (rec.expiresAt && rec.expiresAt > now()) cookie.expirationDate = Math.floor(rec.expiresAt / 1000);
    await s.cookies.set(cookie);
    sessionReady = true;
  }

  async function ensureCookie() {
    if (sessionReady) return { ok: true };
    const rec = readVault();
    if (!rec) return { ok: false, code: 31, message: '尚未设置 wt2 Cookie' };
    if (rec.expiresAt && rec.expiresAt <= now()) {
      lastExpired = true;
      return { ok: false, code: 7, expired: true, message: 'wt2 已过期，请重新粘贴' };
    }
    await injectCookie(rec);
    if (!identity && rec.uid) identity = { uid: rec.uid, name: rec.name || '' };
    return { ok: true };
  }

  // ---------- 请求 ----------
  async function call(method, pathAndQuery, form) {
    const ready = await ensureCookie();
    if (!ready.ok) return ready;
    const s = getSes();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const init = {
        method,
        signal: ctrl.signal,
        headers: {
          accept: 'application/json, text/plain, */*',
          referer: REFERER,
          'x-requested-with': 'XMLHttpRequest',
        },
      };
      if (form) {
        init.headers['content-type'] = 'application/x-www-form-urlencoded';
        init.body = form;
      }
      const res = await s.fetch(BASE + pathAndQuery, init);
      if (!res.ok) return { ok: false, code: res.status, message: `HTTP ${res.status}` };
      let json;
      try { json = await res.json(); } catch { return { ok: false, code: 500, message: '响应不是合法 JSON' }; }
      const code = Number(json && json.code);
      if (code === 0) return { ok: true, data: (json && json.zpData) || {} };
      if (code === 7) { lastExpired = true; return { ok: false, code: 7, expired: true, message: '登录已失效，请重新粘贴 wt2' }; }
      if (RISK_CODES.has(code)) return { ok: false, code, risk: true, message: String(json.message || '触发风控，已停止') };
      return { ok: false, code: Number.isFinite(code) ? code : 500, message: String(json && json.message || '请求失败') };
    } catch (e) {
      const msg = String((e && e.message) || e);
      return { ok: false, code: 0, message: /abort/i.test(msg) ? '请求超时' : '网络请求失败：' + msg };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- 对外能力 ----------
  async function validate() {
    const r = await call('GET', '/wapi/zpuser/wap/getUserInfo.json');
    if (!r.ok) return r;
    const uid = r.data.userId;
    if (!uid) return { ok: false, code: 7, expired: true, message: '未读到登录用户，Cookie 可能无效' };
    identity = { uid, name: String(r.data.name || '') };
    lastExpired = false;
    return { ok: true, uid, name: identity.name };
  }

  async function setCookie(raw) {
    const parsed = parseCookieInput(raw);
    if (!parsed) return { ok: false, code: 400, message: 'Cookie 格式不正确：请粘贴 wt2 的值，或整行 wt2=…; Expires=…' };
    if (!encryptionOk()) return { ok: false, code: 500, message: '系统加密存储不可用，出于安全考虑拒绝保存 Cookie' };
    if (parsed.expiresAt && parsed.expiresAt <= now()) return { ok: false, code: 7, expired: true, message: '该 Cookie 已过期' };
    sessionReady = false;
    identity = null;
    await injectCookie(parsed);
    const v = await validate();
    if (!v.ok) {
      try { await getSes().cookies.remove(BASE, 'wt2'); } catch { /* 忽略 */ }
      sessionReady = false;
      return v;
    }
    writeVault({ value: parsed.value, expiresAt: parsed.expiresAt, uid: v.uid, name: v.name });
    return { ok: true, uid: v.uid, name: v.name, expiresAt: parsed.expiresAt };
  }

  async function clearCookie() {
    try { fs.rmSync(vaultPath, { force: true }); } catch { /* 忽略 */ }
    try { if (ses) await ses.cookies.remove(BASE, 'wt2'); } catch { /* 忽略 */ }
    sessionReady = false;
    identity = null;
    lastExpired = false;
    return { ok: true };
  }

  function status() {
    const rec = readVault();
    const expiresAt = rec && rec.expiresAt ? rec.expiresAt : null;
    const expired = lastExpired || Boolean(expiresAt && expiresAt <= now());
    return {
      ok: true,
      hasCookie: Boolean(rec),
      expired,
      expiresAt,
      uid: (identity && identity.uid) || (rec && rec.uid) || null,
      name: (identity && identity.name) || (rec && rec.name) || '',
      encryptionAvailable: encryptionOk(),
    };
  }

  /** 阶段 1 数据：联系人 → 每个会话的最后一条消息 */
  async function scan() {
    const list = await call('GET', `/wapi/zprelation/friend/geekFilterByLabel?labelId=0&encryptSystemId=${ENCRYPT_SYSTEM_ID}`);
    if (!list.ok) return list;
    const ids = (list.data.friendList || []).map((f) => f && f.friendId).filter(Boolean).slice(0, MAX_FRIENDS);
    if (!ids.length) return { ok: true, friends: [], myUid: identity && identity.uid };
    await sleep(1500 + Math.floor(Math.random() * 2000));
    const detail = await call('POST', '/wapi/zprelation/friend/getGeekFriendList.json',
      'friendIds=' + encodeURIComponent(ids.join(',')));
    if (!detail.ok) return detail;
    const result = Array.isArray(detail.data.result) ? detail.data.result : [];
    return { ok: true, friends: result.map(trimFriend), myUid: identity && identity.uid };
  }

  /** 阶段 2 数据：某会话最近 n 条消息（只读 historyMsg） */
  async function history(bossId, securityId, n) {
    const b = clampStr(bossId, 200);
    const s = clampStr(securityId, 800);
    if (!b || !s) return { ok: false, code: 400, message: '缺少或非法的 bossId / securityId' };
    const count = Math.min(Math.max(Math.floor(Number(n) || 10), 1), 30);
    const q = `bossId=${encodeURIComponent(b)}&maxMsgId=0&c=${count}&page=1&src=0&securityId=${encodeURIComponent(s)}`;
    const r = await call('GET', '/wapi/zpchat/geek/historyMsg?' + q);
    if (!r.ok) return r;
    const msgs = Array.isArray(r.data.messages) ? r.data.messages : [];
    return { ok: true, messages: msgs.map(trimMessage), hasMore: Boolean(r.data.hasMore) };
  }

  return { setCookie, clearCookie, status, validate, scan, history, _parseCookieInput: parseCookieInput };
}

/** 注册 IPC（通道名必须同步登记到 preload/app.cjs 的 ALLOWED_IPC_CHANNELS） */
function registerBossAlertIpc(safeHandle, api) {
  safeHandle('jc:boss-alert-cookie-set', (_e, raw) => api.setCookie(raw));
  safeHandle('jc:boss-alert-cookie-clear', () => api.clearCookie());
  safeHandle('jc:boss-alert-cookie-status', () => api.status());
  safeHandle('jc:boss-alert-scan', () => api.scan());
  safeHandle('jc:boss-alert-history', (_e, bossId, securityId, n) => api.history(bossId, securityId, n));
}

module.exports = { createBossChatApi, registerBossAlertIpc, parseCookieInput, PARTITION };

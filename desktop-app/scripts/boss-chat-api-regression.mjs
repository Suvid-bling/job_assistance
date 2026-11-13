// 消息预警 · 主进程 BOSS 只读 API 回归（假 safeStorage / 假 session / 假 fetch，完全离线）
// 守住的不变量：cookie 不落明文、不出主进程；只调只读接口；code 7 / 风控码正确上报。
// 用法：node scripts/boss-chat-api-regression.mjs   （EXIT 0 = 全通过）
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { createBossChatApi, parseCookieInput } = require(join(root, 'electron', 'bossChatApi.cjs'));
const stealth = require(join(root, 'electron', 'preload', 'stealth.cjs'));

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1; else failures.push(`${name}\n   期望：${typeof expected === 'function' ? '(自定义判据)' : JSON.stringify(expected)}\n   实际：${JSON.stringify(actual)}`);
}

const WT2 = 'AAAAfakeWt2ValueForTestsOnly0123456789abcdefghijklmnopqrstuvwxyz~~';
const NOW = Date.UTC(2026, 10, 13, 0, 0, 0);

function setup({ encryptionAvailable = true, backend = 'keychain', responses = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bossclaw-alert-api-'));
  const calls = [];
  const queue = [...responses];
  const jar = new Map();
  let ua = '';
  let headerHook = null;
  const ses = {
    setUserAgent: (v) => { ua = v; },
    webRequest: { onBeforeSendHeaders: (fn) => { headerHook = fn; } },
    cookies: {
      set: async (c) => { jar.set(c.name, c); },
      remove: async (_u, name) => { jar.delete(name); },
    },
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = queue.shift();
      const body = typeof next === 'function' ? next(url, init) : next;
      return { ok: true, status: 200, json: async () => body };
    },
  };
  const safeStorage = {
    isEncryptionAvailable: () => encryptionAvailable,
    getSelectedStorageBackend: () => backend,
    // 假「加密」：可逆但不含明文片段（逐字节 +1）
    encryptString: (s) => Buffer.from(Buffer.from(String(s)).map((b) => (b + 1) & 255)),
    decryptString: (buf) => Buffer.from(Buffer.from(buf).map((b) => (b - 1) & 255)).toString('utf8'),
  };
  const api = createBossChatApi({
    safeStorage, getSession: () => ses, stealth, userDataDir: dir, sleep: async () => {}, now: () => NOW,
  });
  return { api, dir, calls, jar, queue, getUa: () => ua, getHeaderHook: () => headerHook, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ok = (zpData) => ({ code: 0, message: 'Success', zpData });
const userOk = ok({ userId: 608448808, name: '测试用户' });

// ===== Cookie 解析（主进程权威）=====
check('parse 纯值', parseCookieInput(WT2)?.value, WT2);
check('parse 整行', parseCookieInput(`wt2=${WT2}; Domain=.zhipin.com; Expires=Sat, 21-Nov-2026 19:00:00 GMT; Path=/; HttpOnly`)?.expiresAt, Date.UTC(2026, 10, 21, 19, 0, 0));
check('parse 非法', parseCookieInput('not a cookie'), null);

// ===== setCookie 成功路径 =====
{
  const t = setup({ responses: [userOk] });
  const r = await t.api.setCookie(`wt2=${WT2}; Expires=Sat, 21-Nov-2026 19:00:00 GMT`);
  check('setCookie 成功并返回身份', [r.ok, r.uid, r.name], [true, 608448808, '测试用户']);
  check('返回值不含 cookie 明文', JSON.stringify(r).includes(WT2), false);
  const files = readdirSync(t.dir);
  check('仅写入加密 vault 文件', files, ['boss-alert-cookie.bin']);
  check('vault 文件不含明文 wt2', readFileSync(join(t.dir, files[0])).toString('latin1').includes(WT2), false);
  check('cookie 写入内存分区（含 HttpOnly/secure）', [t.jar.get('wt2')?.value, t.jar.get('wt2')?.httpOnly, t.jar.get('wt2')?.secure], [WT2, true, true]);
  check('第一次请求是 getUserInfo', t.calls[0].url, 'https://www.zhipin.com/wapi/zpuser/wap/getUserInfo.json');
  check('请求带 referer 与 x-requested-with', [t.calls[0].init.headers.referer, t.calls[0].init.headers['x-requested-with']], ['https://www.zhipin.com/web/geek/chat', 'XMLHttpRequest']);
  check('UA 来自 stealth 画像', t.getUa(), stealth.buildUserAgent(stealth.resolveProfile()));
  // onBeforeSendHeaders 会补齐 sec-ch-ua 系列
  let patched = null;
  t.getHeaderHook()({ requestHeaders: {} }, (o) => { patched = o.requestHeaders; });
  check('请求头覆盖含 sec-ch-ua 与 accept-language', [Boolean(patched['sec-ch-ua']), patched['accept-language']], [true, 'zh-CN,zh;q=0.9']);
  const st = t.api.status();
  check('status 只含元数据', [st.hasCookie, st.expired, st.uid, st.name, JSON.stringify(st).includes(WT2)], [true, false, 608448808, '测试用户', false]);
  t.cleanup();
}

// ===== setCookie 拒绝路径 =====
{
  const t = setup({ responses: [userOk] });
  const r = await t.api.setCookie('bad value with spaces');
  check('格式错误 → 400，且不发请求', [r.ok, r.code, t.calls.length], [false, 400, 0]);
  t.cleanup();
}
{
  const t = setup({ encryptionAvailable: false, responses: [userOk] });
  const r = await t.api.setCookie(WT2);
  check('加密不可用 → 拒绝保存', [r.ok, t.calls.length, readdirSync(t.dir).length], [false, 0, 0]);
  t.cleanup();
}
{
  const t = setup({ backend: 'basic_text', responses: [userOk] });
  const r = await t.api.setCookie(WT2);
  check('Linux basic_text 后端（等同明文）→ 拒绝保存', [r.ok, readdirSync(t.dir).length], [false, 0]);
  t.cleanup();
}
{
  const t = setup({ responses: [userOk] });
  const r = await t.api.setCookie(`wt2=${WT2}; Expires=Mon, 01-Jan-2024 00:00:00 GMT`);
  check('已过期 Cookie → 拒绝', [r.ok, r.expired, t.calls.length], [false, true, 0]);
  t.cleanup();
}
{
  const t = setup({ responses: [{ code: 7, message: '当前登录状态已失效', zpData: {} }] });
  const r = await t.api.setCookie(WT2);
  check('服务端判失效 → 不保存且清掉内存 cookie', [r.ok, r.expired, readdirSync(t.dir).length, t.jar.has('wt2')], [false, true, 0, false]);
  t.cleanup();
}

// ===== scan =====
{
  const friend = (id) => ({ friendId: id });
  const detail = ok({ result: [{
    uid: 11, name: '王女士', brandName: '某公司', title: '招聘者', encryptBossId: 'bb11', securityId: 'ss11', lastMsg: '在吗',
    avatar: 'https://x/a.png', tinyUrl: 'https://x/b.png', jobId: 1, encryptJobId: 'zzz',
    lastMessageInfo: { msgId: 99, fromId: 11, toId: 608448808, msgTime: 5, showText: 'secret', status: 0 },
  }] });
  const t = setup({ responses: [userOk, ok({ friendList: [friend(11), friend(22)] }), detail] });
  await t.api.setCookie(WT2);
  const r = await t.api.scan();
  check('scan 成功', [r.ok, r.friends.length, r.myUid], [true, 1, 608448808]);
  check('scan 只带 UI 需要的字段（不含头像/jobId）', Object.keys(r.friends[0]).sort(), ['brandName', 'encryptBossId', 'lastMessageInfo', 'lastMsg', 'name', 'securityId', 'title', 'uid']);
  check('lastMessageInfo 精简', Object.keys(r.friends[0].lastMessageInfo).sort(), ['fromId', 'msgId', 'msgTime', 'toId']);
  const urls = t.calls.map((c) => `${c.init.method} ${c.url}`);
  check('scan 调用 geekFilterByLabel 与 getGeekFriendList', urls.slice(1), [
    'GET https://www.zhipin.com/wapi/zprelation/friend/geekFilterByLabel?labelId=0&encryptSystemId=8cee15b718bda27e0Hx6',
    'POST https://www.zhipin.com/wapi/zprelation/friend/getGeekFriendList.json',
  ]);
  check('friendIds 表单体', t.calls[2].init.body, 'friendIds=11%2C22');
  check('POST 为表单类型', t.calls[2].init.headers['content-type'], 'application/x-www-form-urlencoded');
  t.cleanup();
}
{
  const t = setup({ responses: [userOk, ok({ friendList: [] })] });
  await t.api.setCookie(WT2);
  const r = await t.api.scan();
  check('无联系人 → 空列表且不请求详情', [r.ok, r.friends.length, t.calls.length], [true, 0, 2]);
  t.cleanup();
}

// ===== history =====
{
  const hist = ok({ hasMore: false, messages: [{
    mid: 1, time: 2, type: 3, from: { uid: 11, name: 'HR', avatar: 'x' }, to: { uid: 608448808, name: 'me' },
    securityId: 'leak', body: { type: 8, headTitle: '职位', jobDesc: { title: 'AI', salary: '20K', company: 'C', city: '北京', url: 'bosszp://leak' } },
  }, { mid: 2, time: 3, type: 3, from: { uid: 11 }, to: { uid: 608448808 }, body: { type: 1, text: '你好' } }] });
  const t = setup({ responses: [userOk, hist, hist, hist] });
  await t.api.setCookie(WT2);
  const r = await t.api.history('bb11', 'ss/11+=~', 99);
  check('history 成功并精简字段', [r.ok, r.messages.length, r.messages[0].body.jobDesc], [true, 2, { title: 'AI', salary: '20K', company: 'C', city: '北京' }]);
  check('history 不透传 securityId/头像', JSON.stringify(r).includes('leak'), false);
  check('history URL：编码 + n 夹到 30', t.calls[1].url,
    'https://www.zhipin.com/wapi/zpchat/geek/historyMsg?bossId=bb11&maxMsgId=0&c=30&page=1&src=0&securityId=ss%2F11%2B%3D~');
  const bad1 = await t.api.history('', 'x', 5);
  const bad2 = await t.api.history('b', 'x'.repeat(801), 5);
  check('history 参数校验', [bad1.ok, bad1.code, bad2.ok, bad2.code], [false, 400, false, 400]);
  await t.api.history('bb11', 'ss11', 0);
  check('history n=0 → 回落 10', t.calls[2].url.includes('&c=10&'), true);
  t.cleanup();
}

// ===== 错误码映射 =====
{
  const t = setup({ responses: [userOk, { code: 7, message: 'x', zpData: {} }] });
  await t.api.setCookie(WT2);
  const r = await t.api.scan();
  check('code 7 → expired', [r.ok, r.code, r.expired], [false, 7, true]);
  check('status 随之变为 expired', t.api.status().expired, true);
  t.cleanup();
}
for (const code of [32, 35, 36]) {
  const t = setup({ responses: [userOk, { code, message: '安全验证', zpData: {} }] });
  await t.api.setCookie(WT2);
  const r = await t.api.scan();
  check(`风控码 ${code} → risk`, [r.ok, r.code, r.risk], [false, code, true]);
  t.cleanup();
}
{
  const t = setup({ responses: [userOk, { code: 0, zpData: {} }] });
  const r = await t.api.scan();
  check('未设置 Cookie → 31 且不发请求', [r.ok, r.code, t.calls.length], [false, 31, 0]);
  t.cleanup();
}

// ===== clear =====
{
  const t = setup({ responses: [userOk] });
  await t.api.setCookie(WT2);
  await t.api.clearCookie();
  check('clear 删除 vault 与内存 cookie', [existsSync(join(t.dir, 'boss-alert-cookie.bin')), t.jar.has('wt2'), t.api.status().hasCookie], [false, false, false]);
  t.cleanup();
}

// ===== 只读红线：所有请求都在白名单路径内 =====
{
  const t = setup({ responses: [userOk, ok({ friendList: [{ friendId: 1 }] }), ok({ result: [] }), ok({ messages: [] })] });
  await t.api.setCookie(WT2);
  await t.api.scan();
  await t.api.history('b', 's', 5);
  const allowed = [
    '/wapi/zpuser/wap/getUserInfo.json',
    '/wapi/zprelation/friend/geekFilterByLabel',
    '/wapi/zprelation/friend/getGeekFriendList.json',
    '/wapi/zpchat/geek/historyMsg',
  ];
  const bad = t.calls.filter((c) => !allowed.some((p) => new URL(c.url).pathname === p));
  check('所有请求都落在只读白名单', bad.map((c) => c.url), []);
  t.cleanup();
}

// ===== 源码静态不变量 =====
const apiSrc = readFileSync(join(root, 'electron', 'bossChatApi.cjs'), 'utf8');
check('模块不引用写入类接口', /geekEnter|friend\/add|sendMsg|chat\/send/i.test(apiSrc.replace(/\/\/.*$/gm, '')), false);
check('分区名不带 persist:（cookie 仅内存）', /persist:/.test(apiSrc.replace(/\/\/.*$/gm, '')), false);

if (failures.length) {
  console.error(`✗ boss-chat-api-regression：${failures.length} 项失败（通过 ${pass}）`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`✓ boss-chat-api-regression：${pass} 项断言全部通过`);

// 消息预警 · 一轮扫描回归（假 api / 假 LLM / 假时钟，完全离线）
// 用法：node scripts/message-alert-cycle-regression.mjs   （EXIT 0 = 全通过）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'bossclaw-cycle-'));
const outfile = join(dir, 'bundle.cjs');
await build({
  stdin: { contents: "export * from './src/lib/bossclaw/alertCycle.ts';", resolveDir: root, sourcefile: 'cycle-entry.ts', loader: 'ts' },
  bundle: true, format: 'cjs', platform: 'node', target: 'node18', outfile, logLevel: 'silent',
});
const { runAlertCycle, pendingCount } = createRequire(import.meta.url)(outfile);
rmSync(dir, { recursive: true, force: true });

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass += 1;
  else failures.push(`${name}\n   期望：${JSON.stringify(expected)}\n   实际：${JSON.stringify(actual)}`);
}

const ME = 1000;
const friend = (uid, fromId, msgId, extra = {}) => ({
  uid, name: `HR${uid}`, brandName: `公司${uid}`, encryptBossId: `b${uid}`, securityId: `s${uid}`,
  lastMessageInfo: { msgId, fromId, toId: fromId === ME ? uid : ME, msgTime: Number(msgId.replace(/\D/g, '')) || 1 }, ...extra,
});
const text = (mid, from, t) => ({ mid, time: mid, from: { uid: from }, body: { type: 1, text: t } });
const card = (mid, from) => ({ mid, time: mid, from: { uid: from }, body: { type: 16 } });
const job = { mid: 0, time: 0, from: { uid: 1 }, body: { type: 8, jobDesc: { title: 'AI工程师', salary: '20K', company: 'C', city: '北京' } } };

function deps({ friends = [], histories = {}, scanOverride, historyOverride, draftImpl, locked = false, n = 10 } = {}) {
  const calls = { scan: 0, history: [], draft: [], sleeps: [], logs: [] };
  return {
    calls,
    d: {
      api: {
        scan: async () => { calls.scan += 1; return scanOverride || { ok: true, friends, myUid: ME }; },
        history: async (b, s, cnt) => { calls.history.push([b, s, cnt]); return historyOverride ? historyOverride(b) : { ok: true, messages: histories[b] || [] }; },
      },
      draft: async (a) => { calls.draft.push(a); return draftImpl ? draftImpl(a) : { text: `回复:${a.hrMessage}`, method: 'ai', outcome: 'continue' }; },
      contextN: n, now: () => 5000, sleep: async (ms) => { calls.sleeps.push(ms); }, rand: () => 0.5,
      isLockedOut: () => locked, log: (l, m) => calls.logs.push([l, m]),
    },
  };
}
const empty = { cards: [], handled: {} };

// ===== 正常出卡 =====
{
  const t = deps({ friends: [friend(1, 1, 'm10'), friend(2, ME, 'm20')], histories: { b1: [job, text(1, ME, '您好'), card(2, 1), text(3, 1, '目前是在职吗？')] } });
  const r = await runAlertCycle(t.d, empty);
  check('状态 ok、新增 1', [r.status, r.fresh], ['ok', 1]);
  check('只为 HR 最后发言的会话读历史', t.calls.history, [['b1', 's1', 10]]);
  const c = r.state.cards[0];
  check('卡片内容', [c.id, c.name, c.company, c.jobTitle, c.salary, c.hrText, c.draft, c.method], ['1', 'HR1', '公司1', 'AI工程师', '20K', '目前是在职吗？', '回复:目前是在职吗？', 'ai']);
  check('传给 LLM 的历史已过滤卡片', t.calls.draft[0].history, [{ fromHr: false, text: '您好' }, { fromHr: true, text: '目前是在职吗？' }]);
  check('LLM 拿到岗位名', t.calls.draft[0].jobTitle, 'AI工程师');
  check('待回复数', pendingCount(r.state.cards), 1);
}
// ===== 阶段 2 否决：仅系统文案 =====
{
  const t = deps({ friends: [friend(3, 3, 'm30')], histories: { b3: [text(1, 3, 'hi'), text(2, ME, '您好'), text(3, 3, '对方已查看了您的附件简历')] } });
  const r = await runAlertCycle(t.d, empty);
  check('仅系统文案 → 不出卡且记为已处理', [r.state.cards.length, r.state.handled['3'], r.fresh, t.calls.draft.length], [0, 'm30', 0, 0]);
}
// ===== 去重 =====
{
  const t = deps({ friends: [friend(1, 1, 'm10')], histories: { b1: [text(1, 1, '在吗')] } });
  const r1 = await runAlertCycle(t.d, empty);
  const t2 = deps({ friends: [friend(1, 1, 'm10')], histories: { b1: [text(1, 1, '在吗')] } });
  const r2 = await runAlertCycle(t2.d, r1.state);
  check('同一条消息再次扫描：不重复读历史/出草稿', [t2.calls.history.length, t2.calls.draft.length, r2.fresh, r2.state.cards.length], [0, 0, 0, 1]);
  const t3 = deps({ friends: [friend(1, 1, 'm11')], histories: { b1: [text(1, 1, '在吗'), text(2, 1, '在不在')] } });
  const r3 = await runAlertCycle(t3.d, r1.state);
  check('HR 又发新消息：覆盖卡片并再次计为新增', [r3.state.cards.length, r3.state.cards[0].lastMsgId, r3.state.cards[0].hrText, r3.fresh], [1, 'm11', '在不在', 1]);
  check('覆盖时保留首次创建时间', r3.state.cards[0].createdAt, r1.state.cards[0].createdAt);
}
// ===== 我已回复 → 移除卡片 =====
{
  const t0 = deps({ friends: [friend(1, 1, 'm10')], histories: { b1: [text(1, 1, '在吗')] } });
  const r1 = await runAlertCycle(t0.d, empty);
  const t = deps({ friends: [friend(1, ME, 'm12')] });
  const r = await runAlertCycle(t.d, r1.state);
  check('我已回复 → 卡片被移除，待回复数归零', [r.state.cards.length, pendingCount(r.state.cards)], [0, 0]);
}
// ===== 用户标记已处理 =====
{
  const t = deps({ friends: [friend(1, 1, 'm10')], histories: { b1: [text(1, 1, '在吗')] } });
  const r = await runAlertCycle(t.d, { cards: [], handled: { 1: 'm10' } });
  check('已处理的 msgId 不再成为候选', [t.calls.history.length, r.state.cards.length], [0, 0]);
}
// ===== HR 已拒绝 / AI 无需回复 =====
{
  const t = deps({ friends: [friend(1, 1, 'm10')], histories: { b1: [text(1, 1, '抱歉不合适')] }, draftImpl: () => ({ text: '', method: 'ai', outcome: 'hr_rejected' }) });
  const r = await runAlertCycle(t.d, empty);
  check('HR 拒绝 → 提示卡，不计待回复/新增', [r.state.cards.length, r.state.cards[0].rejected, pendingCount(r.state.cards), r.fresh], [1, true, 0, 0]);
}
{
  const t = deps({ friends: [friend(1, 1, 'm10')], histories: { b1: [text(1, 1, '[微笑]')] }, draftImpl: () => ({ text: '', method: 'ai', outcome: 'continue' }) });
  const r = await runAlertCycle(t.d, empty);
  check('AI 判定无需回复 → 不出卡并记为已处理', [r.state.cards.length, r.state.handled['1']], [0, 'm10']);
}
{
  const t = deps({ friends: [friend(1, 1, 'm10')], histories: { b1: [text(1, 1, '在吗')] }, draftImpl: () => ({ text: '', method: 'none', outcome: 'continue', warning: 'AI 尚未配置' }) });
  const r = await runAlertCycle(t.d, empty);
  const c = r.state.cards[0];
  check('AI 未生成 → 仍出卡（空草稿 + 原因），不记为已处理', [c.method, c.draft, c.note, r.state.handled['1'], t.calls.draft.length], ['none', '', 'AI 尚未配置', undefined, 1]);
}
{
  const t = deps({ friends: [friend(1, 1, 'm10')], histories: { b1: [text(1, 1, '在吗')] }, draftImpl: () => { throw new Error('boom'); } });
  const r = await runAlertCycle(t.d, empty);
  check('草稿生成抛错 → 仍出卡（空草稿 + 提示），不中断本轮', [r.status, r.state.cards.length, r.state.cards[0].draft, /boom/.test(r.state.cards[0].note || '')], ['ok', 1, '', true]);
}
// ===== 时间窗：只看最近 3 天 =====
{
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 100 * DAY;
  const at = (uid, ms) => ({ ...friend(uid, uid, `m${uid}`), lastMessageInfo: { msgId: `m${uid}`, fromId: uid, toId: ME, msgTime: ms } });
  const friends = [at(1, NOW - 2 * DAY), at(2, NOW - 4 * DAY), { ...at(3, 0), lastMessageInfo: { msgId: 'm3', fromId: 3, toId: ME } }];
  const histories = { b1: [text(1, 1, '近期')], b2: [text(1, 2, '很久以前')], b3: [text(1, 3, '无时间')] };
  const t = deps({ friends, histories });
  t.d.now = () => NOW;
  const oldCard = { id: '2', lastMsgId: 'm2', method: 'ai', rejected: false, history: [], hrText: 'x' };
  const r = await runAlertCycle(t.d, { cards: [oldCard], handled: {} });
  check('超过 3 天 / 无时间的会话不读历史', t.calls.history.map((c) => c[0]), ['b1']);
  check('超过 3 天的旧卡片被移除', r.state.cards.map((c) => c.id), ['1']);
}
// ===== 单轮上限与节奏 =====
{
  const friends = Array.from({ length: 14 }, (_, i) => friend(i + 1, i + 1, `m${100 + i}`));
  const histories = Object.fromEntries(friends.map((f) => [f.encryptBossId, [text(1, f.uid, '在吗')]]));
  const t = deps({ friends, histories });
  const r = await runAlertCycle(t.d, empty);
  check('单轮最多读取 10 个会话历史', [t.calls.history.length, r.state.cards.length], [10, 10]);
  check('优先处理最新消息', t.calls.history[0][0], 'b14');
  check('历史请求之间有 1.5–3.5s 间隔（共 9 次）', [t.calls.sleeps.length, t.calls.sleeps.every((ms) => ms >= 1500 && ms <= 3500)], [9, true]);
  const t2 = deps({ friends, histories });
  const r2 = await runAlertCycle(t2.d, r.state);
  check('剩余 4 个留到下一轮', [t2.calls.history.length, r2.state.cards.length], [4, 14]);
}
// ===== 停止类状态 =====
{
  const t = deps({ locked: true, friends: [friend(1, 1, 'm10')] });
  const r = await runAlertCycle(t.d, empty);
  check('冷却期 → locked 且不发任何请求', [r.status, t.calls.scan], ['locked', 0]);
}
{
  const t = deps({ scanOverride: { ok: false, code: 7, expired: true, message: '失效' } });
  const r = await runAlertCycle(t.d, empty);
  check('scan 返回 code 7 → expired', [r.status, r.message], ['expired', '失效']);
}
for (const code of [32, 35, 36]) {
  const t = deps({ scanOverride: { ok: false, code, risk: true, message: '验证' } });
  const r = await runAlertCycle(t.d, empty);
  check(`scan 风控码 ${code} → risk`, [r.status, r.riskCode], ['risk', code]);
}
{
  const t = deps({ scanOverride: { ok: false, code: 0, message: '网络失败' }, friends: [] });
  const r = await runAlertCycle(t.d, { cards: [{ id: 'keep' }], handled: {} });
  check('网络错误 → error，已有卡片保留', [r.status, r.state.cards.length], ['error', 1]);
}
{
  let n = 0;
  const t = deps({
    friends: [friend(1, 1, 'm10'), friend(2, 2, 'm9')],
    histories: { b1: [text(1, 1, 'a')], b2: [text(1, 2, 'b')] },
    historyOverride: (b) => (++n === 1 ? { ok: true, messages: [text(1, 1, 'a')] } : { ok: false, code: 35, risk: true, message: '验证' }),
  });
  const r = await runAlertCycle(t.d, empty);
  check('读历史途中命中风控：立即停止，已完成的卡片保留', [r.status, r.riskCode, r.state.cards.length, r.fresh], ['risk', 35, 1, 1]);
}
{
  const t = deps({
    friends: [friend(1, 1, 'm10')],
    historyOverride: () => ({ ok: false, code: 500, message: '服务繁忙' }),
  });
  const r = await runAlertCycle(t.d, empty);
  check('读历史普通失败：跳过，不标记已处理（下轮重试）', [r.status, r.state.cards.length, r.state.handled['1']], ['ok', 0, undefined]);
}
{
  const t = deps({ scanOverride: { ok: true, friends: [friend(1, 1, 'm10')], myUid: null } });
  const r = await runAlertCycle(t.d, empty);
  check('缺少账号 uid → error 且不读历史', [r.status, t.calls.history.length], ['error', 0]);
}
// ===== 不修改入参 =====
{
  const input = { cards: [], handled: {} };
  const t = deps({ friends: [friend(1, 1, 'm10')], histories: { b1: [text(1, 1, '在吗')] } });
  await runAlertCycle(t.d, input);
  check('入参状态不被原地修改', [input.cards.length, Object.keys(input.handled).length], [0, 0]);
}

if (failures.length) {
  console.error(`✗ message-alert-cycle-regression：${failures.length} 项失败（通过 ${pass}）`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`✓ message-alert-cycle-regression：${pass} 项断言全部通过`);

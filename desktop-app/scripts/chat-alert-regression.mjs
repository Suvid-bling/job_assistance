// 消息预警「谁在等我回复」规则回归（零新增依赖，esbuild 打包 TS 再 require）
// 用法：node scripts/chat-alert-regression.mjs   （EXIT 0 = 全通过）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'bossclaw-alert-'));
const outfile = join(dir, 'bundle.cjs');
await build({
  stdin: {
    contents: "export * from './src/lib/bossclaw/chatAlert.ts';",
    resolveDir: root, sourcefile: 'chat-alert-entry.ts', loader: 'ts',
  },
  bundle: true, format: 'cjs', platform: 'node', target: 'node18', outfile, logLevel: 'silent',
});
const m = createRequire(import.meta.url)(outfile);
rmSync(dir, { recursive: true, force: true });

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1; else failures.push(`${name}\n   期望：${JSON.stringify(expected)}\n   实际：${JSON.stringify(actual)}`);
}

const ME = 1000;
const friend = (uid, fromId, msgId, extra = {}) => ({
  uid, name: `HR${uid}`, brandName: `公司${uid}`, encryptBossId: `b${uid}`, securityId: `s${uid}`,
  lastMsg: 'x', lastMessageInfo: { msgId, fromId, toId: fromId === ME ? uid : ME }, ...extra,
});
const msg = (mid, from, bodyType, text, extra = {}) => ({ mid, time: 1, from: { uid: from }, body: { type: bodyType, text, ...extra } });

// ===== 阶段 1 =====
check('HR 发了最后一条 → 候选', m.selectCandidates([friend(1, 1, 'm1')], {}).length, 1);
check('我发了最后一条 → 非候选', m.selectCandidates([friend(2, ME, 'm2')], {}).length, 0);
check('msgId 已处理 → 非候选', m.selectCandidates([friend(3, 3, 'm3')], { 3: 'm3' }).length, 0);
check('msgId 变化 → 再次成为候选', m.selectCandidates([friend(3, 3, 'm4')], { 3: 'm3' }).length, 1);
check('缺 securityId → 跳过', m.selectCandidates([{ ...friend(4, 4, 'm5'), securityId: '' }], {}).length, 0);
check('缺 lastMessageInfo → 跳过', m.selectCandidates([{ ...friend(5, 5, 'm6'), lastMessageInfo: undefined }], {}).length, 0);
check('数字与字符串 id 等价', m.selectCandidates([friend(6, '6', 'm7')], {}).length, 1);
{
  const DAY = 86400000, NOW = 10 * DAY;
  const at = (uid, ms) => ({ ...friend(uid, uid, `t${uid}`), lastMessageInfo: { msgId: `t${uid}`, fromId: uid, msgTime: ms } });
  check('时间窗常量为 3 天', m.MAX_MESSAGE_AGE_MS, 3 * DAY);
  check('3 天内 → 候选；超过 3 天 → 跳过', m.selectCandidates([at(1, NOW - 3 * DAY), at(2, NOW - 3 * DAY - 1)], {}, { now: NOW }).map((f) => f.uid), [1]);
  check('无 msgTime 时用 lastTS', m.isRecent({ ...at(3, 0), lastTS: NOW - DAY }, NOW), true);
  check('拿不到时间 → 视为不在窗内', m.isRecent(at(4, 0), NOW), false);
  check('不传 now → 不做时间过滤', m.selectCandidates([at(5, 1)], {}).length, 1);
}
check('repliedByMe：最后一条是我', m.repliedByMe(friend(7, ME, 'm8'), ME), true);
check('repliedByMe：最后一条是 HR', m.repliedByMe(friend(7, 7, 'm8'), ME), false);

// ===== isRealText =====
check('普通文字', m.isRealText(msg(1, 1, 1, '目前是在职吗？')), true);
check('职位卡 body.type 8', m.isRealText(msg(1, 1, 8, '', {})), false);
check('PK 卡 body.type 16', m.isRealText(msg(1, 1, 16, '')), false);
check('空文本', m.isRealText(msg(1, 1, 1, '   ')), false);
check('系统文案：对方已查看了您的附件简历', m.isRealText(msg(1, 1, 1, '对方已查看了您的附件简历')), false);
check('系统文案：对方已同意，您的附件简历已发送给对方', m.isRealText(msg(1, 1, 1, '对方已同意，您的附件简历已发送给对方')), false);
check('系统文案：文件名', m.isRealText(msg(1, 1, 1, '张三_AI应用开发.pdf')), false);
check('正常话术里提到简历不应误杀以外的句子', m.isRealText(msg(1, 1, 1, '你好，看到你的经历很匹配')), true);

// ===== needsReply / toChatHistory =====
const seq1 = [msg(1, ME, 1, '您好，我想了解岗位'), msg(2, 1, 16, ''), msg(3, 1, 1, '你好啊，可以聊一聊~')];
check('HR 最后真人文字 → 需回复', m.needsReply(seq1, ME), true);
const seq2 = [msg(1, 1, 1, '在吗'), msg(2, ME, 1, '在的'), msg(3, 1, 1, '对方已查看了您的附件简历')];
check('仅系统文案在后 → 不需回复', m.needsReply(seq2, ME), false);
check('PK 卡在我之后 → 不需回复', m.needsReply([msg(1, 1, 1, 'hi'), msg(2, ME, 1, '您好'), msg(3, 1, 16, '')], ME), false);
check('无真人文字 → 不需回复', m.needsReply([msg(1, 1, 8, ''), msg(2, 1, 16, '')], ME), false);
check('空列表 → 不需回复', m.needsReply([], ME), false);
check('toChatHistory 过滤并标注方向', m.toChatHistory(seq1, ME, 10), [
  { fromHr: false, text: '您好，我想了解岗位' }, { fromHr: true, text: '你好啊，可以聊一聊~' },
]);
const long = Array.from({ length: 30 }, (_, i) => msg(i, i % 2 ? ME : 1, 1, `t${i}`));
check('toChatHistory 只取最近 N 条', m.toChatHistory(long, ME, 5).map((x) => x.text), ['t25', 't26', 't27', 't28', 't29']);
check('toChatHistory N 上限 30', m.toChatHistory(long, ME, 999).length, 30);
check('toChatHistory N 非法回落默认 10', m.toChatHistory(long, ME, 'abc').length, 10);
check('lastHrText', m.lastHrText(seq1, ME), '你好啊，可以聊一聊~');
check('lastHrText：HR 从未说话', m.lastHrText([msg(1, ME, 1, 'hi')], ME), '');

// ===== jobContext =====
check('jobContext 读职位卡', m.jobContext([{ mid: 1, time: 1, from: { uid: 1 }, body: { type: 8, jobDesc: { title: 'AI工程师', salary: '20-30K', company: '某公司', city: '北京' } } }]),
  { title: 'AI工程师', salary: '20-30K', company: '某公司', city: '北京' });
check('jobContext 无卡片', m.jobContext([msg(1, 1, 1, 'hi')]), { title: '', salary: '', company: '', city: '' });

// ===== parseCookieInput =====
const V = 'FakeWt2ValueForTestsOnly0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH~~';
check('纯值', m.parseCookieInput(V)?.value, V);
check('wt2=值', m.parseCookieInput(`wt2=${V}`)?.value, V);
const full = m.parseCookieInput(`wt2=${V}; Domain=.zhipin.com; Expires=Sat, 21-Nov-2026 19:00:00 GMT; Path=/; HttpOnly`);
check('整行 Set-Cookie：取值', full?.value, V);
check('整行 Set-Cookie：解析过期时间', full?.expiresAt, Date.UTC(2026, 10, 21, 19, 0, 0));
check('空串 → null', m.parseCookieInput('  '), null);
check('过短 → null', m.parseCookieInput('abc'), null);
check('含空格杂文 → null', m.parseCookieInput('this is not a cookie value at all'), null);

// ===== 间隔 =====
check('间隔小于 5 分钟被夹到 5', m.normalizeIntervalMin(1), 5);
check('间隔非法回落 10', m.normalizeIntervalMin('x'), 10);
check('间隔上限 240', m.normalizeIntervalMin(9999), 240);
check('抖动下界 ±20%', m.nextDelayMs(10, () => 0), 480_000);
check('抖动上界 ±20%', m.nextDelayMs(10, () => 1), 720_000);

if (failures.length) {
  console.error(`✗ chat-alert-regression：${failures.length} 项失败（通过 ${pass}）`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`✓ chat-alert-regression：${pass} 项断言全部通过`);

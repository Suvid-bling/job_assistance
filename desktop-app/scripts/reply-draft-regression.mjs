// 消息预警 · AI 草稿解析回归（假 callModel，完全离线）
// 背景：callModel 在 jsonMode 下返回「已解析的对象」，generateReply 曾 String() 后再解析，
// 得到 "[object Object]"，导致所有 AI 草稿都被替换成模板。模板兜底现已删除：失败时返回空草稿 + 原因。
// 用法：node scripts/reply-draft-regression.mjs   （EXIT 0 = 全通过）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'bossclaw-reply-'));
const outfile = join(dir, 'bundle.cjs');

// 把 llm / 上下文预算 / 简历分片替换成可控桩，只测 generateReply 自身的解析与回退逻辑
const stubs = {
  './llm': 'export async function callModel() { return globalThis.__modelReturn(); }',
  './contextBudget': 'export function resolveContextBudget() { return { inputBudgetTokens: 100000 }; }',
  './oversizedContext': 'export async function prepareContextText(t) { return { text: t }; }',
};
await build({
  stdin: { contents: "export * from './src/lib/bossclaw/greetings.ts';", resolveDir: root, sourcefile: 'reply-entry.ts', loader: 'ts' },
  bundle: true, format: 'cjs', platform: 'node', target: 'node18', outfile, logLevel: 'silent',
  plugins: [{
    name: 'stub',
    setup(b) {
      b.onResolve({ filter: /^\.\/(llm|contextBudget|oversizedContext)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path], loader: 'ts' }));
    },
  }],
});
const { generateReply } = createRequire(import.meta.url)(outfile);
rmSync(dir, { recursive: true, force: true });

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass += 1;
  else failures.push(`${name}\n   期望：${JSON.stringify(expected)}\n   实际：${JSON.stringify(actual)}`);
}
const model = { apiKey: 'sk-test', model: 'm', baseUrl: 'http://x' };
const run = async (ret) => {
  globalThis.__modelReturn = typeof ret === 'function' ? ret : () => ret;
  const r = await generateReply({ hrMessage: '方便简单沟通下机会吗?', jobTitle: '算法工程师', model });
  return { text: r.text, method: r.method, outcome: r.outcome };
};

// 1) jsonMode 返回已解析对象（真实路径）→ 必须用 AI 草稿
check('对象返回 → AI 草稿', await run({ outcome: 'continue', reply: '方便的，想问下这个岗位薪资是怎么构成的？', send_resume: false, interview: false }),
  { text: '方便的，想问下这个岗位薪资是怎么构成的？', method: 'ai', outcome: 'continue' });
// 2) 字符串 JSON 仍兼容
check('字符串 JSON → AI 草稿', await run('{"outcome":"continue","reply":"好呀，可以聊聊"}'),
  { text: '好呀，可以聊聊', method: 'ai', outcome: 'continue' });
// 3) 不再做口吻/承诺/长度校验：短回复、提到面试时间的回复都保留
check('提到面试时间也保留', await run({ outcome: 'continue', reply: '可以的，面试时间您定就好' }),
  { text: '可以的，面试时间您定就好', method: 'ai', outcome: 'continue' });
// 4) HR 拒绝 → 不出草稿
check('hr_rejected', await run({ outcome: 'hr_rejected', reply: '' }), { text: '', method: 'ai', outcome: 'hr_rejected' });
// 5) reply 嵌套对象 → 取出文本
check('reply 嵌套对象', await run({ outcome: 'continue', reply: { text: '好的，谢谢您' } }),
  { text: '好的，谢谢您', method: 'ai', outcome: 'continue' });
// 6) 不再有模板兜底：调用失败 / 输出损坏 / 未配置 → 空草稿 + 原因
globalThis.__modelReturn = () => { throw new Error('boom'); };
const failed = await generateReply({ hrMessage: '在吗', jobTitle: '算法工程师', model });
check('调用失败 → 空草稿、method=none、写明原因', [failed.text, failed.method, /boom/.test(failed.warning || '')], ['', 'none', true]);
check('输出损坏 → 空草稿', await run({ outcome: 'continue', reply: '[object Object]' }), { text: '', method: 'none', outcome: 'continue' });
const noKey = await generateReply({ hrMessage: '在吗', model: { ...model, apiKey: '' } });
check('未配置 API Key → 空草稿', [noKey.text, noKey.method], ['', 'none']);

if (failures.length) {
  console.error(`[reply-draft] ${pass} 通过，${failures.length} 失败：\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`[reply-draft] 全部 ${pass} 项通过`);

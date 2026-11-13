// 消息预警 · 托盘闪烁控制器回归（假托盘 / 假窗口 / 假定时器，离线）
// 用法：node scripts/alert-flash-regression.mjs   （EXIT 0 = 全通过）
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { createAlertFlash, FLASH_INTERVAL_MS } = require(join(root, 'electron', 'alertFlash.cjs'));

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass += 1;
  else failures.push(`${name}\n   期望：${JSON.stringify(expected)}\n   实际：${JSON.stringify(actual)}`);
}

function setup({ active = false, platform = 'win32', withTray = true, withWin = true } = {}) {
  const log = { images: [], tooltips: [], flashFrame: [] };
  let intervals = 0;
  let tick = null;
  let nextId = 1;
  const trayObj = {
    setImage: (i) => log.images.push(i),
    setToolTip: (t) => log.tooltips.push(t),
    isDestroyed: () => false,
  };
  const winObj = {
    isDestroyed: () => false,
    isVisible: () => active, isFocused: () => active, isMinimized: () => false,
    flashFrame: (v) => log.flashFrame.push(v),
  };
  const f = createAlertFlash({
    getTray: () => (withTray ? trayObj : null),
    getWindow: () => (withWin ? winObj : null),
    normalImage: 'NORMAL', blankImage: 'BLANK', tooltipBase: 'BossClaw',
    platform,
    setIntervalFn: (fn, ms) => { intervals += 1; tick = fn; log.ms = ms; return nextId++; },
    clearIntervalFn: () => { tick = null; },
  });
  return { f, log, tick: () => tick && tick(), hasTimer: () => tick !== null, intervals: () => intervals };
}

// 有新增且窗口不在前台 → 开始闪烁
{
  const t = setup();
  const r = t.f.update({ count: 2, fresh: true });
  check('新增待回复 → 开始闪烁', [r.flashing, t.f.isFlashing(), t.log.ms], [true, true, FLASH_INTERVAL_MS]);
  check('tooltip 显示数量', t.log.tooltips.at(-1), 'BossClaw · 2 条待回复');
  check('Windows 闪任务栏', t.log.flashFrame, [true]);
  t.tick(); t.tick(); t.tick();
  check('图标在空白与正常之间交替', t.log.images.slice(0, 3), ['BLANK', 'NORMAL', 'BLANK']);
  t.f.acknowledge();
  check('聚焦窗口 → 停止，并恢复正常图标', [t.f.isFlashing(), t.log.images.at(-1), t.log.flashFrame.at(-1)], [false, 'NORMAL', false]);
}
// 重复推送不重复起定时器
{
  const t = setup();
  t.f.update({ count: 1, fresh: true });
  t.f.update({ count: 2, fresh: true });
  check('已在闪烁时不重复创建定时器', t.intervals(), 1);
}
// 无新增：仅更新 tooltip，不启动闪烁
{
  const t = setup();
  const r = t.f.update({ count: 3, fresh: false });
  check('无新增 → 不闪烁', [r.flashing, t.f.isFlashing()], [false, false]);
  check('但 tooltip 仍更新', t.log.tooltips.at(-1), 'BossClaw · 3 条待回复');
}
// 处理掉一条（无新增）→ 保持当前闪烁状态
{
  const t = setup();
  t.f.update({ count: 3, fresh: true });
  t.f.update({ count: 2, fresh: false });
  check('数量下降但未清零 → 继续闪烁', t.f.isFlashing(), true);
}
// 清零 → 停止
{
  const t = setup();
  t.f.update({ count: 1, fresh: true });
  const r = t.f.update({ count: 0, fresh: false });
  check('清零 → 停止并复位 tooltip', [r.flashing, t.f.isFlashing(), t.log.tooltips.at(-1)], [false, false, 'BossClaw']);
}
// 确认后再来新增 → 再次闪烁
{
  const t = setup();
  t.f.update({ count: 1, fresh: true });
  t.f.acknowledge();
  t.f.update({ count: 2, fresh: true });
  check('确认后出现新增 → 再次闪烁', t.f.isFlashing(), true);
}
// 窗口已在前台：不闪（用户正看着应用）
{
  const t = setup({ active: true });
  const r = t.f.update({ count: 1, fresh: true });
  check('窗口在前台 → 不闪烁', [r.flashing, t.f.isFlashing()], [false, false]);
}
// 非 Windows 不调 flashFrame
{
  const t = setup({ platform: 'darwin' });
  t.f.update({ count: 1, fresh: true });
  t.f.acknowledge();
  check('非 Windows 不闪任务栏', t.log.flashFrame, []);
}
// 降级：无托盘 / 无窗口不抛错
{
  const a = setup({ withTray: false });
  const b = setup({ withWin: false });
  let threw = false;
  try { a.f.update({ count: 2, fresh: true }); a.f.acknowledge(); b.f.update({ count: 2, fresh: true }); b.f.acknowledge(); } catch { threw = true; }
  check('缺托盘或窗口时安全降级', threw, false);
}
// 输入校验
{
  const t = setup();
  t.f.update({ count: 'abc', fresh: true });
  check('非法 count → 0 且不闪烁', [t.f.getCount(), t.f.isFlashing()], [0, false]);
  t.f.update({ count: 99999, fresh: false });
  check('count 上限 999', t.f.getCount(), 999);
  t.f.update(null);
  check('null 载荷安全', t.f.getCount(), 0);
}

if (failures.length) {
  console.error(`✗ alert-flash-regression：${failures.length} 项失败（通过 ${pass}）`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`✓ alert-flash-regression：${pass} 项断言全部通过`);

// 消息预警 · 托盘闪烁控制器
//
// 规则（用户确认：仅闪烁，无系统通知）：
//   · 有「新增」待回复消息且窗口不在前台 → 托盘图标在「正常图标 / 空白」之间交替闪烁（并在 Windows 上闪任务栏）；
//   · 用户打开 / 聚焦应用窗口（acknowledge）→ 立即停止闪烁；
//   · 待回复数降到 0 → 停止并清空提示；
//   · 数量变化但没有新增（例如处理掉一条）→ 只更新 tooltip，不改变闪烁状态。
// 所有依赖可注入（托盘 / 窗口 / 定时器），便于离线测试；托盘或窗口缺失时一律安全降级。
'use strict';

const FLASH_INTERVAL_MS = 500;

function createAlertFlash(deps) {
  const {
    getTray, getWindow, normalImage, blankImage, tooltipBase,
    platform = process.platform,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = deps;

  let count = 0;
  let timer = null;
  let showBlank = false;

  const tray = () => {
    try { const t = getTray && getTray(); return t && !(t.isDestroyed && t.isDestroyed()) ? t : null; } catch { return null; }
  };
  const win = () => {
    try { const w = getWindow && getWindow(); return w && !(w.isDestroyed && w.isDestroyed()) ? w : null; } catch { return null; }
  };
  const setImage = (img) => { try { const t = tray(); if (t && img) t.setImage(img); } catch { /* 托盘异常不影响业务 */ } };
  const setTooltip = () => {
    try {
      const t = tray();
      if (t) t.setToolTip(count > 0 ? `${tooltipBase} · ${count} 条待回复` : tooltipBase);
    } catch { /* 忽略 */ }
  };

  function isWindowActive() {
    const w = win();
    try { return Boolean(w && w.isVisible() && w.isFocused() && !w.isMinimized()); } catch { return false; }
  }

  function start() {
    if (timer) return;
    showBlank = false;
    timer = setIntervalFn(() => {
      showBlank = !showBlank;
      setImage(showBlank ? blankImage : normalImage);
    }, FLASH_INTERVAL_MS);
    if (platform === 'win32') { try { const w = win(); if (w) w.flashFrame(true); } catch { /* 忽略 */ } }
  }

  function stop() {
    if (timer) { clearIntervalFn(timer); timer = null; }
    showBlank = false;
    setImage(normalImage);
    try { const w = win(); if (w && platform === 'win32') w.flashFrame(false); } catch { /* 忽略 */ }
  }

  /** 渲染层推送：count=当前待回复总数；fresh=本轮是否出现了新增的待回复 */
  function update(payload) {
    const n = Math.max(0, Math.min(999, Math.floor(Number(payload && payload.count) || 0)));
    const fresh = Boolean(payload && payload.fresh);
    count = n;
    setTooltip();
    if (n === 0) { stop(); return { ok: true, flashing: false }; }
    if (fresh && !isWindowActive()) start();
    return { ok: true, flashing: Boolean(timer) };
  }

  /** 用户打开 / 聚焦窗口 = 已看到提示 */
  function acknowledge() { stop(); }

  function dispose() { stop(); }

  return { update, acknowledge, dispose, isFlashing: () => Boolean(timer), getCount: () => count };
}

module.exports = { createAlertFlash, FLASH_INTERVAL_MS };

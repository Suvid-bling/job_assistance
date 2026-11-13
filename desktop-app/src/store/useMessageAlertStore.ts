/**
 * 消息预警 store：定时扫描 BOSS 会话（只读）→ 为「HR 在等我回复」的会话生成草稿卡片 → 闪烁托盘。
 * 绝不发送任何消息。扫描逻辑在 lib/bossclaw/alertCycle.ts（可离线测试），这里只负责定时、持久化与副作用。
 * wt2 只在主进程（safeStorage 加密），本 store 只保存「Cookie 状态」元数据。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafePersistStorage } from '@/lib/persistSafe';
import { electronApi } from '@/lib/electronApi';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useDataStore } from '@/store/useDataStore';
import { useRuntimeLogsStore } from '@/store/useRuntimeLogsStore';
import { generateReply } from '@/lib/bossclaw/greetings';
import { isLockedOut, classifyRiskCode, nextCooldownUntil } from '@/lib/bossclaw/safety';
import {
  DEFAULT_CONTEXT_N, DEFAULT_INTERVAL_MIN, nextDelayMs, normalizeIntervalMin, toChatHistory, lastHrText,
} from '@/lib/bossclaw/chatAlert';
import { pendingCount, runAlertCycle, type AlertCard, type CycleDeps, type CycleStatus } from '@/lib/bossclaw/alertCycle';

export type AlertStatus = 'idle' | 'running' | 'scanning' | 'expired' | 'risk' | 'locked' | 'error' | 'no-cookie';

export interface CookieInfo {
  hasCookie: boolean;
  expired: boolean;
  expiresAt: number | null;
  uid: number | string | null;
  name: string;
}

const NO_COOKIE: CookieInfo = { hasCookie: false, expired: false, expiresAt: null, uid: null, name: '' };

interface MessageAlertState {
  /** 用户是否开启了预警（持久化；启动时 resume() 据此恢复） */
  enabled: boolean;
  cards: AlertCard[];
  handled: Record<string, string>;
  // —— 运行时（不持久化）——
  status: AlertStatus;
  scanning: boolean;
  lastScanAt: number | null;
  message: string;
  cookie: CookieInfo;

  refreshCookie: () => Promise<CookieInfo>;
  saveCookie: (raw: string) => Promise<{ ok: boolean; message?: string }>;
  clearCookie: () => Promise<void>;
  /** 开启并启动定时扫描 */
  start: () => Promise<void>;
  /** 关闭并停止 */
  stop: () => void;
  /** 应用启动时：若上次是开启状态则恢复扫描 */
  resume: () => void;
  scanNow: () => Promise<void>;
  regenerate: (id: string) => Promise<void>;
  updateDraft: (id: string, text: string) => void;
  markHandled: (id: string) => void;
  clearAll: () => void;
}

// 模块级循环状态（单一真值；不受组件卸载影响）
let loopToken = 0;
let cycleRunning = false;

const log = (level: 'info' | 'warn' | 'error' | 'success', msg: string) =>
  useRuntimeLogsStore.getState().addChatLog({ level, stage: 'ai_reply', msg });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function alertConfig() {
  const c = useSettingsStore.getState().config.messageAlert;
  return {
    intervalMin: normalizeIntervalMin(c?.intervalMin ?? DEFAULT_INTERVAL_MIN),
    contextN: Math.min(Math.max(Math.floor(Number(c?.contextN) || DEFAULT_CONTEXT_N), 1), 30),
  };
}

/** 复用现有 LLM 回复生成（简历 / 画像 / 沟通信息 / 模型配置全部沿用） */
async function draftWithLlm(args: { hrMessage: string; history: { fromHr: boolean; text: string }[]; jobTitle: string }) {
  const data = useDataStore.getState();
  const r = await generateReply({
    hrMessage: args.hrMessage,
    chatHistory: args.history,
    jobTitle: args.jobTitle,
    resumeText: data.resumeText,
    profile: data.profile,
    communicationInfo: data.communicationInfo,
    model: useSettingsStore.getState().config.model,
  });
  return { text: r.text, method: r.method, outcome: r.outcome, warning: r.warning };
}

function buildDeps(): CycleDeps {
  return {
    api: {
      scan: () => electronApi.bossAlert.scan() as ReturnType<CycleDeps['api']['scan']>,
      history: (b, s, n) => electronApi.bossAlert.history(b, s, n) as ReturnType<CycleDeps['api']['history']>,
    },
    draft: draftWithLlm,
    contextN: alertConfig().contextN,
    now: () => Date.now(),
    sleep,
    isLockedOut: () => isLockedOut(useSettingsStore.getState().config),
    log,
  };
}

function statusFromCycle(s: CycleStatus): AlertStatus {
  return s === 'ok' ? 'running' : s;
}

export const useMessageAlertStore = create<MessageAlertState>()(
  persist(
    (set, get) => {
      /** 推送托盘闪烁：count=待回复总数，fresh=本轮是否有新增 */
      const pushCount = (fresh: boolean) => {
        void electronApi.bossAlert.setCount(pendingCount(get().cards), fresh);
      };

      /** 跑一轮；循环与「立即扫描」共用，单飞 */
      const runOnce = async (): Promise<CycleStatus | 'busy'> => {
        if (cycleRunning) return 'busy';
        cycleRunning = true;
        set({ scanning: true });
        try {
          const { cards, handled } = get();
          const res = await runAlertCycle(buildDeps(), { cards, handled });
          set({
            cards: res.state.cards,
            handled: res.state.handled,
            lastScanAt: Date.now(),
            message: res.message || '',
            status: statusFromCycle(res.status),
          });
          pushCount(res.fresh > 0);
          if (res.status === 'expired') {
            log('error', `消息预警已停止：${res.message || '登录已失效'}。请重新粘贴 wt2。`);
            set({ cookie: { ...get().cookie, expired: true } });
          } else if (res.status === 'risk') {
            const cfg = useSettingsStore.getState().config;
            useSettingsStore.getState().setConfig({ pausedUntil: nextCooldownUntil(cfg, classifyRiskCode(res.riskCode)) });
            log('error', `消息预警命中风控码 ${res.riskCode}：${res.message || ''}。已停止并进入保护性冷却，请先在 BOSS 官方页面人工核验。`);
          } else if (res.status === 'error') {
            log('warn', `消息预警本轮失败：${res.message || '未知原因'}（下一轮重试）`);
          } else if (res.status === 'locked') {
            log('info', '消息预警：账号处于冷却期，本轮跳过');
          }
          return res.status;
        } finally {
          cycleRunning = false;
          set({ scanning: false });
        }
      };

      const loop = async (token: number) => {
        while (loopToken === token) {
          const status = await runOnce();
          // 登录失效 / 风控 → 不再继续（需用户处理后手动重新开启）
          if (status === 'expired' || status === 'risk') {
            if (loopToken === token) set({ enabled: false });
            return;
          }
          const wait = nextDelayMs(alertConfig().intervalMin);
          for (let waited = 0; waited < wait; waited += 1000) {
            if (loopToken !== token) return;
            await sleep(1000);
          }
        }
      };

      return {
        enabled: false,
        cards: [],
        handled: {},
        status: 'idle',
        scanning: false,
        lastScanAt: null,
        message: '',
        cookie: NO_COOKIE,

        refreshCookie: async () => {
          const s = await electronApi.bossAlert.cookieStatus();
          const info: CookieInfo = s
            ? { hasCookie: s.hasCookie, expired: s.expired, expiresAt: s.expiresAt, uid: s.uid, name: s.name }
            : NO_COOKIE;
          set({ cookie: info });
          return info;
        },

        saveCookie: async (raw) => {
          const r = await electronApi.bossAlert.cookieSet(raw);
          await get().refreshCookie();
          if (r.ok) {
            set({ message: '' });
            log('info', `消息预警：wt2 已验证并加密保存（账号 ${('name' in r && r.name) || ''}）`);
          }
          return { ok: r.ok, message: r.message };
        },

        clearCookie: async () => {
          get().stop();
          await electronApi.bossAlert.cookieClear();
          set({ cookie: NO_COOKIE, status: 'no-cookie' });
        },

        start: async () => {
          const info = await get().refreshCookie();
          if (!info.hasCookie) { set({ enabled: false, status: 'no-cookie', message: '请先粘贴并验证 wt2' }); return; }
          if (info.expired) { set({ enabled: false, status: 'expired', message: 'wt2 已过期，请重新粘贴' }); return; }
          const token = ++loopToken;
          set({ enabled: true, status: 'running', message: '' });
          log('info', `消息预警已开启：每 ${alertConfig().intervalMin} 分钟只读扫描一次（不会发送任何消息）`);
          void loop(token);
        },

        stop: () => {
          loopToken += 1; // 作废进行中的循环
          set({ enabled: false, status: 'idle' });
        },

        resume: () => {
          if (get().enabled && loopToken === 0) void get().start();
        },

        scanNow: async () => {
          const info = await get().refreshCookie();
          if (!info.hasCookie) { set({ status: 'no-cookie', message: '请先粘贴并验证 wt2' }); return; }
          if (info.expired) { set({ status: 'expired', message: 'wt2 已过期，请重新粘贴' }); return; }
          const s = await runOnce();
          if (s === 'busy') set({ message: '正在扫描中，请稍候' });
        },

        regenerate: async (id) => {
          const card = get().cards.find((c) => c.id === id);
          if (!card) return;
          set({ message: '' });
          const h = await electronApi.bossAlert.history(card.bossId, card.securityId, alertConfig().contextN);
          const myUid = get().cookie.uid;
          if (!h.ok || !('messages' in h) || !h.messages || myUid == null) {
            set({ message: `重新生成失败：${h.message || '读取聊天记录失败'}（可能需要先点「立即扫描」刷新）` });
            return;
          }
          const history = toChatHistory(h.messages, myUid, alertConfig().contextN);
          const hrText = lastHrText(h.messages, myUid) || card.hrText;
          const r = await draftWithLlm({ hrMessage: hrText, history, jobTitle: card.jobTitle });
          set((s) => ({
            cards: s.cards.map((c) =>
              c.id === id
                ? { ...c, history, hrText, draft: r.text, method: r.method, rejected: r.outcome === 'hr_rejected', note: r.warning, updatedAt: Date.now() }
                : c),
          }));
          pushCount(false);
        },

        updateDraft: (id, text) =>
          set((s) => ({ cards: s.cards.map((c) => (c.id === id ? { ...c, draft: text } : c)) })),

        markHandled: (id) => {
          set((s) => {
            const card = s.cards.find((c) => c.id === id);
            return {
              cards: s.cards.filter((c) => c.id !== id),
              handled: card ? { ...s.handled, [card.id]: card.lastMsgId } : s.handled,
            };
          });
          pushCount(false);
        },

        clearAll: () => {
          set({ cards: [], handled: {} });
          pushCount(false);
        },
      };
    },
    {
      name: 'bossclaw-message-alert',
      storage: createSafePersistStorage(),
      // 只持久化：开关 / 卡片 / 已处理 msgId。Cookie 元数据与运行态每次启动重新读取。
      partialize: (s) => ({ enabled: s.enabled, cards: s.cards, handled: s.handled }),
      // v1：去掉了模板兜底。旧版本留下的模板草稿卡片（method='local'）直接丢弃，
      // 这些会话未记入 handled，下一轮扫描会用 AI 重新生成。
      version: 1,
      migrate: (persisted, version) => {
        const s = (persisted || {}) as { enabled?: boolean; cards?: { method?: string }[]; handled?: Record<string, string> };
        if (version < 1 && Array.isArray(s.cards)) s.cards = s.cards.filter((c) => c?.method !== 'local');
        return s as unknown as MessageAlertState;
      },
    },
  ),
);

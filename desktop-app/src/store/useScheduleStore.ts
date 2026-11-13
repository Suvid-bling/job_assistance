// 定时任务模块 store（Zustand persist → localStorage，纳入本地备份 BACKUP_KEYS）
// 支持两类动作：定时采集(collect) / 定时备份(backup)。
// （定时投递 deliver 已随浏览器自动投递一并移除；旧数据在 migrate 中清理并提示一次。）
// - collect 通过 collectRequest 请求（可携带目标平台）交由常驻的工作台组件消费触发采集。
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafePersistStorage } from '@/lib/persistSafe';
import type { JobPlatform } from '@/lib/bossclaw/types';

export type ScheduleAction = 'collect' | 'backup';

export interface ScheduleEntry {
  id: string;
  name: string;
  action: ScheduleAction;
  /** 'HH:mm'，仅触发时刻（分）匹配且未在本分钟触发过 */
  time: string;
  /** 0=周日 … 6=周六；空数组=每天 */
  daysOfWeek: number[];
  enabled: boolean;
  /**
   * 目标平台（collect 生效）：空/缺省 = 当前全部已启用平台；
   * 指定后仅处理所选平台（由工作台按序逐个采集）。
   */
  platforms?: JobPlatform[];
  /** 最近一次触发的"目标分钟" epoch（用于去重，防同一分钟重复触发） */
  lastRunStamp: number;
}

/** 定时采集请求（调度器置位，常驻 Workbench 消费后清除）。platforms 空/缺省 = 全部已启用平台。 */
export interface CollectRequest {
  platforms?: JobPlatform[];
  /**
   * 定向采集：「任务进度」页点「开始/继续」时携带，只重跑这些 runId 对应的搜索组合
   * （runId = cr_<platform>_<keyword>_<location>_<employmentType>，见 Workbench.collectRunId）。
   * 空/缺省 = 按 platforms 跑完整搜索队列。
   */
  runIds?: string[];
}

interface ScheduleState {
  entries: ScheduleEntry[];
  /** 待执行的采集请求（调度器置位，Workbench 消费后清除） */
  collectRequest: CollectRequest | null;
  /** 升级时被移除的旧「定时投递」任务数（>0 时定时任务页提示一次，用户确认后清零） */
  droppedDeliver: number;
  dismissDroppedDeliver: () => void;
  addEntry: (e: Omit<ScheduleEntry, 'id' | 'lastRunStamp'>) => ScheduleEntry;
  updateEntry: (id: string, patch: Partial<ScheduleEntry>) => void;
  removeEntry: (id: string) => void;
  toggleEntry: (id: string, enabled: boolean) => void;
  markRun: (id: string, stamp: number) => void;
  setCollectRequest: (r: CollectRequest | null) => void;
}

function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `sched_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export const useScheduleStore = create<ScheduleState>()(
  persist(
    (set) => ({
      entries: [],
      collectRequest: null,
      droppedDeliver: 0,
      dismissDroppedDeliver: () => set({ droppedDeliver: 0 }),
      addEntry: (e) => {
        const entry: ScheduleEntry = { ...e, id: uid(), lastRunStamp: 0 };
        set((s) => ({ entries: [...s.entries, entry] }));
        return entry;
      },
      updateEntry: (id, patch) =>
        set((s) => ({ entries: s.entries.map((x) => (x.id === id ? { ...x, ...patch } : x)) })),
      removeEntry: (id) => set((s) => ({ entries: s.entries.filter((x) => x.id !== id) })),
      toggleEntry: (id, enabled) =>
        set((s) => ({ entries: s.entries.map((x) => (x.id === id ? { ...x, enabled } : x)) })),
      markRun: (id, stamp) =>
        set((s) => ({ entries: s.entries.map((x) => (x.id === id ? { ...x, lastRunStamp: stamp } : x)) })),
      setCollectRequest: (r) => set({ collectRequest: r }),
    }),
    {
      name: 'bossclaw-schedule',
      storage: createSafePersistStorage(),
      // 审查 #7：`collectRequest` 是「待执行的瞬时请求」（调度器置位、常驻工作台消费后清除），
      // 不是可恢复状态 —— 进程若在消费前退出，落盘会让下次启动时工作台挂载 effect 读到并执行，
      // 变成**非用户预期的开机自动采集**（真实网络动作，进入风控口径）。
      // 故只持久化定时任务表 entries，请求永远以 null 冷启动。
      partialize: (s) => ({ entries: s.entries, droppedDeliver: s.droppedDeliver }),
      // v2：浏览器自动投递（含定时投递）已移除 → 清理旧 deliver 任务，并记下数量供页面提示一次。
      version: 2,
      migrate: (persisted, version) => {
        const st = (persisted || {}) as { entries?: Array<ScheduleEntry & { action: string; limitPerRun?: number }>; droppedDeliver?: number };
        if (version < 2) {
          const all = Array.isArray(st.entries) ? st.entries : [];
          const kept = all.filter((e) => e.action === 'collect' || e.action === 'backup').map(({ limitPerRun: _l, ...rest }) => rest as ScheduleEntry);
          return { entries: kept, droppedDeliver: all.length - kept.length };
        }
        return st as { entries: ScheduleEntry[]; droppedDeliver: number };
      },
    }
  )
);

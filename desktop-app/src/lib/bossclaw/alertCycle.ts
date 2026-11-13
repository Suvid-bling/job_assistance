/**
 * 消息预警 · 一轮扫描（无 IO、依赖全部注入，可离线测试）。
 * 流程：scan（阶段 1）→ 对候选逐个读历史（阶段 2）→ 生成草稿 → 更新卡片。
 * 红线：只读；code 7 / 风控码立即停止本轮并上报；单轮最多读 MAX_HISTORY_PER_CYCLE 个会话的历史。
 */
import {
  MAX_HISTORY_PER_CYCLE,
  isRecent,
  jobContext,
  lastHrText,
  needsReply,
  repliedByMe,
  selectCandidates,
  toChatHistory,
  type AlertFriend,
  type AlertMessage,
  type ChatHistoryLine,
} from './chatAlert';

export interface AlertCard {
  /** = HR uid（一个会话一张卡） */
  id: string;
  name: string;
  company: string;
  jobTitle: string;
  salary: string;
  bossId: string;
  /** 最近一次扫描拿到的 securityId（会变化，重新生成草稿时用） */
  securityId: string;
  /** 触发本卡片的 HR 最后一条消息 id */
  lastMsgId: string;
  hrText: string;
  history: ChatHistoryLine[];
  draft: string;
  method: 'ai' | 'none';
  /** AI 判断 HR 已明确拒绝：仅提示，不计入待回复数 */
  rejected: boolean;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CycleState {
  cards: AlertCard[];
  /** uid → 已处理的 msgId（已看过且无需回复 / 用户标记已处理） */
  handled: Record<string, string>;
}

export interface DraftResult {
  text: string;
  method: 'ai' | 'none';
  outcome: 'continue' | 'hr_rejected' | 'declined';
  warning?: string;
}

export interface CycleDeps {
  api: {
    scan(): Promise<{ ok: boolean; code?: number; message?: string; expired?: boolean; risk?: boolean; friends?: AlertFriend[]; myUid?: number | string | null }>;
    history(bossId: string, securityId: string, n: number): Promise<{ ok: boolean; code?: number; message?: string; expired?: boolean; risk?: boolean; messages?: AlertMessage[] }>;
  };
  draft(args: { hrMessage: string; history: ChatHistoryLine[]; jobTitle: string }): Promise<DraftResult>;
  contextN: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  rand?(): number;
  isLockedOut(): boolean;
  log(level: 'info' | 'warn' | 'error' | 'success', msg: string): void;
}

export type CycleStatus = 'ok' | 'expired' | 'risk' | 'locked' | 'error';

export interface CycleResult {
  status: CycleStatus;
  state: CycleState;
  /** 本轮新增（或 HR 又发了新消息）的待回复数 */
  fresh: number;
  riskCode?: number;
  message?: string;
}

/** 待回复数（不含 HR 已拒绝的提示卡） */
export const pendingCount = (cards: AlertCard[]): number => cards.filter((c) => !c.rejected).length;

const HISTORY_GAP_MIN_MS = 1500;
const HISTORY_GAP_SPAN_MS = 2000;

export async function runAlertCycle(deps: CycleDeps, input: CycleState): Promise<CycleResult> {
  const rand = deps.rand || Math.random;
  const state: CycleState = { cards: [...input.cards], handled: { ...input.handled } };
  const done = (status: CycleStatus, extra: Partial<CycleResult> = {}): CycleResult => ({ status, state, fresh: 0, ...extra });

  if (deps.isLockedOut()) return done('locked', { message: '账号处于风控冷却期，本轮不扫描' });

  const scan = await deps.api.scan();
  if (!scan.ok) {
    if (scan.expired || scan.code === 7) return done('expired', { message: scan.message || '登录已失效，请重新粘贴 wt2' });
    if (scan.risk) return done('risk', { riskCode: scan.code, message: scan.message || '触发风控，已停止' });
    return done('error', { message: scan.message || '扫描失败' });
  }
  const friends = scan.friends || [];
  const myUid = scan.myUid;
  const now = deps.now();

  // 我方已回复 → 卡片作废（HR 之后若再发新消息会重新成为候选）
  if (myUid != null) {
    const repliedUids = new Set(friends.filter((f) => repliedByMe(f, myUid)).map((f) => String(f.uid)));
    state.cards = state.cards.filter((c) => !repliedUids.has(c.id));
  }

  // 时间窗：最后一条消息已超出最近 N 天（见 MAX_MESSAGE_AGE_DAYS）的会话 → 卡片移除、不再核对
  const staleUids = new Set(friends.filter((f) => !isRecent(f, now)).map((f) => String(f.uid)));
  state.cards = state.cards.filter((c) => !staleUids.has(c.id));

  // 已有同一条消息的卡片 → 不再重复读历史 / 生成草稿
  const carded = new Map(state.cards.map((c) => [c.id, c.lastMsgId]));
  const candidates = selectCandidates(friends, state.handled, { now })
    .filter((f) => carded.get(String(f.uid)) !== String(f.lastMessageInfo?.msgId ?? ''))
    .sort((a, b) => Number(b.lastMessageInfo?.msgTime || 0) - Number(a.lastMessageInfo?.msgTime || 0));

  if (!candidates.length) return done('ok');
  if (myUid == null) return done('error', { message: '未能确定当前账号 uid，请重新验证 wt2' });

  const batch = candidates.slice(0, MAX_HISTORY_PER_CYCLE);
  if (candidates.length > batch.length) {
    deps.log('info', `预警：本轮有 ${candidates.length} 个会话待核对，先处理最新 ${batch.length} 个，其余留到下一轮`);
  }

  let fresh = 0;
  for (let i = 0; i < batch.length; i += 1) {
    const f = batch[i];
    const uid = String(f.uid);
    const msgId = String(f.lastMessageInfo?.msgId ?? '');
    if (i > 0) await deps.sleep(HISTORY_GAP_MIN_MS + Math.floor(rand() * HISTORY_GAP_SPAN_MS));

    const h = await deps.api.history(String(f.encryptBossId), String(f.securityId), deps.contextN);
    if (!h.ok) {
      if (h.expired || h.code === 7) return done('expired', { fresh, message: h.message || '登录已失效，请重新粘贴 wt2' });
      if (h.risk) return done('risk', { fresh, riskCode: h.code, message: h.message || '触发风控，已停止' });
      deps.log('warn', `预警：读取「${f.name || uid}」聊天记录失败（${h.message || '未知原因'}），下一轮重试`);
      continue;
    }
    const msgs = h.messages || [];

    // 阶段 2：剔除卡片 / 系统文案后，最后一条真人文字是否仍来自 HR
    if (!needsReply(msgs, myUid)) {
      state.handled[uid] = msgId;
      state.cards = state.cards.filter((c) => c.id !== uid);
      continue;
    }

    const history = toChatHistory(msgs, myUid, deps.contextN);
    const hrText = lastHrText(msgs, myUid);
    const job = jobContext(msgs);
    let reply: DraftResult;
    try {
      reply = await deps.draft({ hrMessage: hrText, history, jobTitle: job.title });
    } catch (e) {
      reply = { text: '', method: 'none', outcome: 'continue', warning: `AI 草稿生成失败：${(e as Error)?.message || e}` };
    }
    if (reply.method !== 'ai') deps.log('warn', `预警：「${f.name || uid}」AI 草稿未生成（${reply.warning || '未知原因'}）`);

    // AI 判断无需回复（系统提示 / 表情 / 无实质内容）：记为已处理，不出卡片
    if (reply.outcome !== 'hr_rejected' && !reply.text && reply.method === 'ai') {
      state.handled[uid] = msgId;
      state.cards = state.cards.filter((c) => c.id !== uid);
      continue;
    }

    const prev = state.cards.find((c) => c.id === uid);
    const t = deps.now();
    const rejected = reply.outcome === 'hr_rejected';
    const card: AlertCard = {
      id: uid,
      name: String(f.name || ''),
      company: String(f.brandName || job.company || ''),
      jobTitle: job.title,
      salary: job.salary,
      bossId: String(f.encryptBossId),
      securityId: String(f.securityId),
      lastMsgId: msgId,
      hrText,
      history,
      draft: rejected ? '' : reply.text,
      method: reply.method,
      rejected,
      note: rejected ? 'AI 判断 HR 已明确拒绝，无需回复' : reply.warning,
      createdAt: prev ? prev.createdAt : t,
      updatedAt: t,
    };
    state.cards = prev ? state.cards.map((c) => (c.id === uid ? card : c)) : [card, ...state.cards];
    if (!rejected) fresh += 1;
    deps.log('success', `预警：「${card.name || uid}」等你回复：${hrText.slice(0, 40)}`);
  }
  return done('ok', { fresh });
}

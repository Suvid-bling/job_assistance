/**
 * 消息预警：BOSS 会话「谁在等我回复」的纯规则（无 IO，可离线测试）。
 * 数据口径见 doc/boss_chatapi.md。两阶段判定：
 *   阶段 1（廉价）：好友列表里 lastMessageInfo.fromId === HR uid 且 msgId 变化 → 候选；
 *   阶段 2（确认）：读最近消息，剔除卡片 / 系统文案后，最后一条真人文字仍来自 HR → 需回复。
 * unreadMsgCount 实测恒为 0，不可用作判据。
 */

export interface AlertFriend {
  uid: number | string;
  name?: string;
  brandName?: string;
  title?: string;
  encryptBossId: string;
  securityId: string;
  lastMsg?: string;
  /** 最后一条消息时间（毫秒），与 lastMessageInfo.msgTime 同义 */
  lastTS?: number;
  lastMessageInfo?: {
    msgId?: number | string;
    fromId?: number | string;
    toId?: number | string;
    msgTime?: number;
    showText?: string;
  };
}

export interface AlertMessage {
  mid: number | string;
  time: number;
  from: { uid: number | string; name?: string };
  to?: { uid: number | string };
  type?: number;
  body?: {
    type?: number;
    text?: string;
    headTitle?: string;
    jobDesc?: {
      title?: string;
      salary?: string;
      company?: string;
      city?: string;
    };
  };
}

export interface ChatHistoryLine {
  fromHr: boolean;
  text: string;
}

export interface AlertJobContext {
  title: string;
  salary: string;
  company: string;
  city: string;
}

/** BOSS 以 HR 名义发出的系统文案（不是真人说话）；与 test/test_boss_chat_api.py 同源 */
const SYSTEM_TEXT_RE =
  /附件简历|对方已同意|对方已查看|已发送给Boss|已发送给对方|请求交换|交换(微信|电话|简历)|^\S+\.(pdf|docx?|png|jpe?g)$/i;

export const MIN_INTERVAL_MIN = 5;
export const INTERVAL_OPTIONS_MIN = [5, 10, 15, 30, 60] as const;
export const DEFAULT_INTERVAL_MIN = 10;
export const DEFAULT_CONTEXT_N = 10;
/** 单轮最多读取多少个会话的历史（防止风暴与被风控盯上） */
export const MAX_HISTORY_PER_CYCLE = 10;
/** 只关注最近 N 天内 HR 发来的消息；更早的会话不读历史、不出卡片 */
export const MAX_MESSAGE_AGE_DAYS = 3;
export const MAX_MESSAGE_AGE_MS = MAX_MESSAGE_AGE_DAYS * 24 * 60 * 60 * 1000;

/** 会话最后一条消息的时间（毫秒）；缺失返回 0 */
export function lastMessageTime(friend: AlertFriend): number {
  const t = Number(friend?.lastMessageInfo?.msgTime || friend?.lastTS || 0);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/** 最后一条消息是否在时间窗内；拿不到时间的会话视为不在窗内（无法确认是否近期） */
export function isRecent(friend: AlertFriend, now: number, maxAgeMs: number = MAX_MESSAGE_AGE_MS): boolean {
  const t = lastMessageTime(friend);
  return t > 0 && now - t <= maxAgeMs;
}

const sameId = (a: unknown, b: unknown): boolean =>
  a != null && b != null && String(a) !== '' && String(a) === String(b);

/** 是否为「真人文字」：body.type===1、非空、且不是系统文案 */
export function isRealText(msg: AlertMessage): boolean {
  const body = msg?.body;
  const text = String(body?.text ?? '').trim();
  return body?.type === 1 && text.length > 0 && !SYSTEM_TEXT_RE.test(text);
}

/** 阶段 1：HR 发了最后一条，且该 msgId 尚未处理过；传入 now 时只保留时间窗内的会话 */
export function selectCandidates(
  friends: AlertFriend[],
  handled: Record<string, string>,
  opts: { now?: number; maxAgeMs?: number } = {},
): AlertFriend[] {
  const out: AlertFriend[] = [];
  for (const f of friends || []) {
    const last = f?.lastMessageInfo;
    if (!f?.encryptBossId || !f?.securityId || !last) continue;
    if (!sameId(last.fromId, f.uid)) continue;
    if (handled[String(f.uid)] === String(last.msgId ?? '')) continue;
    if (opts.now != null && !isRecent(f, opts.now, opts.maxAgeMs)) continue;
    out.push(f);
  }
  return out;
}

/** 阶段 1 的反向：我方已回复（最后一条来自我）→ 对应卡片应移除 */
export function repliedByMe(friend: AlertFriend, myUid: number | string): boolean {
  return sameId(friend?.lastMessageInfo?.fromId, myUid);
}

/** 阶段 2：最后一条真人文字来自 HR → 需要回复 */
export function needsReply(msgs: AlertMessage[], myUid: number | string): boolean {
  const real = (msgs || []).filter(isRealText);
  if (!real.length) return false;
  return !sameId(real[real.length - 1].from?.uid, myUid);
}

/** 转成 generateReply 的 chatHistory（早→晚，最近 n 条真人文字） */
export function toChatHistory(
  msgs: AlertMessage[],
  myUid: number | string,
  n: number,
): ChatHistoryLine[] {
  const limit = Math.min(Math.max(Math.floor(Number(n) || DEFAULT_CONTEXT_N), 1), 30);
  return (msgs || [])
    .filter(isRealText)
    .slice(-limit)
    .map((m) => ({ fromHr: !sameId(m.from?.uid, myUid), text: String(m.body?.text ?? '').trim() }));
}

/** HR 最后一条真人文字 */
export function lastHrText(msgs: AlertMessage[], myUid: number | string): string {
  const real = (msgs || []).filter(isRealText);
  for (let i = real.length - 1; i >= 0; i -= 1) {
    if (!sameId(real[i].from?.uid, myUid)) return String(real[i].body?.text ?? '').trim();
  }
  return '';
}

/** 从职位卡片（body.type===8）读取岗位信息 */
export function jobContext(msgs: AlertMessage[]): AlertJobContext {
  for (const m of msgs || []) {
    const jd = m?.body?.type === 8 ? m.body.jobDesc : undefined;
    if (jd) {
      return {
        title: String(jd.title ?? ''),
        salary: String(jd.salary ?? ''),
        company: String(jd.company ?? ''),
        city: String(jd.city ?? ''),
      };
    }
  }
  return { title: '', salary: '', company: '', city: '' };
}

/**
 * 解析用户粘贴的 wt2：可以是纯值，也可以是整行 `wt2=xxx; Domain=...; Expires=...`。
 * 返回 null 表示格式不合法。expiresAt 为毫秒时间戳（取不到为 null）。
 */
export function parseCookieInput(raw: string): { value: string; expiresAt: number | null } | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let value = text;
  let expiresAt: number | null = null;
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

/** 把用户设置的间隔夹到合法范围（不小于 5 分钟） */
export function normalizeIntervalMin(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MIN;
  return Math.max(MIN_INTERVAL_MIN, Math.min(n, 240));
}

/** 下一轮等待毫秒：间隔 ±20% 抖动（避免固定节拍） */
export function nextDelayMs(intervalMin: number, rand: () => number = Math.random): number {
  const base = normalizeIntervalMin(intervalMin) * 60_000;
  return Math.round(base * (0.8 + rand() * 0.4));
}

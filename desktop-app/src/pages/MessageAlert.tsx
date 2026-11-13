/**
 * 【主模块：消息预警】导航 key = 'autochat'（沿用旧 key，保证已保存的路由 / 控制桥 navigate 不失效）
 * 只读：定时经 HTTP 接口扫描 BOSS 会话，为「HR 在等我回复」的会话生成回复草稿，托盘图标闪烁提醒。
 * 绝不发送任何消息 —— 草稿由用户复制后自己到 BOSS 粘贴发送。无任何浏览器自动化。
 * 子模块：
 * - 页头状态栏（监听状态 / Cookie 状态 / 上次扫描 / 待回复数）
 * - 待回复列表（每个会话一张卡：对方最新消息、最近对话、可编辑草稿、复制 / 重新生成 / 已处理 / 打开 BOSS）
 * - 预警设置（开关 / 扫描间隔 / 上下文条数 / wt2 Cookie）
 * - 沟通信息（AI 草稿引用：薪资期望 / 面试时间等人工填写）
 * - 预警日志
 */
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Input, InputNumber, Select, Space, Switch, Tag, Typography, message } from 'antd';
import {
  BellOutlined, CheckOutlined, CodeOutlined, CopyOutlined, DeleteOutlined, LockOutlined,
  ReloadOutlined, SyncOutlined, LinkOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import { useShallow } from 'zustand/react/shallow';
import { useMessageAlertStore } from '@/store/useMessageAlertStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useDataStore } from '@/store/useDataStore';
import { useRuntimeLogsStore } from '@/store/useRuntimeLogsStore';
import { electronApi } from '@/lib/electronApi';
import { isLockedOut, cooldownRemaining } from '@/lib/bossclaw/safety';
import { INTERVAL_OPTIONS_MIN, DEFAULT_INTERVAL_MIN, DEFAULT_CONTEXT_N, normalizeIntervalMin } from '@/lib/bossclaw/chatAlert';
import { pendingCount, type AlertCard } from '@/lib/bossclaw/alertCycle';
import { EmptyState } from '@/components/feedback';
import { ChatLogPanel } from '@/components/ChatLogPanel';

const { Text, Paragraph } = Typography;

const BOSS_CHAT_URL = 'https://www.zhipin.com/web/geek/chat';

const fmtTime = (t: number | null): string =>
  t ? new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '尚未扫描';
const fmtDate = (t: number | null): string => (t ? new Date(t).toLocaleDateString('zh-CN') : '');

function ago(t: number): string {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} 小时前` : `${Math.round(h / 24)} 天前`;
}

function AlertCardView({ card }: { card: AlertCard }) {
  const updateDraft = useMessageAlertStore((s) => s.updateDraft);
  const markHandled = useMessageAlertStore((s) => s.markHandled);
  const regenerate = useMessageAlertStore((s) => s.regenerate);
  const [busy, setBusy] = useState(false);

  const copy = async () => {
    if (!card.draft.trim()) { message.warning('草稿为空，无可复制内容'); return; }
    const ok = await electronApi.copyText(card.draft);
    if (ok) message.success('已复制到剪贴板，请到 BOSS 粘贴并自行发送');
    else message.error('复制失败，请手动选中文本复制');
  };
  const redo = async () => { setBusy(true); try { await regenerate(card.id); } finally { setBusy(false); } };

  return (
    <div className={'job-card malert-card' + (card.rejected ? ' is-rejected' : '')}>
      <div className="malert-card__head">
        <div className="malert-card__who">
          <span className="malert-card__name">{card.name || 'HR'}</span>
          <span className="malert-card__meta">
            {[card.company, card.jobTitle, card.salary].filter(Boolean).join(' · ')}
          </span>
        </div>
        <Space size={6}>
          {card.rejected ? <Tag color="orange">HR 已拒绝</Tag> : null}
          {!card.rejected && card.method === 'ai' ? <Tag color="cyan">AI 草稿</Tag> : null}
          {!card.rejected && card.method !== 'ai' ? <Tag color="red">AI 未生成</Tag> : null}
          <Text type="secondary" style={{ fontSize: 12 }}>{ago(card.updatedAt)}</Text>
        </Space>
      </div>

      <div className="malert-hr" aria-label="对方最新消息">
        <span className="malert-hr__label">对方：</span>{card.hrText}
      </div>

      {card.history.length > 1 ? (
        <details className="malert-history">
          <summary>最近对话（{card.history.length} 条）</summary>
          <ul>
            {card.history.map((m, i) => (
              <li key={`${card.id}:${i}:${m.text.slice(0, 16)}`} className={m.fromHr ? 'is-hr' : 'is-me'}>
                <b>{m.fromHr ? 'HR' : '我'}：</b>{m.text}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {card.note ? <div className="malert-note">{card.note}</div> : null}

      {card.rejected ? null : (
        <Input.TextArea
          value={card.draft}
          onChange={(e) => updateDraft(card.id, e.target.value)}
          autoSize={{ minRows: 2, maxRows: 8 }}
          aria-label="回复草稿（可编辑）"
          placeholder="（草稿为空：可点「重新生成」）"
          style={{ borderRadius: 8, fontSize: 13 }}
        />
      )}

      <div className="malert-actions">
        {card.rejected ? null : (
          <Button type="primary" icon={<CopyOutlined />} onClick={copy}>复制</Button>
        )}
        {card.rejected ? null : (
          <Button icon={<SyncOutlined />} loading={busy} onClick={redo}>重新生成</Button>
        )}
        <Button icon={<LinkOutlined />} onClick={() => electronApi.external.open(BOSS_CHAT_URL)}>打开 BOSS</Button>
        <Button icon={<CheckOutlined />} onClick={() => markHandled(card.id)}>已处理</Button>
      </div>
    </div>
  );
}

export default function MessageAlert() {
  const {
    enabled, cards, status, scanning, lastScanAt, message: statusMessage, cookie,
  } = useMessageAlertStore(useShallow((s) => ({
    enabled: s.enabled, cards: s.cards, status: s.status, scanning: s.scanning,
    lastScanAt: s.lastScanAt, message: s.message, cookie: s.cookie,
  })));
  const start = useMessageAlertStore((s) => s.start);
  const stop = useMessageAlertStore((s) => s.stop);
  const scanNow = useMessageAlertStore((s) => s.scanNow);
  const saveCookie = useMessageAlertStore((s) => s.saveCookie);
  const clearCookie = useMessageAlertStore((s) => s.clearCookie);
  const refreshCookie = useMessageAlertStore((s) => s.refreshCookie);
  const clearAll = useMessageAlertStore((s) => s.clearAll);

  const config = useSettingsStore(useShallow((s) => s.config));
  const setConfig = useSettingsStore((s) => s.setConfig);
  const communicationInfo = useDataStore((s) => s.communicationInfo);
  const setCommunicationInfo = useDataStore((s) => s.setCommunicationInfo);
  const chatLogs = useRuntimeLogsStore(useShallow((s) => s.chatLogs));
  const clearChatLogs = useRuntimeLogsStore((s) => s.clearChatLogs);

  const [cookieInput, setCookieInput] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { void refreshCookie(); }, [refreshCookie]);

  const intervalMin = normalizeIntervalMin(config.messageAlert?.intervalMin ?? DEFAULT_INTERVAL_MIN);
  const contextN = config.messageAlert?.contextN ?? DEFAULT_CONTEXT_N;
  const setAlertCfg = (patch: Partial<NonNullable<typeof config.messageAlert>>) =>
    setConfig({ messageAlert: { intervalMin, contextN, ...patch } });

  const pending = pendingCount(cards);
  const cookieOk = cookie.hasCookie && !cookie.expired;
  const logs = useMemo(() => chatLogs.filter((l) => l.stage === 'ai_reply'), [chatLogs]);
  const desktop = electronApi.bossAlert.available();

  const onSaveCookie = async () => {
    if (!cookieInput.trim()) { message.warning('请先粘贴 wt2'); return; }
    setSaving(true);
    try {
      const r = await saveCookie(cookieInput);
      if (r.ok) { setCookieInput(''); message.success('wt2 已验证并加密保存'); }
      else message.error(r.message || '验证失败');
    } finally { setSaving(false); }
  };

  const onToggle = (on: boolean) => { if (on) void start(); else stop(); };

  return (
    <main className="page" aria-label="消息预警">
      <header className="page-head">
        <div>
          <h1 className="page-title">
            <BellOutlined className="page-title-icon" aria-hidden="true" />消息预警
          </h1>
          <Paragraph className="page-sub">
            定时只读扫描 BOSS 会话：HR 在等你回复时，用你的简历与沟通信息生成回复草稿，并让托盘图标闪烁提醒。
            应用不会替你发送任何消息，请复制草稿后到 BOSS 自行发送。
          </Paragraph>
        </div>
        <div className="page-head-extra">
          <Space size={8} wrap>
            <span className={`status-pill ${enabled && status !== 'expired' && status !== 'risk' ? 'is-ready' : 'is-warning'}`}>
              <span className="led-dot" />{enabled ? (scanning ? '扫描中…' : '监听中') : '已停止'}
            </span>
            <span className={`status-pill ${cookieOk ? 'is-ready' : cookie.hasCookie ? 'is-danger' : 'is-warning'}`}>
              <span className="led-dot" />
              {cookieOk ? `Cookie 有效${cookie.expiresAt ? ` · ${fmtDate(cookie.expiresAt)} 到期` : ''}` : cookie.hasCookie ? 'Cookie 已过期' : '未设置 Cookie'}
            </span>
            <span className="status-pill"><span className="led-dot" />上次扫描 {fmtTime(lastScanAt)}</span>
            <span className={`status-pill ${pending > 0 ? 'is-danger' : 'is-ready'}`}>
              <span className="led-dot" />待回复 {pending}
            </span>
          </Space>
        </div>
      </header>

      <div className="malert-grid">
        <div className="malert-main">
          {!desktop ? (
            <Alert type="info" showIcon message="消息预警需要桌面版（Electron）" description="浏览器预览模式下无法保存 Cookie 或访问 BOSS 接口。" />
          ) : null}
          {isLockedOut(config) ? (
            <Alert type="warning" showIcon message={`账号处于风控冷却期，剩余约 ${Math.ceil(cooldownRemaining(config) / 60000)} 分钟，期间不会扫描`} />
          ) : null}
          {statusMessage && (status === 'expired' || status === 'risk' || status === 'error' || status === 'no-cookie') ? (
            <Alert type={status === 'error' ? 'warning' : 'error'} showIcon message={statusMessage} />
          ) : null}

          <Card
            size="small"
            className="setting-card malert-list-card"
            title={
              <div className="malert-list-title">
                <span><BellOutlined style={{ color: 'var(--brand)', marginRight: 8 }} />待回复消息</span>
                <Space size={8}>
                  <Tag color={pending > 0 ? 'red' : 'default'} style={{ margin: 0, borderRadius: 10, fontWeight: 600 }}>{pending} 条</Tag>
                  <Button size="small" icon={<ReloadOutlined />} loading={scanning} onClick={() => void scanNow()}>立即扫描</Button>
                  {cards.length ? <Button size="small" icon={<DeleteOutlined />} onClick={clearAll}>清空</Button> : null}
                </Space>
              </div>
            }
          >
            {cards.length === 0 ? (
              <EmptyState
                title="暂无待回复消息"
                description={enabled ? '监听中：HR 发来需要回复的消息时，这里会出现草稿卡片，托盘图标会闪烁。' : '在右侧粘贴 wt2 并开启预警后，这里会显示 HR 在等你回复的会话。'}
              />
            ) : (
              <div className="malert-list">
                {cards.map((c) => <AlertCardView key={c.id} card={c} />)}
              </div>
            )}
          </Card>
        </div>

        <div className="malert-side">
          <Card size="small" className="setting-card" title={<><ThunderboltOutlined style={{ color: 'var(--brand)', marginRight: 6 }} /> 预警设置</>}>
            <div className="setting-row">
              <div className="setting-row__main">
                <div className="setting-row__label">开启消息预警</div>
                <div className="setting-row__desc">按下方间隔只读扫描；不会点击、输入或发送任何内容</div>
              </div>
              <div className="setting-row__control">
                <Switch checked={enabled} onChange={onToggle} disabled={!desktop} aria-label="开启消息预警" />
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-row__main">
                <div className="setting-row__label">扫描间隔</div>
                <div className="setting-row__desc">间隔越长请求越少，对账号越安全；最短 5 分钟</div>
              </div>
              <div className="setting-row__control">
                <Select
                  value={intervalMin}
                  style={{ width: 112 }}
                  onChange={(v) => setAlertCfg({ intervalMin: v })}
                  options={INTERVAL_OPTIONS_MIN.map((m) => ({ value: m, label: `${m} 分钟` }))}
                  aria-label="扫描间隔"
                />
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-row__main">
                <div className="setting-row__label">上下文条数</div>
                <div className="setting-row__desc">每个会话带给 AI 的最近真人消息条数（3–30）</div>
              </div>
              <div className="setting-row__control">
                <InputNumber min={3} max={30} value={contextN} onChange={(v) => setAlertCfg({ contextN: Math.min(30, Math.max(3, Number(v) || DEFAULT_CONTEXT_N)) })} style={{ width: 80 }} aria-label="上下文条数" />
              </div>
            </div>
          </Card>

          <Card size="small" className="setting-card" title={<><LockOutlined style={{ color: 'var(--brand)', marginRight: 6 }} /> BOSS Cookie（wt2）</>}>
            <Paragraph type="secondary" style={{ margin: '0 0 8px', fontSize: 12 }}>
              在已登录的 BOSS 页面按 F12 → 应用 → Cookie 复制 <code>wt2</code>，可直接粘贴整行。
              保存时只验证一次登录；加密存放在本机主进程，保存后不会再显示。有效期约 8 天，到期需重新粘贴。
            </Paragraph>
            {cookie.hasCookie ? (
              <div className="malert-cookie-state">
                <Tag color={cookieOk ? 'green' : 'red'}>{cookieOk ? '有效' : '已过期'}</Tag>
                <Text>{cookie.name || '已保存'}</Text>
                {cookie.expiresAt ? <Text type="secondary" style={{ fontSize: 12 }}>到期 {fmtDate(cookie.expiresAt)}</Text> : null}
                <Button size="small" danger onClick={() => void clearCookie()}>清除</Button>
              </div>
            ) : null}
            <Space.Compact style={{ width: '100%' }}>
              <Input.Password
                value={cookieInput}
                onChange={(e) => setCookieInput(e.target.value)}
                onPressEnter={() => void onSaveCookie()}
                placeholder="粘贴 wt2 的值"
                autoComplete="off"
                aria-label="wt2 Cookie"
                disabled={!desktop}
              />
              <Button type="primary" loading={saving} onClick={() => void onSaveCookie()} disabled={!desktop}>保存并验证</Button>
            </Space.Compact>
          </Card>

          <Card size="small" className="setting-card" title={<><CodeOutlined style={{ color: 'var(--brand)', marginRight: 6 }} /> 沟通信息（草稿引用）</>}>
            <Paragraph type="secondary" style={{ margin: '0 0 8px', fontSize: 12 }}>
              填写要提供给 HR 的真实信息（薪资期望、面试时间、到岗时间等）。生成草稿时会引用其中的内容；留空则不承诺任何这类信息。输入后自动保存。
            </Paragraph>
            <Input.TextArea
              value={communicationInfo}
              onChange={(e) => setCommunicationInfo(e.target.value)}
              rows={4}
              placeholder={'例：\n薪资期望：XK 或面议\n可面试时间：本周工作日晚上或周末\n可到岗时间：随时可到岗'}
              style={{ fontSize: 12, lineHeight: 1.6, borderRadius: 8, background: 'var(--bg)' }}
            />
          </Card>

          <ChatLogPanel logs={logs} onClear={clearChatLogs} isRunning={scanning} maxHeight={240} />
        </div>
      </div>
    </main>
  );
}

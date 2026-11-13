/**
 * 【主模块：定时任务】导航 key = 'schedule'
 * 子模块：
 * - 任务列表（定时任务卡：开启/时段/周期/平台/上次触发，编辑与删除）
 * - 动作类型二选：定时采集（collect）/ 定时备份（backup）——见 ACTION_META（定时投递已随浏览器自动投递一并移除）
 * - 新建/编辑任务弹窗（DraftTask 表单：名称/动作/时间/周几/平台）
 */
import { useState } from 'react';
import {
  Button, Card, Alert, Input, Modal, Select, Space, Switch, Tag, TimePicker, Typography, message,
} from 'antd';
import {
  ClockCircleOutlined,
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  SearchOutlined,
  SaveOutlined,
  ScheduleOutlined,
} from '@ant-design/icons';
import { useScheduleStore, type ScheduleAction, type ScheduleEntry } from '@/store/useScheduleStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { PLATFORM_IDS, platformEnabled, platformLabel, type JobPlatform } from '@/lib/bossclaw/platforms';
import { EmptyState } from '@/components/feedback';
import dayjs from 'dayjs';

const { Text, Paragraph } = Typography;

const ACTION_META: Record<ScheduleAction, { label: string; color: string; icon: React.ReactNode; desc: string }> = {
  collect: { label: '定时采集', color: 'blue', icon: <SearchOutlined />, desc: '到点自动执行搜索采集并入库岗位（需工作台引擎可用）。' },
  backup: { label: '定时备份', color: 'orange', icon: <SaveOutlined />, desc: '到点把 localStorage（岗位/简历/日志）备份到所选备份目录；内容不变不重写。' },
};

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEKDAY_OPTIONS = WEEKDAY_LABELS.map((label, value) => ({ label, value }));

function formatLastRun(stamp: number): string {
  if (!stamp) return '未触发';
  return dayjs(stamp).format('MM-DD HH:mm');
}

function weekdayText(days: number[]): string {
  if (!days || days.length === 0) return '每天';
  // 必须复制后再排序：`days` 直接来自 store 的持久化数据（ScheduleEntry.daysOfWeek），
  // 原地 sort 会在**渲染期静默重排持久化数组**（见审查 #62）。
  return [...days].sort((a, b) => a - b).map((d) => WEEKDAY_LABELS[d]).join('/');
}

interface DraftTask {
  name: string;
  action: ScheduleAction;
  time: string;
  daysOfWeek: number[];
  platforms: JobPlatform[];
  enabled: boolean;
}

const EMPTY_DRAFT: DraftTask = {
  name: '',
  action: 'collect',
  time: '09:00',
  daysOfWeek: [],
  platforms: [],
  enabled: true,
};

export default function ScheduleTasks() {
  const entries = useScheduleStore((s) => s.entries);
  const addEntry = useScheduleStore((s) => s.addEntry);
  const updateEntry = useScheduleStore((s) => s.updateEntry);
  const removeEntry = useScheduleStore((s) => s.removeEntry);
  const toggleEntry = useScheduleStore((s) => s.toggleEntry);
  const droppedDeliver = useScheduleStore((s) => s.droppedDeliver);
  const dismissDroppedDeliver = useScheduleStore((s) => s.dismissDroppedDeliver);
  const config = useSettingsStore((s) => s.config);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftTask>(EMPTY_DRAFT);
  const patchDraft = (p: Partial<DraftTask>) => setDraft((d) => ({ ...d, ...p }));

  const showPlatformScope = draft.action === 'collect';

  // 页头「新建定时任务」打开时重置草稿
  const onOpenNew = () => {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setOpen(true);
  };

  const onOpenEdit = (e: ScheduleEntry) => {
    setEditingId(e.id);
    setDraft({
      name: e.name,
      action: e.action,
      time: e.time || '09:00',
      daysOfWeek: e.daysOfWeek || [],
      platforms: e.platforms || [],
      enabled: e.enabled,
    });
    setOpen(true);
  };

  const onSave = () => {
    const name = draft.name.trim();
    if (!name) { message.warning('请填写任务名称'); return; }
    if (!/^\d{1,2}:\d{2}$/.test(draft.time) || !dayjs(draft.time, 'HH:mm').isValid()) {
      message.warning('请选择有效的触发时刻'); return;
    }
    const body = {
      name,
      action: draft.action,
      time: draft.time,
      daysOfWeek: draft.daysOfWeek,
      platforms: showPlatformScope ? draft.platforms : [],
      enabled: draft.enabled,
    };
    if (editingId) {
      updateEntry(editingId, body);
      message.success(`已保存定时任务「${name}」`);
    } else {
      addEntry(body);
      message.success(`已创建定时任务「${name}」`);
    }
    setOpen(false);
  };

  const onDelete = (e: { id: string; name: string }) => {
    Modal.confirm({
      title: `删除定时任务「${e.name}」？`,
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => {
        removeEntry(e.id);
        message.success('已删除');
      },
    });
  };

  // 平台范围文本（空 = 全部已启用平台）
  const scopeText = (e: ScheduleEntry) => {
    if (e.action === 'backup') return '备份本地数据目录';
    const pf = e.platforms?.length ? e.platforms.map((p) => platformLabel(p)).join('、') : '全部启用平台';
    return pf;
  };

  const platformOptions = PLATFORM_IDS.map((id) => ({
    value: id,
    label: platformEnabled(config, id) ? platformLabel(id) : `${platformLabel(id)}（未启用）`,
  }));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <ScheduleOutlined className="page-title-icon" />定时任务
          </h1>
          <p className="page-sub">按设定的时刻自动触发「采集 / 备份」，需保持应用运行（最小化也生效）。</p>
        </div>
        <div className="page-head-extra">
          <Button type="primary" className="btn-uniform" icon={<PlusOutlined />} onClick={onOpenNew}>
            新建定时任务
          </Button>
        </div>
      </div>

      {droppedDeliver > 0 && (
        <Alert
          type="info"
          showIcon
          closable
          onClose={dismissDroppedDeliver}
          style={{ marginBottom: 16, borderRadius: 8 }}
          message={`已移除 ${droppedDeliver} 个旧的「定时投递」任务`}
          description="浏览器自动投递已被「消息预警」取代，定时投递不再可用。定时采集与定时备份不受影响。"
        />
      )}
      <Card
        size="small"
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ClockCircleOutlined style={{ color: 'var(--brand)' }} />
            <span>定时任务列表</span>
          </div>
        }
        extra={<Text type="secondary" style={{ fontSize: 12 }}>{entries.length} 项</Text>}
      >
        {entries.length === 0 ? (
          <EmptyState
            title="尚未创建定时任务"
            description="点击右上角「新建定时任务」，设定采集 / 备份的触发时刻、目标平台与频率"
            action={<Button type="primary" icon={<PlusOutlined />} onClick={onOpenNew}>新建定时任务</Button>}
          />
        ) : (
          <div>
            {entries.map((e) => {
              const meta = ACTION_META[e.action];
              return (
                <div key={e.id} className="task-row">
                  <div style={{ minWidth: 220 }}>
                    <Space size={6} wrap>
                      <Text strong style={{ fontSize: 14 }}>{e.name}</Text>
                      <Tag color={meta.color} icon={meta.icon} style={{ margin: 0, padding: '1px 8px', borderRadius: 999 }}>{meta.label}</Tag>
                      {e.action === 'collect' && (
                        <Tag color={e.platforms?.length ? 'cyan' : 'default'} style={{ margin: 0, padding: '1px 8px', borderRadius: 999 }}>
                          {e.platforms?.length ? e.platforms.map((p) => platformLabel(p)).join('/') : '全部平台'}
                        </Tag>
                      )}
                    </Space>
                    <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
                      {e.time} · {weekdayText(e.daysOfWeek)}
                    </div>
                  </div>
                  <div style={{ flex: 1, fontSize: 12, color: 'var(--fg-muted)' }}>
                    {scopeText(e)}
                    <div style={{ marginTop: 4 }}>
                      上次触发：{formatLastRun(e.lastRunStamp)}
                    </div>
                  </div>
                  <Space size={4}>
                    <Button size="small" type="text" icon={<EditOutlined />} title="编辑" onClick={() => onOpenEdit(e)} />
                    <Switch
                      size="small"
                      checked={e.enabled}
                      onChange={(v) => { toggleEntry(e.id, v); message.success(v ? '已启用' : '已停用'); }}
                    />
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => onDelete({ id: e.id, name: e.name })} />
                  </Space>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card size="small">
        <Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
          说明：定时任务依赖应用保持运行（最小化仍触发，窗口关闭则不执行）。「定时采集」按任务平台逐个执行（需对应平台已登录）；「定时备份」写入你设置的本地备份目录（内容未变化不重写文件）。
        </Paragraph>
      </Card>

      <Modal
        title={editingId ? '编辑定时任务' : '新建定时任务'}
        open={open}
        onOk={onSave}
        onCancel={() => setOpen(false)}
        okText={editingId ? '保存修改' : '创建任务'}
        cancelText="取消"
        width={540}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 8 }}>
          <div>
            <span className="field-label">任务名称</span>
            <Input
              style={{ width: '100%' }}
              placeholder="如：每日早晨投递"
              value={draft.name}
              onChange={(e) => patchDraft({ name: e.target.value })}
            />
          </div>
          <div>
            <span className="field-label">动作类型</span>
            <Select
              style={{ width: '100%' }}
              value={draft.action}
              onChange={(v) => patchDraft({ action: v as ScheduleAction })}
              options={(Object.keys(ACTION_META) as ScheduleAction[]).map((a) => ({
                label: `${ACTION_META[a].label} - ${ACTION_META[a].desc}`,
                value: a,
              }))}
            />
          </div>
          {showPlatformScope && (
            <div>
              <span className="field-label">目标平台</span>
              <Select
                mode="multiple"
                allowClear
                style={{ width: '100%' }}
                placeholder="留空 = 全部已启用平台（也可预设未启用平台，启用后自动生效）"
                value={draft.platforms}
                onChange={(v) => patchDraft({ platforms: v as JobPlatform[] })}
                options={platformOptions}
                maxTagCount="responsive"
              />
            </div>
          )}
          <div>
            <span className="field-label">触发时刻</span>
            <TimePicker
              format="HH:mm"
              style={{ width: '100%' }}
              minuteStep={5}
              value={dayjs(draft.time, 'HH:mm')}
              onChange={(t) => patchDraft({ time: t ? t.format('HH:mm') : '09:00' })}
            />
          </div>
          <div>
            <span className="field-label">执行星期（默认每天）</span>
            <Select
              mode="multiple"
              allowClear
              style={{ width: '100%' }}
              placeholder="留空 = 每天"
              value={draft.daysOfWeek}
              onChange={(v) => patchDraft({ daysOfWeek: v })}
              options={WEEKDAY_OPTIONS}
              maxTagCount="responsive"
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="field-label" style={{ marginBottom: 0 }}>{editingId ? '启用该任务' : '创建后启用'}</span>
            <Switch checked={draft.enabled} onChange={(v) => patchDraft({ enabled: v })} />
          </div>
          <Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
            到点自动执行一次所述动作；触发与频控由全局调度器每分钟校验并去重（同一时刻同一任务不会重复触发）。
          </Paragraph>
        </div>
      </Modal>
    </div>
  );
}

/**
 * 防封号节奏限制卡（账号级）：岗位间隔 / 每分动作 / 风控冷却 / 活跃时段 / 批次休息。
 * 原位于「自动沟通」页；浏览器自动沟通移除后，这些限制仍约束工作台「一键投递」，故迁到设置页「常规与外观」。
 * 判定逻辑的唯一权威仍是 lib/bossclaw/safety.ts 与 activityWindow.ts，本组件只负责读写配置。
 */
import { Alert, Card, InputNumber, Switch, Tooltip } from 'antd';
import {
  ClockCircleOutlined, CoffeeOutlined, DesktopOutlined, FieldTimeOutlined, HourglassOutlined,
  InfoCircleOutlined, LockOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import { useShallow } from 'zustand/react/shallow';
import { useSettingsStore } from '@/store/useSettingsStore';
import { isLockedOut, cooldownRemaining, SAFETY_LIMITS } from '@/lib/bossclaw/safety';
import { DEFAULT_ACTIVE_HOURS, DEFAULT_BATCH_REST } from '@/lib/bossclaw/activityWindow';

export default function SafetyLimitsCard() {
  const config = useSettingsStore(useShallow((s) => s.config));
  const setConfig = useSettingsStore((s) => s.setConfig);
  // 活跃时段折算小时数（仅用于界面提示）；跨午夜（end <= start）时 +24 归一
  const activeHoursCfg = config.activeHours ?? DEFAULT_ACTIVE_HOURS;
  const activeHoursPerDay = ((activeHoursCfg.endHour - activeHoursCfg.startHour + 24) % 24) || 24;

  return (
      <Card size="small" className="setting-card" title={<><LockOutlined style={{ color: 'var(--brand)', marginRight: 6 }} /> 防封号节奏限制</>}>
        {isLockedOut(config) && (
          <Alert
            type="warning"
            showIcon
            style={{ borderRadius: 8, marginBottom: 12 }}
            message={`账号处于冷却期，剩余约 ${Math.ceil(cooldownRemaining(config) / 60000)} 分钟`}
          />
        )}
        {/*
          生效范围声明（用户反馈「不知道设置是一键投递生效还是工作台一起生效」）。
          这不是临时提示而是**字段级语义**：卡片挂在「一键投递」页，容易被误读成只作用于本页 ——
          实际上这五项都是**账号级**限制，工作台投递与一键投递共用同一套配置与同一套判定。
          故必须常驻（不适用 AGENTS.md 的「说明类文案走顶部 notification」），且只写一次（不逐卡重复）。
        */}
        <div className="sic-scope">
          <InfoCircleOutlined />
          <span>生效范围：<DesktopOutlined style={{ margin: '0 2px' }} /><b>工作台一键投递</b><span style={{ marginLeft: 6 }}>—— 以下是账号级限制，投递共用同一套；消息预警只读，不受这些限制影响</span></span>
        </div>

        {/* 基础节奏：三格等宽等高磁贴。数值与单位同行（原来输入框 width:100% 会把
            「秒 / 次/分 / 分钟」挤到独占一行，卡片内留下大片空档）。
            「风控冷却」的长说明改为标签旁的提示图标（字段级解释走 Tooltip，见 AGENTS.md §3.4）——
            原先它常驻在卡底，把同排三格拉成不等高，前两格底部各留一块空白。 */}
        <div className="sic-tiles">
          <div className="stat-input-card">
            <span className="sic-label">
              <FieldTimeOutlined className="sic-icon" />
              岗位间隔
            </span>
            <div className="sic-input-wrap">
              <InputNumber
                min={15}
                max={600}
                value={config.betweenJobsSeconds}
                onChange={(v) => setConfig({ betweenJobsSeconds: v ?? 20 })}
                style={{ flex: 1, minWidth: 0 }}
              />
              <span className="sic-unit">秒</span>
            </div>
          </div>

          <div className="stat-input-card">
            <span className="sic-label">
              <ThunderboltOutlined className="sic-icon" />
              每分动作
            </span>
            <div className="sic-input-wrap">
              <InputNumber
                min={1}
                max={SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE}
                value={config.maxActionsPerMinute}
                onChange={(v) => setConfig({ maxActionsPerMinute: Math.min(SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE, Math.max(1, v ?? 6)) })}
                style={{ flex: 1, minWidth: 0 }}
              />
              <span className="sic-unit">次/分</span>
            </div>
          </div>

          <div className="stat-input-card">
            <span className="sic-label">
              <HourglassOutlined className="sic-icon" />
              风控冷却
              {/* 下界锁 30 分钟而不是 5：冷却遵循「只放大、不缩短」（safety.ts::resolveCooldownMs）——
                  低于 30 分钟对各风险码的预设保护时长没有任何效果，给这个区间只会造成
                  「调了但看不出变化」的误解。 */}
              <Tooltip title="调大可延长冷却时长；不会缩短各风险码的保护下限">
                <InfoCircleOutlined className="sic-hint" />
              </Tooltip>
            </span>
            <div className="sic-input-wrap">
              <InputNumber
                min={30}
                max={720}
                value={config.autoCooldownMinutes}
                onChange={(v) => setConfig({ autoCooldownMinutes: v ?? 30 })}
                style={{ flex: 1, minWidth: 0 }}
              />
              <span className="sic-unit">分钟</span>
            </div>
          </div>
        </div>

        {/*
          作息与批次休息（详见 activityWindow.ts）：
          操作时间戳是**服务端可见的账号级长期统计** —— 指纹可以伪装，
          但「24 小时无睡眠」「连续上百次投递不中断」这类作息异常骗不过时间序列分析。
          故这两项必须与工作台同口径（见文件顶部生效范围声明）。

          布局用**单列整行**而不是并排两列：侧栏宽度是固定 420px（.设置页卡片），
          卡内可用宽度约 388px，而「批次休息」一行有 8 个控件（开关 + 4 个数字 + 3 个单位）
          约需 336px —— 并排两列时每列只有 ~189px，必然折行成锯齿，甚至右侧整段被裁掉
          （旧版用户截图里「个休息」之后的区间直接消失）。
          整行铺开后：开关与标题同排（开关右对齐，与卡片右缘对齐），数值独占一行，
          任何容器宽度下都不会裁切或乱折。`.sic-input-wrap` 的 flex-wrap 作为兜底保留。
        */}
        <div className="sic-rows">
          <div className="stat-input-card">
            <div className="sic-row-head">
              <span className="sic-label">
                <ClockCircleOutlined className="sic-icon" />
                活跃时段
              </span>
              <Switch
                size="small"
                checked={config.activeHours?.enabled !== false}
                onChange={(v) => setConfig({ activeHours: { ...(config.activeHours ?? DEFAULT_ACTIVE_HOURS), enabled: v } })}
              />
            </div>
            <div className="sic-input-wrap">
              <InputNumber
                min={0}
                max={23}
                style={{ width: 64 }}
                disabled={config.activeHours?.enabled === false}
                value={config.activeHours?.startHour ?? DEFAULT_ACTIVE_HOURS.startHour}
                onChange={(v) => setConfig({ activeHours: { ...(config.activeHours ?? DEFAULT_ACTIVE_HOURS), startHour: v ?? DEFAULT_ACTIVE_HOURS.startHour } })}
              />
              <span className="sic-unit">至</span>
              <InputNumber
                min={0}
                max={23}
                style={{ width: 64 }}
                disabled={config.activeHours?.enabled === false}
                value={config.activeHours?.endHour ?? DEFAULT_ACTIVE_HOURS.endHour}
                onChange={(v) => setConfig({ activeHours: { ...(config.activeHours ?? DEFAULT_ACTIVE_HOURS), endHour: v ?? DEFAULT_ACTIVE_HOURS.endHour } })}
              />
              <span className="sic-unit">点</span>
              {/* 折算提示既补足信息，也让这一行的行尾与下一行（批次休息）齐平 */}
              <span className="sic-note">每天约 {activeHoursPerDay} 小时</span>
            </div>
          </div>

          <div className="stat-input-card">
            <div className="sic-row-head">
              <span className="sic-label">
                <CoffeeOutlined className="sic-icon" />
                批次休息
              </span>
              <Switch
                size="small"
                checked={config.batchRest?.enabled !== false}
                onChange={(v) => setConfig({ batchRest: { ...(config.batchRest ?? DEFAULT_BATCH_REST), enabled: v } })}
              />
            </div>
            <div className="sic-input-wrap">
              <span className="sic-unit">每</span>
              <InputNumber
                min={3}
                max={200}
                style={{ width: 62 }}
                disabled={config.batchRest?.enabled === false}
                value={config.batchRest?.everyNJobs ?? DEFAULT_BATCH_REST.everyNJobs}
                onChange={(v) => setConfig({ batchRest: { ...(config.batchRest ?? DEFAULT_BATCH_REST), everyNJobs: v ?? DEFAULT_BATCH_REST.everyNJobs } })}
              />
              <span className="sic-unit">个休息</span>
              <InputNumber
                min={1}
                max={60}
                style={{ width: 62 }}
                disabled={config.batchRest?.enabled === false}
                value={config.batchRest?.minMinutes ?? DEFAULT_BATCH_REST.minMinutes}
                onChange={(v) => setConfig({ batchRest: { ...(config.batchRest ?? DEFAULT_BATCH_REST), minMinutes: v ?? DEFAULT_BATCH_REST.minMinutes } })}
              />
              <span className="sic-unit">–</span>
              <InputNumber
                min={1}
                max={60}
                style={{ width: 62 }}
                disabled={config.batchRest?.enabled === false}
                value={config.batchRest?.maxMinutes ?? DEFAULT_BATCH_REST.maxMinutes}
                onChange={(v) => setConfig({ batchRest: { ...(config.batchRest ?? DEFAULT_BATCH_REST), maxMinutes: v ?? DEFAULT_BATCH_REST.maxMinutes } })}
              />
              <span className="sic-unit">分钟</span>
            </div>
          </div>
        </div>
      </Card>
  );
}

import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { DomainProfileStatus } from '../api.js';
import { HelpBox } from '../components/HelpBox.js';
import { useI18n } from '../i18n.js';
import type { TKey } from '../i18n.js';

const PERIODIC_CHECKS: { key: string; tkey: TKey }[] = [
  { key: 'checks.run_eventlog', tkey: 'settings.check.eventlog' },
  { key: 'checks.run_disk', tkey: 'settings.check.disk' },
  { key: 'checks.run_services', tkey: 'settings.check.services' },
  { key: 'checks.run_perf', tkey: 'settings.check.perf' },
  { key: 'checks.run_adsync', tkey: 'settings.check.adsync' },
];

const SCHEDULE_DAYS: { value: number; tkey: TKey }[] = [
  { value: 1, tkey: 'settings.day.mo' },
  { value: 2, tkey: 'settings.day.tu' },
  { value: 3, tkey: 'settings.day.we' },
  { value: 4, tkey: 'settings.day.th' },
  { value: 5, tkey: 'settings.day.fr' },
  { value: 6, tkey: 'settings.day.sa' },
  { value: 0, tkey: 'settings.day.su' },
];

function NetworkAccessSection() {
  const { t } = useI18n();
  const [ips, setIps] = useState<string[]>([]);
  const [draft, setDraft] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [domainProfile, setDomainProfile] = useState<DomainProfileStatus | null>(null);

  useEffect(() => {
    api.firewallWhitelist()
      .then((r) => { setIps(r.ips); setDraft(r.ips.join('\n')); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    api.firewallDomainProfile().then(setDomainProfile).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const list = draft.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean);
      const result = await api.saveFirewallWhitelist(list);
      setIps(result.ips);
      setDraft(result.ips.join('\n'));
      setMessage(t('settings.network.savedIps').replace('{n}', String(result.ips.length)));
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const dirty = draft.trim() !== ips.join('\n');

  return (
    <div style={{ marginBottom: 32, paddingBottom: 24, borderBottom: '1px solid var(--border)' }}>
      <h3 style={{ margin: '0 0 4px 0', fontSize: 16 }}>{t('settings.section.network')}</h3>
      <p style={{ margin: '0 0 16px 0', color: 'var(--text-dim)', fontSize: 12 }}>
        {t('settings.section.networkDesc')}
      </p>
      {domainProfile && (
        <div style={{
          background: domainProfile.enabled === false ? 'rgba(244, 135, 113, 0.12)' : 'rgba(70, 200, 130, 0.10)',
          border: `1px solid ${domainProfile.enabled === false ? 'var(--warning, #f48771)' : 'var(--ok, #46c882)'}`,
          color: 'var(--text)',
          padding: '8px 12px',
          marginBottom: 16,
          borderRadius: 6,
          fontSize: 12,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
        }}>
          <span style={{ fontSize: 14 }}>{domainProfile.enabled === false ? '⚠' : '✓'}</span>
          <div style={{ flex: 1 }}>
            <strong>{domainProfile.enabled === false
              ? t('settings.network.firewallDisabled')
              : domainProfile.enabled === true
              ? t('settings.network.firewallEnabled')
              : t('settings.network.firewallUnknown')}</strong>
            {domainProfile.enabled === false && (
              <>
                <div style={{ marginTop: 4 }}>{t('settings.network.firewallDisabledBody')}</div>
                <code style={{ display: 'block', marginTop: 4, padding: '4px 6px', background: 'var(--bg)', borderRadius: 3 }}>
                  Set-NetFirewallProfile -Profile Domain -Enabled True
                </code>
                <div style={{ marginTop: 4, color: 'var(--text-dim)' }}>
                  {t('settings.network.firewallDisabledGpo')}{domainProfile.defaultInboundAction ?? '—'}.
                </div>
              </>
            )}
            {domainProfile.enabled === null && (
              <div style={{ marginTop: 4, color: 'var(--text-dim)' }}>
                {t('settings.network.firewallReadError')}{domainProfile.error ?? 'unknown'}
              </div>
            )}
          </div>
        </div>
      )}
      {loading ? (
        <div style={{ color: 'var(--text-dim)' }}>{t('settings.network.loading')}</div>
      ) : (
        <>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>
            {t('settings.network.oneLine')}
          </label>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            spellCheck={false}
            style={{
              width: '100%', maxWidth: 400,
              background: 'var(--bg)', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 4, padding: 8,
              fontFamily: 'Consolas, monospace', fontSize: 12,
            }}
          />
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 8 }}>
            <button
              className="refresh-btn"
              onClick={save}
              disabled={!dirty || saving}
              style={{ minWidth: 80 }}
            >
              {saving ? t('settings.saving') : t('settings.network.apply')}
            </button>
            {dirty && <span style={{ color: 'var(--warning)', fontSize: 11 }}>{t('settings.unsaved')}</span>}
            {message && <span style={{ color: 'var(--ok)', fontSize: 11 }}>✓ {message}</span>}
            {error && <span style={{ color: 'var(--critical)', fontSize: 11 }}>⚠ {error}</span>}
          </div>
          <div style={{ marginTop: 6, color: 'var(--text-dim)', fontSize: 11 }}>
            {t('settings.network.current')} ({ips.length}): {ips.join(', ') || '—'}
          </div>
        </>
      )}
    </div>
  );
}

interface RetentionStep {
  name: string;
  ok: boolean;
  rowsAffected: number;
  durationMs: number;
  detail: string;
  error?: string;
}

interface RetentionReport {
  triggerSource: 'manual' | 'scheduled';
  startedAt: string;
  finishedAt: string;
  totalDurationMs: number;
  steps: RetentionStep[];
}

type RetentionStepName = 'events_purge' | 'activity_log_purge' | 'pc_user_history_purge' | 'events_dedup';
const ALL_STEPS: RetentionStepName[] = ['events_purge', 'activity_log_purge', 'pc_user_history_purge', 'events_dedup'];

function RetentionRunBlock() {
  const { t } = useI18n();
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<RetentionReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nextRunAt, setNextRunAt] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<RetentionStepName>>(() => new Set(ALL_STEPS));

  useEffect(() => {
    fetch('/api/retention/status').then(r => r.json()).then((j) => {
      if (j?.ok) {
        setReport(j.lastReport ?? null);
        setNextRunAt(j.nextRunAt ?? null);
        setRunning(Boolean(j.running));
      }
    }).catch(() => {});
  }, []);

  const toggle = (name: RetentionStepName) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const run = async () => {
    if (selected.size === 0) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/retention/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps: Array.from(selected) }),
      });
      const j = await res.json();
      if (j?.ok) setReport(j.report); else setError(String(j?.error ?? 'unknown'));
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ marginTop: 18, padding: 14, background: 'rgba(59, 130, 246, 0.06)', border: '1px solid var(--accent)', borderRadius: 4 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>{t('settings.retention.manualHeader')}</div>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 14, lineHeight: 1.5 }}>{t('settings.retention.manualHint')}</div>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{t('settings.retention.pickSteps')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        {ALL_STEPS.map((name) => (
          <label key={name} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontSize: 12 }}>
            <input
              type="checkbox"
              checked={selected.has(name)}
              onChange={() => toggle(name)}
              style={{ marginTop: 2 }}
            />
            <span>
              <span style={{ fontWeight: 600 }}>{t(`settings.retention.step.${name}.label` as const)}</span>
              <span style={{ color: 'var(--text-dim)', marginLeft: 6 }}>— {t(`settings.retention.step.${name}.desc` as const)}</span>
            </span>
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="refresh-btn"
          onClick={run}
          disabled={running || selected.size === 0}
          style={{ background: (running || selected.size === 0) ? 'var(--text-dim)' : 'var(--accent)', color: 'white', border: 'none', padding: '6px 14px', fontSize: 12, fontWeight: 600 }}
        >
          {running ? t('settings.retention.running') : t('settings.retention.runSelected', { n: selected.size })}
        </button>
        {nextRunAt && (
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            {t('settings.retention.next')}: {new Date(nextRunAt).toLocaleString()}
          </span>
        )}
        {error && <span style={{ color: 'var(--critical)', fontSize: 11 }}>⚠ {error}</span>}
      </div>

      {report && (
        <div style={{ marginTop: 12, fontSize: 12 }}>
          <div style={{ color: 'var(--text-dim)', marginBottom: 6 }}>
            {t('settings.retention.lastRun', {
              source: report.triggerSource,
              when: new Date(report.startedAt).toLocaleString(),
              dur: (report.totalDurationMs / 1000).toFixed(1),
            })}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ color: 'var(--text-dim)', textAlign: 'left' }}>
                <th style={{ padding: '4px 6px' }}>{t('settings.retention.col.step')}</th>
                <th style={{ padding: '4px 6px' }}>{t('settings.retention.col.detail')}</th>
                <th style={{ padding: '4px 6px', textAlign: 'right' }}>{t('settings.retention.col.rows')}</th>
                <th style={{ padding: '4px 6px', textAlign: 'right' }}>{t('settings.retention.col.duration')}</th>
                <th style={{ padding: '4px 6px' }}>{t('settings.retention.col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {report.steps.map((s) => (
                <tr key={s.name} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '4px 6px', fontFamily: 'Consolas, monospace' }}>{s.name}</td>
                  <td style={{ padding: '4px 6px', color: 'var(--text-dim)' }}>{s.detail}</td>
                  <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'Consolas, monospace' }}>{s.rowsAffected.toLocaleString()}</td>
                  <td style={{ padding: '4px 6px', textAlign: 'right', color: 'var(--text-dim)' }}>{(s.durationMs / 1000).toFixed(2)}s</td>
                  <td style={{ padding: '4px 6px', color: s.ok ? 'var(--ok)' : 'var(--critical)' }}>
                    {s.ok ? '✓' : `✗ ${s.error ?? ''}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function SettingsPage() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then((s) => setSettings(s)).catch((e) => setError(String(e)));
  }, []);

  const value = (key: string, def = '') => dirty[key] ?? settings[key] ?? def;
  const set = (key: string, v: string) => setDirty((d) => ({ ...d, [key]: v }));
  const selectedDays = new Set(
    value('checks.days', '1,2,3,4,5').split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isInteger(v) && v >= 0 && v <= 6)
  );
  const toggleDay = (day: number) => {
    const next = new Set(selectedDays);
    if (next.has(day)) next.delete(day);
    else next.add(day);
    const ordered = SCHEDULE_DAYS.map((d) => d.value).filter((d) => next.has(d));
    set('checks.days', ordered.join(','));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const changedKeys = Object.keys(dirty);
      await api.saveSettings(dirty);
      setSettings({ ...settings, ...dirty });
      setDirty({});
      setMessage(`${t('settings.saved')} (${changedKeys.length})`);
      // Broadcast so other tabs (Dashboard card, Computers chip) can refetch
      // anything derived from settings — avoids stale UI until F5.
      window.dispatchEvent(new CustomEvent('itd:settings-saved', { detail: { changedKeys } }));
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = Object.keys(dirty).length > 0;

  return (
    <div className="panel" style={{ gridColumn: '1 / -1', gridRow: '1 / -1', overflowY: 'auto' }}>
      <div className="panel-header">
        <h2>{t('settings.title')}</h2>
        <div className="panel-actions filters">
          {message && <span style={{ color: 'var(--ok)', fontSize: 11 }}>✓ {message}</span>}
          {error && <span style={{ color: 'var(--critical)', fontSize: 11 }}>⚠ {error}</span>}
          {hasChanges && <span style={{ color: 'var(--warning)', fontSize: 11 }}>{Object.keys(dirty).length} {t('settings.unsaved')}</span>}
          <button className="refresh-btn" onClick={save} disabled={!hasChanges || saving} style={{ minWidth: 80 }}>
            {saving ? t('settings.saving') : t('btn.save')}
          </button>
        </div>
      </div>
      <div className="panel-body" style={{ padding: 24 }}>

        <HelpBox title={t('settings.helpTitle')}>
          <p>{t('settings.helpBody')}</p>
        </HelpBox>

        <Section title={t('settings.section.periodic')} description={t('settings.section.periodicDesc')}>
          <Field label={t('settings.field.runEvery')}>
            <IntervalInput v={value('checks.interval_sec', '900')} onChange={(v) => set('checks.interval_sec', v)} />
          </Field>
          <Field label={t('settings.field.days')}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {SCHEDULE_DAYS.map((day) => (
                <button
                  key={day.value}
                  type="button"
                  onClick={() => toggleDay(day.value)}
                  className="refresh-btn"
                  style={{
                    minWidth: 42,
                    background: selectedDays.has(day.value) ? 'var(--accent)' : 'transparent',
                    color: selectedDays.has(day.value) ? 'white' : 'var(--text-dim)',
                  }}
                >
                  {t(day.tkey)}
                </button>
              ))}
            </div>
          </Field>
          <FieldGroup>
            <Field label={t('settings.field.windowFrom')}>
              <input type="time" value={value('checks.window_start', '06:00')} onChange={(e) => set('checks.window_start', e.target.value)} style={{ ...fieldStyle, minWidth: 120 }} />
            </Field>
            <Field label={t('settings.field.windowTo')}>
              <input type="time" value={value('checks.window_end', '18:00')} onChange={(e) => set('checks.window_end', e.target.value)} style={{ ...fieldStyle, minWidth: 120 }} />
            </Field>
          </FieldGroup>
          <FieldGroup>
            {PERIODIC_CHECKS.map((check) => (
              <CheckField
                key={check.key}
                label={t(check.tkey)}
                checked={value(check.key, 'true') === 'true'}
                onChange={(checked) => set(check.key, String(checked))}
              />
            ))}
          </FieldGroup>
        </Section>

        <Section
          title={t('settings.section.perfLookback')}
          description={t('settings.section.perfLookbackDesc')}
        >
          <Field label={t('settings.field.coldStart')}>
            <NumberInput
              v={value('perf.cold_start_days', '30')}
              onChange={(v) => set('perf.cold_start_days', v)}
              suffix={t('settings.unit.days')}
            />
          </Field>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '0' }}>
            {t('settings.field.coldStartHelp')}
          </p>
        </Section>

        <Section
          title={t('settings.section.inactive')}
          description={t('settings.section.inactiveDesc')}
        >
          <Field label={t('settings.field.inactiveDays')}>
            <NumberInput
              v={value('inactive.threshold_days', '90')}
              onChange={(v) => set('inactive.threshold_days', v)}
              suffix={t('settings.unit.days')}
            />
          </Field>
        </Section>

        <Section
          title={t('settings.section.pcUserHistory')}
          description={t('settings.section.pcUserHistoryDesc')}
        >
          <Field label={t('settings.field.pcUserHistoryDays')}>
            <NumberInput
              v={value('pcUserHistory.retention_days', '90')}
              onChange={(v) => set('pcUserHistory.retention_days', v)}
              suffix={t('settings.unit.days')}
            />
          </Field>
        </Section>

        <Section
          title={t('settings.section.eventRetention')}
          description={t('settings.section.eventRetentionDesc')}
        >
          <FieldGroup>
            <Field label={t('settings.field.eventsRetentionDays')}>
              <NumberInput
                v={value('events.retention_days', '90')}
                onChange={(v) => set('events.retention_days', v)}
                suffix={t('settings.unit.days')}
              />
            </Field>
            <Field label={t('settings.field.activityRetentionDays')}>
              <NumberInput
                v={value('activity.retention_days', '30')}
                onChange={(v) => set('activity.retention_days', v)}
                suffix={t('settings.unit.days')}
              />
            </Field>
            <Field label={t('settings.field.retentionRunHour')}>
              <NumberInput
                v={value('retention.run_at_hour', '2')}
                onChange={(v) => set('retention.run_at_hour', v)}
                suffix={t('settings.unit.hour24')}
              />
            </Field>
          </FieldGroup>
          <FieldGroup>
            <CheckField
              label={t('settings.field.eventsDedupEnabled')}
              checked={value('events.dedup_enabled', '1') === '1'}
              onChange={(checked) => set('events.dedup_enabled', checked ? '1' : '0')}
            />
            <Field label={t('settings.field.eventsDedupLookback')}>
              <NumberInput
                v={value('events.dedup_lookback_days', '90')}
                onChange={(v) => set('events.dedup_lookback_days', v)}
                suffix={t('settings.unit.days')}
              />
            </Field>
          </FieldGroup>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '8px 0 0 0' }}>
            {t('settings.field.eventRetentionHelp')}
          </p>
          <RetentionRunBlock />
        </Section>

        <Section
          title={t('settings.section.adsync')}
          description={t('settings.section.adsyncDesc')}
        >
          <FieldGroup>
            <CheckField
              label={t('settings.field.newPcsMonitored')}
              checked={value('adsync.default_monitor_enabled', 'true') === 'true'}
              onChange={(checked) => set('adsync.default_monitor_enabled', String(checked))}
            />
          </FieldGroup>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '8px 0 0 0' }}>
            {t('settings.field.runAllAlwaysSyncs')}
          </p>
        </Section>

        <NetworkAccessSection />

        <Section title={t('settings.section.disk')} description={t('settings.section.diskDesc')}>
          <Field label={t('settings.field.thresholdMode')}>
            <select value={value('disk.threshold_mode', 'pct')} onChange={(e) => set('disk.threshold_mode', e.target.value)} style={fieldStyle}>
              <option value="pct">{t('settings.thresholdMode.pct')}</option>
              <option value="gb">{t('settings.thresholdMode.gb')}</option>
              <option value="either">{t('settings.thresholdMode.either')}</option>
            </select>
          </Field>
          <FieldGroup>
            <Field label={t('settings.field.criticalPct')}>
              <NumberInput v={value('disk.critical_pct', '5')} onChange={(v) => set('disk.critical_pct', v)} suffix="%" />
            </Field>
            <Field label={t('settings.field.warningPct')}>
              <NumberInput v={value('disk.warning_pct', '15')} onChange={(v) => set('disk.warning_pct', v)} suffix="%" />
            </Field>
          </FieldGroup>
          <FieldGroup>
            <Field label={t('settings.field.criticalGb')}>
              <NumberInput v={value('disk.critical_gb', '5')} onChange={(v) => set('disk.critical_gb', v)} suffix="GB" />
            </Field>
            <Field label={t('settings.field.warningGb')}>
              <NumberInput v={value('disk.warning_gb', '20')} onChange={(v) => set('disk.warning_gb', v)} suffix="GB" />
            </Field>
          </FieldGroup>
        </Section>

      </div>
    </div>
  );
}

function IntervalInput({ v, onChange }: { v: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  const n = Number(v);
  const [unit, setUnit] = React.useState<'sec' | 'min' | 'hour'>(
    n >= 3600 && n % 3600 === 0 ? 'hour' : n >= 60 && n % 60 === 0 ? 'min' : 'sec'
  );
  const display =
    unit === 'hour' ? String(n / 3600) :
    unit === 'min' ? String(n / 60) :
    String(n);
  const onValueChange = (newDisplay: string) => {
    const num = Number(newDisplay);
    if (isNaN(num)) return;
    const seconds = unit === 'hour' ? num * 3600 : unit === 'min' ? num * 60 : num;
    onChange(String(Math.round(seconds)));
  };
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input type="number" value={display} onChange={(e) => onValueChange(e.target.value)} style={{ ...fieldStyle, minWidth: 80 }} step="1" min="0" />
      <select value={unit} onChange={(e) => setUnit(e.target.value as 'sec' | 'min' | 'hour')} style={{ ...fieldStyle, minWidth: 80 }}>
        <option value="sec">{t('settings.unit.seconds')}</option>
        <option value="min">{t('settings.unit.minutes')}</option>
        <option value="hour">{t('settings.unit.hours')}</option>
      </select>
      <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>({v}s)</span>
    </div>
  );
}

const fieldStyle: React.CSSProperties = { background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 8px', fontFamily: 'inherit', fontSize: 13, minWidth: 200 };

function NumberInput({ v, onChange, suffix }: { v: string; onChange: (v: string) => void; suffix?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input type="number" value={v} onChange={(e) => onChange(e.target.value)} style={{ ...fieldStyle, minWidth: 100 }} step="0.1" min="0" />
      {suffix && <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{suffix}</span>}
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 32, paddingBottom: 24, borderBottom: '1px solid var(--border)' }}>
      <h3 style={{ margin: '0 0 4px 0', fontSize: 16, color: 'var(--text)' }}>{title}</h3>
      {description && <p style={{ margin: '0 0 16px 0', color: 'var(--text-dim)', fontSize: 12 }}>{description}</p>}
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}

function CheckField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text)', fontSize: 13, cursor: 'pointer', minWidth: 180 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function FieldGroup({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>{children}</div>;
}

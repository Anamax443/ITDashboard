import React, { useEffect, useState } from 'react';
import { api, timeAgo } from '../api.js';
import type { DomainProfileStatus } from '../api.js';
import { HelpBox } from '../components/HelpBox.js';
import { useI18n } from '../i18n.js';
import type { TKey } from '../i18n.js';

const PERIODIC_CHECKS: { key: string; tkey: TKey }[] = [
  { key: 'checks.run_adsync', tkey: 'settings.check.adsync' },
  { key: 'checks.run_eventlog', tkey: 'settings.check.eventlog' },
  { key: 'checks.run_disk', tkey: 'settings.check.disk' },
  { key: 'checks.run_services', tkey: 'settings.check.services' },
  { key: 'checks.run_perf', tkey: 'settings.check.perf' },
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

// Connectivity readout for an API-based collector (MikroTik / UniFi): the last
// run result from the activity log (green = ok, red = error) + a "test now" button
// that triggers a live pull and refreshes the status.
// onTest performs a live probe and returns a short human summary to show inline
// (it may also write to the activity log, which the status line then reflects).
function IntegrationStatus({ source, onTest }: { source: 'mikrotik' | 'unifi'; onTest: () => Promise<{ ok: boolean; summary: string }> }) {
  const { t } = useI18n();
  const [st, setSt] = useState<{ ts: string; level: string; message: string; lastOk: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testRes, setTestRes] = useState<{ ok: boolean; summary: string } | null>(null);
  const load = () => api.integrationsStatus()
    .then((r) => setSt(r.items[source] ?? null))
    .catch(() => { /* keep last */ })
    .finally(() => setLoading(false));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  const test = async () => {
    if (testing) return;
    setTesting(true); setTestRes(null);
    try { setTestRes(await onTest()); }
    catch (e) { setTestRes({ ok: false, summary: String(e) }); }
    finally { setTesting(false); load(); }
  };
  const ok = !!st && (st.level === 'info' || st.level === 'success');
  const dot = !st ? 'var(--text-dim)' : ok ? 'var(--ok)' : 'var(--critical)';
  return (
    <div style={{ margin: '8px 0 2px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button className="refresh-btn" onClick={test} disabled={testing} style={{ fontWeight: 600 }}>
          {testing ? t('settings.integ.testing') : `🔌 ${t('settings.integ.test')}`}
        </button>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, minWidth: 0 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: dot, flex: '0 0 auto' }} />
          {loading ? <span style={{ color: 'var(--text-dim)' }}>…</span>
            : !st ? <span style={{ color: 'var(--text-dim)' }}>{t('settings.integ.never')}</span>
              : (
                <span style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${st.message} · ${st.ts}`}>
                  <span style={{ color: ok ? 'var(--ok)' : 'var(--critical)', fontWeight: 600 }}>{ok ? t('settings.integ.ok') : t('settings.integ.err')}</span>
                  {` · ${st.message} · ${timeAgo(st.ts)}`}
                </span>
              )}
        </span>
      </div>
      {testRes && (
        <div style={{ fontSize: 12, marginTop: 6, color: testRes.ok ? 'var(--ok)' : 'var(--critical)' }}>
          {testRes.ok ? '✓' : '✗'} {testRes.summary}
        </div>
      )}
    </div>
  );
}

// Move-line on Ctrl+ArrowUp / Ctrl+ArrowDown inside a <textarea> (like SSMS /
// VS Code). Moves the line(s) the selection touches up or down by one, preserves
// the caret column, and writes the new value back through `setValue`. No-op (just
// blocks the default caret move) at the top/bottom edge.
function moveLinesOnKey(e: React.KeyboardEvent<HTMLTextAreaElement>, setValue: (v: string) => void) {
  if (!e.ctrlKey || e.shiftKey || e.altKey) return;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  const el = e.currentTarget;
  const val = el.value;
  const lines = val.split('\n');
  const selStart = el.selectionStart;
  const selEnd = el.selectionEnd;
  const lineStartOffset = (arr: string[], idx: number) => arr.slice(0, idx).reduce((n, l) => n + l.length + 1, 0);
  const lineAt = (off: number) => val.slice(0, off).split('\n').length - 1;
  const a = lineAt(selStart);
  const b = lineAt(selEnd);
  const up = e.key === 'ArrowUp';
  if ((up && a === 0) || (!up && b === lines.length - 1)) return; // at edge — nothing to swap
  // caret columns within their lines (preserved across the move)
  const colStart = selStart - lineStartOffset(lines, a);
  const colEnd = selEnd - lineStartOffset(lines, b);
  let na = a;
  let nb = b;
  if (up) {
    const moved = lines.splice(a - 1, 1)[0]!;
    lines.splice(b, 0, moved);
    na = a - 1; nb = b - 1;
  } else {
    const moved = lines.splice(b + 1, 1)[0]!;
    lines.splice(a, 0, moved);
    na = a + 1; nb = b + 1;
  }
  const newVal = lines.join('\n');
  const newSelStart = lineStartOffset(lines, na) + colStart;
  const newSelEnd = lineStartOffset(lines, nb) + colEnd;
  setValue(newVal);
  // Restore the selection after React commits the new value to the same node.
  requestAnimationFrame(() => { try { el.selectionStart = newSelStart; el.selectionEnd = newSelEnd; } catch { /* ignore */ } });
}

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

// A free-text filter over the Settings sections — a Section whose title or
// description doesn't match the query hides itself (the page has many blocks).
const SettingsFilterContext = React.createContext('');

export function SettingsPage() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reachRunning, setReachRunning] = useState(false);
  const [reachResult, setReachResult] = useState<string | null>(null);
  const [blockFilter, setBlockFilter] = useState('');

  useEffect(() => {
    api.settings().then((s) => setSettings(s)).catch((e) => setError(String(e)));
  }, []);

  const runReachability = async () => {
    setReachRunning(true);
    setReachResult(null);
    try {
      const r = await api.reachabilityRun();
      setReachResult(`${r.reachable}/${r.pcs} ${t('settings.reach.reachable')} (${(r.durationMs / 1000).toFixed(1)}s)`);
    } catch (e) {
      setReachResult(String(e));
    } finally {
      setReachRunning(false);
    }
  };

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
    <SettingsFilterContext.Provider value={blockFilter.trim().toLowerCase()}>
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

        <div style={{ margin: '0 0 18px' }}>
          <input
            type="search"
            value={blockFilter}
            onChange={(e) => setBlockFilter(e.target.value)}
            placeholder={t('settings.filterBlocks')}
            style={{ ...fieldStyle, width: '100%', maxWidth: 460 }}
          />
        </div>

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
          title={t('settings.section.reachability')}
          description={t('settings.section.reachabilityDesc')}
        >
          <FieldGroup>
            <CheckField
              label={t('settings.check.reachability')}
              checked={value('checks.run_reachability', 'true') === 'true'}
              onChange={(checked) => set('checks.run_reachability', String(checked))}
            />
            <CheckField
              label={t('settings.check.reachabilityPing')}
              checked={value('reachability.ping', 'true') === 'true'}
              onChange={(checked) => set('reachability.ping', String(checked))}
            />
            <Field label={t('settings.field.reachabilityInterval')}>
              <NumberInput
                v={value('reachability.interval_sec', '300')}
                onChange={(v) => set('reachability.interval_sec', v)}
                suffix={t('settings.unit.seconds')}
              />
            </Field>
          </FieldGroup>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
            <button className="refresh-btn" onClick={runReachability} disabled={reachRunning}>
              {reachRunning ? `… ${t('settings.reach.running')}` : `🔌 ${t('settings.reach.run')}`}
            </button>
            {reachResult && <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{reachResult}</span>}
          </div>
        </Section>

        <Section title={t('settings.section.mikrotik')} description={t('settings.section.mikrotikDesc')}>
          <FieldGroup>
            <CheckField
              label={t('settings.field.mikrotikEnabled')}
              checked={value('mikrotik.enabled', '1') === '1'}
              onChange={(checked) => set('mikrotik.enabled', checked ? '1' : '0')}
            />
            <Field label={t('settings.field.mikrotikInterval')}>
              <IntervalInput v={value('mikrotik.interval_sec', '300')} onChange={(v) => set('mikrotik.interval_sec', v)} />
            </Field>
          </FieldGroup>
          <Field label={t('settings.field.mikrotikRouters')}>
            <input
              type="text"
              value={value('mikrotik.routers', '')}
              onChange={(e) => set('mikrotik.routers', e.target.value)}
              placeholder="Brno=10.8.2.207, Zastavka=10.10.181.2"
              style={{ ...fieldStyle, width: '100%', minWidth: 320, fontFamily: 'Consolas, monospace' }}
            />
          </Field>
          <Field label={t('settings.field.mikrotikUser')}>
            <input
              type="text"
              value={value('mikrotik.user', 'dhcp-reader')}
              onChange={(e) => set('mikrotik.user', e.target.value)}
              style={{ ...fieldStyle, width: 240 }}
            />
          </Field>
          <Field label={t('settings.field.mikrotikPassword')}>
            <input
              type="password"
              value={value('mikrotik.password', '')}
              onChange={(e) => set('mikrotik.password', e.target.value)}
              placeholder={t('settings.field.mikrotikPasswordPlaceholder')}
              autoComplete="new-password"
              style={{ ...fieldStyle, width: 240 }}
            />
          </Field>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '4px 0 0 0', lineHeight: 1.5 }}>
            {t('settings.field.mikrotikHelp')}
          </p>

          <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0 10px' }} />
          <CheckField
            label={t('settings.field.ftpEnabled')}
            checked={value('mikrotik.ftp_enabled', '1') === '1'}
            onChange={(checked) => set('mikrotik.ftp_enabled', checked ? '1' : '0')}
          />
          <Field label={t('settings.field.ftpSites')}>
            <input
              type="text"
              value={value('mikrotik.ftp_sites', '')}
              onChange={(e) => set('mikrotik.ftp_sites', e.target.value)}
              placeholder="Brno, Zastavka"
              style={{ ...fieldStyle, width: '100%', minWidth: 320, fontFamily: 'Consolas, monospace' }}
            />
          </Field>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '4px 0 0 0', lineHeight: 1.5 }}>
            {t('settings.field.ftpSitesHelp')}
          </p>

          <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0 10px' }} />
          <CheckField
            label={t('settings.field.scanEnabled')}
            checked={value('mikrotik.scan_enabled', '0') === '1'}
            onChange={(checked) => set('mikrotik.scan_enabled', checked ? '1' : '0')}
          />
          <Field label={t('settings.field.scanRanges')}>
            <textarea
              value={value('mikrotik.scan_ranges', '')}
              onChange={(e) => set('mikrotik.scan_ranges', e.target.value)}
              onKeyDown={(e) => moveLinesOnKey(e, (v) => set('mikrotik.scan_ranges', v))}
              rows={3}
              placeholder={"10.8.2.*\nZastavka=10.10.181.0/24"}
              title={t('settings.field.scanRangesMove')}
              style={{ ...fieldStyle, width: '100%', minWidth: 320, fontFamily: 'Consolas, monospace', resize: 'vertical' }}
            />
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>{t('settings.field.scanRangesMove')}</div>
          </Field>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '4px 0 0 0', lineHeight: 1.5 }}>
            {t('settings.field.scanHelp')}
          </p>

          <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0 10px' }} />
          <Field label={t('settings.field.leaseRetention')}>
            <input
              type="number"
              min={0}
              value={value('devices.lease_retention_days', '14')}
              onChange={(e) => set('devices.lease_retention_days', e.target.value)}
              style={{ ...fieldStyle, width: 90 }}
            />
          </Field>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '4px 0 0 0', lineHeight: 1.5 }}>
            {t('settings.field.leaseRetentionHelp')}
          </p>

          <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0 6px' }} />
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-dim)' }}>{t('settings.integ.title')}</div>
          <IntegrationStatus
            source="mikrotik"
            onTest={() => api.mikrotikTest().then((r) => ({
              ok: r.tested > 0 && r.results.every((x) => x.ok),
              summary: r.tested === 0
                ? t('settings.integ.noRouters')
                : r.results.map((x) => `${x.site} ${x.ok ? `✓ ${x.count} (${x.ms} ms)` : `✗ ${x.error ?? ''}`}`).join(' · '),
            }))}
          />
        </Section>

        <Section title={t('settings.section.unifi')} description={t('settings.section.unifiDesc')}>
          <FieldGroup>
            <CheckField
              label={t('settings.field.unifiEnabled')}
              checked={value('unifi.enabled', '0') === '1'}
              onChange={(checked) => set('unifi.enabled', checked ? '1' : '0')}
            />
            <Field label={t('settings.field.unifiInterval')}>
              <IntervalInput v={value('unifi.interval_sec', '300')} onChange={(v) => set('unifi.interval_sec', v)} />
            </Field>
          </FieldGroup>
          <Field label={t('settings.field.unifiUrl')}>
            <input
              type="text"
              value={value('unifi.url', '')}
              onChange={(e) => set('unifi.url', e.target.value)}
              placeholder="https://10.8.2.229:8443"
              style={{ ...fieldStyle, width: '100%', minWidth: 320, fontFamily: 'Consolas, monospace' }}
            />
          </Field>
          <FieldGroup>
            <Field label={t('settings.field.unifiSite')}>
              <input
                type="text"
                value={value('unifi.site', 'default')}
                onChange={(e) => set('unifi.site', e.target.value)}
                style={{ ...fieldStyle, width: 140 }}
              />
            </Field>
            <Field label={t('settings.field.unifiUser')}>
              <input
                type="text"
                value={value('unifi.user', '')}
                onChange={(e) => set('unifi.user', e.target.value)}
                style={{ ...fieldStyle, width: 200 }}
              />
            </Field>
            <Field label={t('settings.field.unifiPassword')}>
              <input
                type="password"
                value={value('unifi.password', '')}
                onChange={(e) => set('unifi.password', e.target.value)}
                placeholder={t('settings.field.mikrotikPasswordPlaceholder')}
                autoComplete="new-password"
                style={{ ...fieldStyle, width: 200 }}
              />
            </Field>
          </FieldGroup>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '4px 0 0 0', lineHeight: 1.5 }}>
            {t('settings.field.unifiHelp')}
          </p>

          <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0 6px' }} />
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-dim)' }}>{t('settings.integ.title')}</div>
          <IntegrationStatus
            source="unifi"
            onTest={() => api.unifiRun().then((r) => ({
              ok: r.errors.length === 0 && r.clients > 0,
              summary: r.errors.length ? r.errors.join('; ') : `${r.upserted}/${r.clients} ${t('settings.integ.clients')} (${r.durationMs} ms)`,
            }))}
          />
        </Section>

        <Section title={t('settings.section.deviceWeb')} description={t('settings.section.deviceWebDesc')}>
          <CheckField
            label={t('settings.field.webProxy')}
            checked={value('devices.web_proxy', '1') === '1'}
            onChange={(checked) => set('devices.web_proxy', checked ? '1' : '0')}
          />
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '4px 0 12px 0', lineHeight: 1.5 }}>
            {t('settings.field.webProxyHelp')}
          </p>
          <Field label={t('settings.field.deviceCats')}>
            <textarea
              value={value('devices.categories', '')}
              onChange={(e) => set('devices.categories', e.target.value)}
              rows={6}
              placeholder={"printer=Tiskárna\nnetwork=Síťový prvek\nserver=Server\n…"}
              style={{ ...fieldStyle, width: '100%', minWidth: 320, fontFamily: 'Consolas, monospace', resize: 'vertical' }}
            />
          </Field>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '4px 0 12px 0', lineHeight: 1.5 }}>
            {t('settings.field.deviceCatsHelp')}
          </p>
          <FieldGroup>
            <Field label={t('settings.field.problemLoss')}>
              <NumberInput v={value('devices.problem_loss_pct', '1')} onChange={(v) => set('devices.problem_loss_pct', v)} suffix="%" />
            </Field>
            <Field label={t('settings.field.problemLatency')}>
              <NumberInput v={value('devices.problem_latency_ms', '50')} onChange={(v) => set('devices.problem_latency_ms', v)} suffix="ms" />
            </Field>
          </FieldGroup>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '4px 0 0 0', lineHeight: 1.5 }}>
            {t('settings.field.problemHelp')}
          </p>
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
          title={t('settings.section.faulty')}
          description={t('settings.section.faultyDesc')}
        >
          <FieldGroup>
            <Field label={t('settings.field.faultyWindow')}>
              <NumberInput
                v={value('faulty.window_days', '14')}
                onChange={(v) => set('faulty.window_days', v)}
                suffix={t('settings.unit.days')}
              />
            </Field>
            <Field label={t('settings.field.faultyCap')}>
              <NumberInput v={value('faulty.signature_cap', '20')} onChange={(v) => set('faulty.signature_cap', v)} />
            </Field>
            <Field label={t('settings.field.faultyWatch')}>
              <NumberInput v={value('faulty.threshold_watch', '400')} onChange={(v) => set('faulty.threshold_watch', v)} />
            </Field>
            <Field label={t('settings.field.faultyRisk')}>
              <NumberInput v={value('faulty.threshold_risk', '600')} onChange={(v) => set('faulty.threshold_risk', v)} />
            </Field>
          </FieldGroup>
          <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0 10px' }} />
          <Field label={t('settings.field.faultyNotebookOu')}>
            <textarea
              value={value('faulty.notebook_ou', '')}
              onChange={(e) => set('faulty.notebook_ou', e.target.value)}
              rows={2}
              placeholder={"Notebooky\nOU=NTB"}
              style={{ ...fieldStyle, width: '100%', minWidth: 320, fontFamily: 'Consolas, monospace', resize: 'vertical' }}
            />
          </Field>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '4px 0 12px 0', lineHeight: 1.5 }}>
            {t('settings.field.faultyNotebookOuHelp')}
          </p>
          <Field label={t('settings.field.faultySuppress')}>
            <textarea
              value={value('faulty.suppress_notebook', '')}
              onChange={(e) => set('faulty.suppress_notebook', e.target.value)}
              rows={4}
              placeholder={"NETLOGON/5719\nMicrosoft-Windows-GroupPolicy/1129\nNetwtw*/*"}
              style={{ ...fieldStyle, width: '100%', minWidth: 320, fontFamily: 'Consolas, monospace', resize: 'vertical' }}
            />
          </Field>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '4px 0 0 0', lineHeight: 1.5 }}>
            {t('settings.field.faultySuppressHelp')}
          </p>
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
            <Field label={t('settings.field.eventsSummaryWindow')}>
              <NumberInput
                v={value('events.summary_window_days', '1')}
                onChange={(v) => set('events.summary_window_days', v)}
                suffix={t('settings.unit.days')}
              />
            </Field>
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
            {t('settings.field.eventsSummaryWindowHelp')}
          </p>
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
            <CheckField
              label={t('settings.field.newPcsDisk')}
              checked={value('adsync.default_disk_email_monitor', 'false') === 'true'}
              onChange={(checked) => set('adsync.default_disk_email_monitor', String(checked))}
            />
            <CheckField
              label={t('settings.field.newPcsServices')}
              checked={value('adsync.default_service_monitor', 'false') === 'true'}
              onChange={(checked) => set('adsync.default_service_monitor', String(checked))}
            />
            <CheckField
              label={t('settings.field.newPcsCritServices')}
              checked={value('adsync.default_service_email_monitor', 'false') === 'true'}
              onChange={(checked) => set('adsync.default_service_email_monitor', String(checked))}
            />
            <CheckField
              label={t('settings.field.newPcsExcluded')}
              checked={value('adsync.default_excluded', 'false') === 'true'}
              onChange={(checked) => set('adsync.default_excluded', String(checked))}
            />
          </FieldGroup>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '8px 0 0 0' }}>
            {t('settings.field.newPcsDefaultsHelp')}
          </p>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '4px 0 0 0' }}>
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
          <FieldGroup>
            <Field label={t('settings.field.critDrives')}>
              <input
                type="text"
                value={value('disk.crit_drives', value('disk.eval_drive_letters', 'C'))}
                onChange={(e) => set('disk.crit_drives', e.target.value)}
                placeholder="C   |   C,D   |   <>C   |   *"
                style={{ ...fieldStyle, minWidth: 200, fontFamily: 'Consolas, monospace' }}
                title="Letters of drives evaluated for critical thresholds. Supports list (C,D) or exclusion (<>C, !C)."
              />
            </Field>
            <Field label={t('settings.field.warnDrives')}>
              <input
                type="text"
                value={value('disk.warn_drives', value('disk.eval_drive_letters', 'C'))}
                onChange={(e) => set('disk.warn_drives', e.target.value)}
                placeholder="C   |   <>C   |   !C,D   |   *"
                style={{ ...fieldStyle, minWidth: 200, fontFamily: 'Consolas, monospace' }}
                title="Letters of drives evaluated for warning thresholds. Supports list (C,D) or exclusion (<>C, !C)."
              />
            </Field>
          </FieldGroup>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '4px 0 0 0', lineHeight: 1.5 }}>
            {t('settings.field.driveSyntaxHelp')}
          </p>
        </Section>

        <Section title={t('settings.section.email')} description={t('settings.section.emailDesc')}>
          <FieldGroup>
            <Field label={t('settings.field.smtpHost')}>
              <input
                type="text"
                value={value('alerts.smtp_host', '')}
                onChange={(e) => set('alerts.smtp_host', e.target.value)}
                placeholder="smtp.firma.local"
                style={{ ...fieldStyle, minWidth: 220 }}
              />
            </Field>
            <Field label={t('settings.field.smtpPort')}>
              <NumberInput v={value('alerts.smtp_port', '25')} onChange={(v) => set('alerts.smtp_port', v)} />
            </Field>
            <Field label={t('settings.field.smtpFrom')}>
              <input
                type="text"
                value={value('alerts.smtp_from', '')}
                onChange={(e) => set('alerts.smtp_from', e.target.value)}
                placeholder="itdashboard@firma.cz"
                style={{ ...fieldStyle, minWidth: 220 }}
              />
            </Field>
          </FieldGroup>
          <Field label={t('settings.field.recipients')}>
            <textarea
              value={value('alerts.recipients', '')}
              onChange={(e) => set('alerts.recipients', e.target.value)}
              placeholder={t('settings.field.recipientsPlaceholder')}
              rows={3}
              style={{ ...fieldStyle, width: '100%', minWidth: 320, fontFamily: 'inherit', resize: 'vertical' }}
            />
          </Field>
          <Field label={t('settings.field.dashboardUrl')}>
            <input
              type="text"
              value={value('alerts.dashboard_url', '')}
              onChange={(e) => set('alerts.dashboard_url', e.target.value)}
              placeholder="http://10.8.2.213:4000"
              style={{ ...fieldStyle, width: '100%', minWidth: 320 }}
            />
          </Field>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '4px 0 0 0', lineHeight: 1.5 }}>
            {t('settings.field.emailHelp')}
          </p>
        </Section>

        <Section title={t('settings.section.diskAlerts')} description={t('settings.section.diskAlertsDesc')}>
          <FieldGroup>
            <CheckField
              label={t('settings.field.diskAlertsEnabled')}
              checked={value('alerts.disk.enabled', '0') === '1'}
              onChange={(checked) => set('alerts.disk.enabled', checked ? '1' : '0')}
            />
            <Field label={t('settings.field.diskAlertsFrequency')}>
              <NumberInput
                v={value('alerts.disk.frequency_hours', '24')}
                onChange={(v) => set('alerts.disk.frequency_hours', v)}
                suffix={t('settings.unit.hour24')}
              />
            </Field>
          </FieldGroup>
          <Field label={t('settings.field.recipientsDiskOverride')}>
            <textarea
              value={value('alerts.disk.recipients', '')}
              onChange={(e) => set('alerts.disk.recipients', e.target.value)}
              placeholder={t('settings.field.recipientsOverridePlaceholder')}
              rows={2}
              style={{ ...fieldStyle, width: '100%', minWidth: 320, fontFamily: 'inherit', resize: 'vertical' }}
            />
          </Field>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '4px 0 8px 0', lineHeight: 1.5 }}>
            {t('settings.field.diskAlertsHelp')}
          </p>
          <DiskAlertTestButton onSaveFirst={save} hasUnsaved={hasChanges} />
        </Section>

        <Section title={t('settings.section.svcAlerts')} description={t('settings.section.svcAlertsDesc')}>
          <FieldGroup>
            <CheckField
              label={t('settings.field.svcAlertsEnabled')}
              checked={value('alerts.services.enabled', '0') === '1'}
              onChange={(checked) => set('alerts.services.enabled', checked ? '1' : '0')}
            />
            <Field label={t('settings.field.svcDebounce')}>
              <NumberInput v={value('alerts.services.debounce_minutes', '10')} onChange={(v) => set('alerts.services.debounce_minutes', v)} suffix={t('settings.unit.minutes')} />
            </Field>
            <Field label={t('settings.field.svcFrequency')}>
              <NumberInput v={value('alerts.services.frequency_hours', '24')} onChange={(v) => set('alerts.services.frequency_hours', v)} suffix={t('settings.unit.hour24')} />
            </Field>
            <Field label={t('settings.field.svcMaintenance')}>
              <input
                type="text"
                value={value('alerts.services.maintenance_window', '')}
                onChange={(e) => set('alerts.services.maintenance_window', e.target.value)}
                placeholder="02:00-04:00"
                style={{ ...fieldStyle, minWidth: 130, fontFamily: 'Consolas, monospace' }}
              />
            </Field>
          </FieldGroup>
          <Field label={t('settings.field.svcCritical')}>
            <textarea
              value={value('alerts.services.critical_names', '')}
              onChange={(e) => set('alerts.services.critical_names', e.target.value)}
              rows={2}
              placeholder="NTDS, DNS, Kdc, Netlogon, W32Time, …"
              style={{ ...fieldStyle, width: '100%', minWidth: 320, fontFamily: 'Consolas, monospace', resize: 'vertical' }}
            />
          </Field>
          <Field label={t('settings.field.svcWhitelist')}>
            <textarea
              value={value('alerts.services.whitelist', '')}
              onChange={(e) => set('alerts.services.whitelist', e.target.value)}
              rows={2}
              placeholder={t('settings.field.svcWhitelistPlaceholder')}
              style={{ ...fieldStyle, width: '100%', minWidth: 320, fontFamily: 'Consolas, monospace', resize: 'vertical' }}
            />
          </Field>
          <Field label={t('settings.field.recipientsSvcOverride')}>
            <textarea
              value={value('alerts.services.recipients', '')}
              onChange={(e) => set('alerts.services.recipients', e.target.value)}
              placeholder={t('settings.field.recipientsOverridePlaceholder')}
              rows={2}
              style={{ ...fieldStyle, width: '100%', minWidth: 320, fontFamily: 'inherit', resize: 'vertical' }}
            />
          </Field>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '4px 0 8px 0', lineHeight: 1.5 }}>
            {t('settings.field.svcAlertsHelp')}
          </p>
          <ServiceAlertTestButton onSaveFirst={save} hasUnsaved={hasChanges} />

          <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0 10px' }} />
          <FieldGroup>
            <CheckField
              label={t('settings.field.portChecksEnabled')}
              checked={value('alerts.services.port_checks_enabled', '0') === '1'}
              onChange={(checked) => set('alerts.services.port_checks_enabled', checked ? '1' : '0')}
            />
            <Field label={t('settings.field.portTimeout')}>
              <NumberInput v={value('alerts.services.port_timeout_ms', '2000')} onChange={(v) => set('alerts.services.port_timeout_ms', v)} suffix="ms" />
            </Field>
          </FieldGroup>
          <Field label={t('settings.field.portList')}>
            <input
              type="text"
              value={value('alerts.services.port_checks', '')}
              onChange={(e) => set('alerts.services.port_checks', e.target.value)}
              placeholder="LDAP:389, SMB:445, RDP:3389, Kerberos:88, DNS:53"
              style={{ ...fieldStyle, width: '100%', minWidth: 320, fontFamily: 'Consolas, monospace' }}
            />
          </Field>
          <Field label={t('settings.field.recipientsPortOverride')}>
            <textarea
              value={value('alerts.ports.recipients', '')}
              onChange={(e) => set('alerts.ports.recipients', e.target.value)}
              placeholder={t('settings.field.recipientsOverridePlaceholder')}
              rows={2}
              style={{ ...fieldStyle, width: '100%', minWidth: 320, fontFamily: 'inherit', resize: 'vertical' }}
            />
          </Field>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '4px 0 8px 0', lineHeight: 1.5 }}>
            {t('settings.field.portChecksHelp')}
          </p>
          <PortAlertTestButton onSaveFirst={save} hasUnsaved={hasChanges} />
        </Section>

        <Section title={t('settings.section.printerAlerts')} description={t('settings.section.printerAlertsDesc')}>
          <FieldGroup>
            <CheckField
              label={t('settings.field.printerAlertsEnabled')}
              checked={value('alerts.printers.enabled', '0') === '1'}
              onChange={(checked) => set('alerts.printers.enabled', checked ? '1' : '0')}
            />
            <Field label={t('settings.field.printerDebounce')}>
              <NumberInput v={value('alerts.printers.debounce_minutes', '10')} onChange={(v) => set('alerts.printers.debounce_minutes', v)} suffix={t('settings.unit.minutes')} />
            </Field>
            <Field label={t('settings.field.printerFrequency')}>
              <NumberInput v={value('alerts.printers.frequency_hours', '24')} onChange={(v) => set('alerts.printers.frequency_hours', v)} suffix={t('settings.unit.hour24')} />
            </Field>
            <Field label={t('settings.field.printerMaintenance')}>
              <input
                type="text"
                value={value('alerts.printers.maintenance_window', '')}
                onChange={(e) => set('alerts.printers.maintenance_window', e.target.value)}
                placeholder="02:00-04:00"
                style={{ ...fieldStyle, minWidth: 130, fontFamily: 'Consolas, monospace' }}
              />
            </Field>
          </FieldGroup>
          <Field label={t('settings.field.printerRecipients')}>
            <textarea
              value={value('alerts.printers.recipients', '')}
              onChange={(e) => set('alerts.printers.recipients', e.target.value)}
              placeholder={t('settings.field.recipientsOverridePlaceholder')}
              rows={2}
              style={{ ...fieldStyle, width: '100%', minWidth: 320, fontFamily: 'inherit', resize: 'vertical' }}
            />
          </Field>
          <PrinterAlertTestButton onSaveFirst={save} hasUnsaved={hasChanges} />
        </Section>

        <Section title={t('settings.section.freshnessAlerts')} description={t('settings.section.freshnessAlertsDesc')}>
          <FieldGroup>
            <CheckField
              label={t('settings.field.freshnessEnabled')}
              checked={value('alerts.freshness.enabled', '1') === '1'}
              onChange={(checked) => set('alerts.freshness.enabled', checked ? '1' : '0')}
            />
            <Field label={t('settings.field.freshnessThreshold')}>
              <NumberInput v={value('alerts.freshness.threshold_minutes', '45')} onChange={(v) => set('alerts.freshness.threshold_minutes', v)} suffix={t('settings.unit.minutes')} />
            </Field>
            <Field label={t('settings.field.freshnessDebounce')}>
              <NumberInput v={value('alerts.freshness.debounce_minutes', '10')} onChange={(v) => set('alerts.freshness.debounce_minutes', v)} suffix={t('settings.unit.minutes')} />
            </Field>
            <Field label={t('settings.field.freshnessFrequency')}>
              <NumberInput v={value('alerts.freshness.frequency_hours', '24')} onChange={(v) => set('alerts.freshness.frequency_hours', v)} suffix={t('settings.unit.hour24')} />
            </Field>
            <Field label={t('settings.field.printerMaintenance')}>
              <input
                type="text"
                value={value('alerts.freshness.maintenance_window', '')}
                onChange={(e) => set('alerts.freshness.maintenance_window', e.target.value)}
                placeholder="02:00-04:00"
                style={{ ...fieldStyle, minWidth: 130, fontFamily: 'Consolas, monospace' }}
              />
            </Field>
          </FieldGroup>
          <Field label={t('settings.field.freshnessMutedSites')}>
            <textarea
              value={value('alerts.freshness.muted_sites', '')}
              onChange={(e) => set('alerts.freshness.muted_sites', e.target.value)}
              placeholder="Zastavka, Svitavy, Jihlava"
              rows={2}
              style={{ ...fieldStyle, width: '100%', minWidth: 320, fontFamily: 'inherit', resize: 'vertical' }}
            />
          </Field>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '4px 0 8px 0', lineHeight: 1.5 }}>
            {t('settings.field.freshnessMutedHelp')}
          </p>
          <Field label={t('settings.field.printerRecipients')}>
            <textarea
              value={value('alerts.freshness.recipients', '')}
              onChange={(e) => set('alerts.freshness.recipients', e.target.value)}
              placeholder={t('settings.field.recipientsOverridePlaceholder')}
              rows={2}
              style={{ ...fieldStyle, width: '100%', minWidth: 320, fontFamily: 'inherit', resize: 'vertical' }}
            />
          </Field>
          <FreshnessAlertTestButton onSaveFirst={save} hasUnsaved={hasChanges} />
        </Section>

        <Section title={t('settings.section.reportEmail')} description={t('settings.section.reportEmailDesc')}>
          <Field label={t('settings.field.recipientsReportOverride')}>
            <textarea
              value={value('alerts.reports.recipients', '')}
              onChange={(e) => set('alerts.reports.recipients', e.target.value)}
              placeholder={t('settings.field.recipientsOverridePlaceholder')}
              rows={2}
              style={{ ...fieldStyle, width: '100%', minWidth: 320, fontFamily: 'inherit', resize: 'vertical' }}
            />
          </Field>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '4px 0 0 0', lineHeight: 1.5 }}>
            {t('settings.field.reportEmailHelp')}
          </p>
        </Section>

      </div>
    </div>
    </SettingsFilterContext.Provider>
  );
}

function DiskAlertTestButton({ onSaveFirst, hasUnsaved }: { onSaveFirst: () => Promise<void>; hasUnsaved: boolean }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      // The test sends from the server using SAVED settings, so persist any
      // pending form edits first — otherwise it reads stale/empty values and
      // fails with "not configured" even though the form looks filled in.
      if (hasUnsaved) await onSaveFirst();
      const r = await api.sendDiskAlertTest();
      setResult(t('settings.field.diskAlertsTestOk')
        .replace('{recipients}', String(r.recipients))
        .replace('{critical}', String(r.critical)));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <button className="refresh-btn" onClick={send} disabled={busy}>
        {busy ? t('settings.field.diskAlertsTesting') : t('settings.field.diskAlertsTest')}
      </button>
      {result && <span style={{ color: 'var(--ok)', fontSize: 12 }}>✓ {result}</span>}
      {error && <span style={{ color: 'var(--critical)', fontSize: 12 }}>⚠ {error}</span>}
    </div>
  );
}

function ServiceAlertTestButton({ onSaveFirst, hasUnsaved }: { onSaveFirst: () => Promise<void>; hasUnsaved: boolean }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      if (hasUnsaved) await onSaveFirst();
      const r = await api.sendServiceAlertTest();
      setResult(t('settings.field.svcAlertsTestOk')
        .replace('{recipients}', String(r.recipients))
        .replace('{down}', String(r.down)));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <button className="refresh-btn" onClick={send} disabled={busy}>
        {busy ? t('settings.field.diskAlertsTesting') : t('settings.field.diskAlertsTest')}
      </button>
      {result && <span style={{ color: 'var(--ok)', fontSize: 12 }}>✓ {result}</span>}
      {error && <span style={{ color: 'var(--critical)', fontSize: 12 }}>⚠ {error}</span>}
    </div>
  );
}

function PortAlertTestButton({ onSaveFirst, hasUnsaved }: { onSaveFirst: () => Promise<void>; hasUnsaved: boolean }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      if (hasUnsaved) await onSaveFirst();
      const r = await api.sendPortAlertTest();
      setResult(t('settings.field.svcAlertsTestOk')
        .replace('{recipients}', String(r.recipients))
        .replace('{down}', String(r.down)));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <button className="refresh-btn" onClick={send} disabled={busy}>
        {busy ? t('settings.field.portTesting') : t('settings.field.portTest')}
      </button>
      {result && <span style={{ color: 'var(--ok)', fontSize: 12 }}>✓ {result}</span>}
      {error && <span style={{ color: 'var(--critical)', fontSize: 12 }}>⚠ {error}</span>}
    </div>
  );
}

function PrinterAlertTestButton({ onSaveFirst, hasUnsaved }: { onSaveFirst: () => Promise<void>; hasUnsaved: boolean }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      if (hasUnsaved) await onSaveFirst();
      const r = await api.sendPrinterAlertTest();
      setResult(t('settings.field.printerTestOk')
        .replace('{recipients}', String(r.recipients))
        .replace('{offline}', String(r.offline)));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <button className="refresh-btn" onClick={send} disabled={busy}>
        {busy ? t('settings.field.printerTesting') : t('settings.field.printerTest')}
      </button>
      {result && <span style={{ color: 'var(--ok)', fontSize: 12 }}>✓ {result}</span>}
      {error && <span style={{ color: 'var(--critical)', fontSize: 12 }}>⚠ {error}</span>}
    </div>
  );
}

function FreshnessAlertTestButton({ onSaveFirst, hasUnsaved }: { onSaveFirst: () => Promise<void>; hasUnsaved: boolean }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      if (hasUnsaved) await onSaveFirst();
      const r = await api.sendFreshnessAlertTest();
      setResult(t('settings.field.freshnessTestOk')
        .replace('{recipients}', String(r.recipients))
        .replace('{stale}', String(r.stale)));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <button className="refresh-btn" onClick={send} disabled={busy}>
        {busy ? t('settings.field.freshnessTesting') : t('settings.field.freshnessTest')}
      </button>
      {result && <span style={{ color: 'var(--ok)', fontSize: 12 }}>✓ {result}</span>}
      {error && <span style={{ color: 'var(--critical)', fontSize: 12 }}>⚠ {error}</span>}
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
  const q = React.useContext(SettingsFilterContext);
  if (q && !`${title} ${description ?? ''}`.toLowerCase().includes(q)) return null;
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

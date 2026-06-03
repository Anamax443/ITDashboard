import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { HelpBox } from '../components/HelpBox.js';

const PERIODIC_CHECKS = [
  { key: 'checks.run_eventlog', label: 'Eventlog collector' },
  { key: 'checks.run_disk', label: 'Disk scan' },
  { key: 'checks.run_services', label: 'Services scan' },
  { key: 'checks.run_perf', label: 'Perf events (slow boot/shutdown)' },
  { key: 'checks.run_adsync', label: 'AD sync (off by default in periodic)' },
] as const;

const SCHEDULE_DAYS = [
  { value: 1, label: 'Po' },
  { value: 2, label: 'Út' },
  { value: 3, label: 'St' },
  { value: 4, label: 'Čt' },
  { value: 5, label: 'Pá' },
  { value: 6, label: 'So' },
  { value: 0, label: 'Ne' },
] as const;

function NetworkAccessSection() {
  const [ips, setIps] = useState<string[]>([]);
  const [draft, setDraft] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api.firewallWhitelist()
      .then((r) => { setIps(r.ips); setDraft(r.ips.join('\n')); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
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
      setMessage(`Saved ${result.ips.length} IP entries`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const dirty = draft.trim() !== ips.join('\n');

  return (
    <div style={{ marginBottom: 32, paddingBottom: 24, borderBottom: '1px solid var(--border)' }}>
      <h3 style={{ margin: '0 0 4px 0', fontSize: 16 }}>Network access (API firewall whitelist)</h3>
      <p style={{ margin: '0 0 16px 0', color: 'var(--text-dim)', fontSize: 12 }}>
        Only listed IPs / CIDRs can reach the API on port 4000. Domain profile only.
        Changes apply immediately to the Windows Firewall rule "ITDashboard API (4000)".
      </p>
      {loading ? (
        <div style={{ color: 'var(--text-dim)' }}>Loading current whitelist…</div>
      ) : (
        <>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>
            One per line (IP or CIDR, e.g. 10.8.2.50 or 10.8.2.0/24)
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
              {saving ? 'Saving…' : 'Apply'}
            </button>
            {dirty && <span style={{ color: 'var(--warning)', fontSize: 11 }}>unsaved changes</span>}
            {message && <span style={{ color: 'var(--ok)', fontSize: 11 }}>✓ {message}</span>}
            {error && <span style={{ color: 'var(--critical)', fontSize: 11 }}>⚠ {error}</span>}
          </div>
          <div style={{ marginTop: 6, color: 'var(--text-dim)', fontSize: 11 }}>
            Current ({ips.length}): {ips.join(', ') || '(none)'}
          </div>
        </>
      )}
    </div>
  );
}

export function SettingsPage() {
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
      await api.saveSettings(dirty);
      setSettings({ ...settings, ...dirty });
      setDirty({});
      setMessage(`Saved ${Object.keys(dirty).length} value(s)`);
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
        <h2>Settings</h2>
        <div className="panel-actions filters">
          {message && <span style={{ color: 'var(--ok)', fontSize: 11 }}>✓ {message}</span>}
          {error && <span style={{ color: 'var(--critical)', fontSize: 11 }}>⚠ {error}</span>}
          {hasChanges && <span style={{ color: 'var(--warning)', fontSize: 11 }}>{Object.keys(dirty).length} unsaved change(s)</span>}
          <button className="refresh-btn" onClick={save} disabled={!hasChanges || saving} style={{ minWidth: 80 }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      <div className="panel-body" style={{ padding: 24 }}>

        <HelpBox title="What this tab does">
          <p>Configure all background-scan intervals, dashboard thresholds, and which IPs may reach the API. All settings persist in the DB and apply live — no service restart needed.</p>
          <p><strong>Periodic checks</strong> — how often the scheduler runs, on which days/time window, and which checks are included. Manual runs are still allowed outside the window.</p>
          <p><strong>Network access</strong> — Windows Firewall whitelist for inbound 4000. Be careful: removing your own IP locks you out (you'd need RDP to fix it).</p>
          <p><strong>Disk space thresholds</strong> — when a drive's free % or GB drops below the threshold, it's flagged Critical / Warning on the dashboard and in Computers tab.</p>
        </HelpBox>

        <Section title="Periodic checks" description="One scheduler runs selected checks in order. Changes apply immediately, no service restart needed.">
          <Field label="Run every">
            <IntervalInput v={value('checks.interval_sec', '900')} onChange={(v) => set('checks.interval_sec', v)} />
          </Field>
          <Field label="Days">
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
                  {day.label}
                </button>
              ))}
            </div>
          </Field>
          <FieldGroup>
            <Field label="Window from">
              <input type="time" value={value('checks.window_start', '06:00')} onChange={(e) => set('checks.window_start', e.target.value)} style={{ ...fieldStyle, minWidth: 120 }} />
            </Field>
            <Field label="Window to">
              <input type="time" value={value('checks.window_end', '18:00')} onChange={(e) => set('checks.window_end', e.target.value)} style={{ ...fieldStyle, minWidth: 120 }} />
            </Field>
          </FieldGroup>
          <FieldGroup>
            {PERIODIC_CHECKS.map((check) => (
              <CheckField
                key={check.key}
                label={check.label}
                checked={value(check.key, 'true') === 'true'}
                onChange={(checked) => set(check.key, String(checked))}
              />
            ))}
          </FieldGroup>
        </Section>

        <Section
          title="Perf-events lookback"
          description="How far back to scan on the very first sweep of a PC (cold-start). Subsequent sweeps go incrementally from the last collected event."
        >
          <Field label="Cold-start lookback (days)">
            <NumberInput
              v={value('perf.cold_start_days', '30')}
              onChange={(v) => set('perf.cold_start_days', v)}
              suffix="days"
            />
          </Field>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '0' }}>
            Default 30. Workstations are typically rebooted infrequently — a 7-day window often misses
            the previous boot's events. Range 1–365.
          </p>
        </Section>

        <Section
          title="AD sync defaults"
          description='Applied when AD sync discovers a new computer (existing PCs keep their current monitor flag — operator intent persists across syncs).'
        >
          <FieldGroup>
            <CheckField
              label="New PCs default to monitored (Monitor = on)"
              checked={value('adsync.default_monitor_enabled', 'true') === 'true'}
              onChange={(checked) => set('adsync.default_monitor_enabled', String(checked))}
            />
          </FieldGroup>
          <p style={{ color: 'var(--text-dim)', fontSize: 11, margin: '8px 0 0 0' }}>
            "Run all checks" always includes AD sync regardless of the periodic checkbox above.
          </p>
        </Section>

        <NetworkAccessSection />

        <Section title="Disk space thresholds" description="When a disk drops below these levels, it's flagged on the dashboard.">
          <Field label="Threshold mode">
            <select value={value('disk.threshold_mode', 'pct')} onChange={(e) => set('disk.threshold_mode', e.target.value)} style={fieldStyle}>
              <option value="pct">Percent free only</option>
              <option value="gb">GB free only</option>
              <option value="either">Either (most strict wins)</option>
            </select>
          </Field>
          <FieldGroup>
            <Field label="Critical (% free)">
              <NumberInput v={value('disk.critical_pct', '5')} onChange={(v) => set('disk.critical_pct', v)} suffix="%" />
            </Field>
            <Field label="Warning (% free)">
              <NumberInput v={value('disk.warning_pct', '15')} onChange={(v) => set('disk.warning_pct', v)} suffix="%" />
            </Field>
          </FieldGroup>
          <FieldGroup>
            <Field label="Critical (GB free)">
              <NumberInput v={value('disk.critical_gb', '5')} onChange={(v) => set('disk.critical_gb', v)} suffix="GB" />
            </Field>
            <Field label="Warning (GB free)">
              <NumberInput v={value('disk.warning_gb', '20')} onChange={(v) => set('disk.warning_gb', v)} suffix="GB" />
            </Field>
          </FieldGroup>
        </Section>

      </div>
    </div>
  );
}

function IntervalInput({ v, onChange }: { v: string; onChange: (v: string) => void }) {
  // Show as number + unit selector (minutes/hours/seconds)
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
        <option value="sec">seconds</option>
        <option value="min">minutes</option>
        <option value="hour">hours</option>
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

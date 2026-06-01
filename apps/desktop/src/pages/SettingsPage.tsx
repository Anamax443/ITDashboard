import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

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

        <Section title="Collection intervals" description="How often each background task runs. Changes apply immediately, no service restart needed.">
          <FieldGroup>
            <Field label="Eventlog collector">
              <IntervalInput v={value('collector.interval_sec', '300')} onChange={(v) => set('collector.interval_sec', v)} />
            </Field>
            <Field label="Disk scan">
              <IntervalInput v={value('disk.interval_sec', '1800')} onChange={(v) => set('disk.interval_sec', v)} />
            </Field>
          </FieldGroup>
        </Section>

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

function FieldGroup({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>{children}</div>;
}

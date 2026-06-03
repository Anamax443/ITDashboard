import React, { useState } from 'react';
import type { DiskItem } from '../api.js';
import { api, API_BASE } from '../api.js';
import { useI18n } from '../i18n.js';

function launch(url: string): void {
  // Browser navigates to the custom-scheme URL; if a handler is registered
  // (via install-itd-handlers.cmd) Windows triggers it. Otherwise the
  // browser shows "no app handles this protocol" and the operator falls
  // back to the Copy / Download buttons on the same row.
  window.location.href = url;
}

// Browser security blocks running arbitrary native commands, so each action
// is one of: clipboard copy (operator pastes into Win+R) or generated file
// download (operator double-clicks in browser Downloads to launch). Custom
// URL protocol handlers would give true 1-click but require a per-operator
// registry install — kept as a follow-up.

interface Props {
  name: string;            // PC name, e.g. ZAST5W11
  fqdn?: string | null;
  ipAddress?: string | null;
  disks?: DiskItem[];      // for enumerating $-shares
  computerId?: number;     // for single-PC refresh endpoint
  onRefreshed?: () => void;
}

function downloadBlob(filename: string, content: string, type = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

function rdpFileContent(host: string): string {
  // Minimal .rdp file — mstsc fills the rest of the defaults.
  return [
    `full address:s:${host}`,
    'screen mode id:i:2',
    'use multimon:i:0',
    'audiomode:i:0',
    'redirectprinters:i:1',
    'redirectclipboard:i:1',
    'authentication level:i:2',
    'prompt for credentials:i:1',
    'negotiate security layer:i:1',
    '',
  ].join('\r\n');
}

function psexecBat(host: string): string {
  return [
    '@echo off',
    `title PsExec cmd on ${host}`,
    `psexec \\\\${host} cmd.exe`,
    'pause',
    '',
  ].join('\r\n');
}

function shareBat(host: string, drive: string): string {
  const letter = drive.replace(/:$/, '');
  return [
    '@echo off',
    `start "" explorer.exe \\\\${host}\\${letter}$`,
    '',
  ].join('\r\n');
}

export function PcActionsButton({ name, fqdn, ipAddress, disks, computerId, onRefreshed }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<{ ok: boolean; durationMs: number; steps: { step: string; ok: boolean; detail: string }[] } | null>(null);
  const onClose = () => setOpen(false);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1800);
  };

  const doRefresh = async () => {
    if (!computerId || refreshing) return;
    setRefreshing(true);
    setRefreshResult(null);
    try {
      const r = await api.refreshPc(computerId);
      setRefreshResult({ ok: r.ok, durationMs: r.durationMs, steps: r.steps });
      flash(t('actions.refreshDone').replace('{sec}', (r.durationMs / 1000).toFixed(1)));
      if (onRefreshed) onRefreshed();
    } catch (e) {
      flash(`${t('actions.refreshFailed')}: ${String(e).slice(0, 100)}`);
    } finally {
      setRefreshing(false);
    }
  };

  const compmgmtCmd = `mmc.exe compmgmt.msc /computer=${name}`;
  const servicesCmd = `mmc.exe services.msc /computer=${name}`;
  const eventvwrCmd = `mmc.exe eventvwr.msc /computer=${name}`;
  const taskmgrCmd = `mmc.exe taskschd.msc /computer=${name}`;

  return (
    <>
      <button
        className="refresh-btn"
        onClick={() => setOpen(!open)}
        title={t('actions.title')}
        style={{ padding: '2px 8px', fontSize: 11 }}
      >⚡ {t('actions.title')}</button>

      {open && (
        <div
          onClick={onClose}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1100,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
              minWidth: 520, maxWidth: '90vw', maxHeight: '85vh', overflowY: 'auto', color: 'var(--text)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>
                {t('actions.title')} · <span style={{ color: 'var(--accent)' }}>{name}</span>
              </h3>
              <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', fontSize: 18, cursor: 'pointer' }}>×</button>
            </div>

            <div style={{ padding: 16, fontSize: 12, lineHeight: 1.6 }}>
              {computerId && (
                <div style={{
                  background: 'rgba(34, 197, 94, 0.10)',
                  border: '1px solid var(--ok)',
                  borderRadius: 4, padding: '10px 12px', marginBottom: 12,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{t('actions.refreshTitle')}</div>
                      <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 2 }}>{t('actions.refreshDesc')}</div>
                    </div>
                    <button
                      className="refresh-btn"
                      onClick={doRefresh}
                      disabled={refreshing}
                      style={{ background: 'var(--ok)', color: 'white', border: 'none', padding: '4px 12px', fontSize: 12, fontWeight: 600 }}
                    >{refreshing ? t('actions.refreshing') : t('actions.refreshNow')}</button>
                  </div>
                  {refreshResult && (
                    <div style={{ marginTop: 8, fontSize: 11 }}>
                      {refreshResult.steps.map((s) => (
                        <div key={s.step} style={{ display: 'flex', gap: 6 }}>
                          <span style={{ color: s.ok ? 'var(--ok)' : 'var(--critical)' }}>{s.ok ? '✓' : '✗'}</span>
                          <span style={{ minWidth: 80 }}>{s.step}</span>
                          <span style={{ color: 'var(--text-dim)' }}>{s.detail}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <p style={{ marginTop: 0, color: 'var(--text-dim)' }}>{t('actions.hint')}</p>
              <div style={{
                background: 'rgba(59, 130, 246, 0.08)',
                border: '1px solid var(--accent)',
                borderRadius: 4, padding: '8px 12px', marginBottom: 12, fontSize: 11,
              }}>
                <div>{t('actions.installBanner')}</div>
                <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <a
                    href={`${API_BASE}/actions/install-handlers.cmd`}
                    className="refresh-btn"
                    style={{ padding: '2px 10px', fontSize: 11, textDecoration: 'none', color: 'var(--text)' }}
                  >📦 {t('actions.installDownload')}</a>
                  <button
                    className="refresh-btn"
                    style={{ padding: '2px 10px', fontSize: 11, border: '1px solid var(--accent)' }}
                    onClick={async () => {
                      const cmd = `Invoke-WebRequest ${API_BASE}/actions/install-handlers.cmd -OutFile $env:TEMP\\install-handlers.cmd; & $env:TEMP\\install-handlers.cmd`;
                      (await copyText(cmd)) ? flash(t('actions.installCopiedPerUser')) : flash(t('actions.failed'));
                    }}
                  >📋 {t('actions.installCopyPerUser')}</button>
                  <button
                    className="refresh-btn"
                    style={{ padding: '2px 10px', fontSize: 11, border: '1px solid var(--accent)' }}
                    onClick={async () => {
                      const cmd = `Invoke-WebRequest ${API_BASE}/actions/install-handlers.cmd -OutFile $env:TEMP\\install-handlers.cmd; Start-Process cmd -ArgumentList "/c \`"$env:TEMP\\install-handlers.cmd\`" /machine" -Verb RunAs`;
                      (await copyText(cmd)) ? flash(t('actions.installCopiedMachine')) : flash(t('actions.failed'));
                    }}
                  >🛡 {t('actions.installCopyMachine')}</button>
                </div>
                <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-dim)' }}>{t('actions.installScopeHint')}</div>
              </div>
              <div style={{
                background: 'rgba(234, 179, 8, 0.10)',
                border: '1px solid var(--warning)',
                borderRadius: 4, padding: '8px 12px', marginBottom: 16, fontSize: 11,
                color: 'var(--text)',
              }}>
                <div style={{ marginBottom: 4 }}>⚠ {t('actions.installedNote')}</div>
                <div style={{ marginBottom: 4, color: 'var(--text-dim)' }}>{t('actions.validationNote')}</div>
                <div style={{ color: 'var(--text-dim)' }}>{t('actions.psexecOptIn')}</div>
                <div style={{ color: 'var(--text-dim)', marginTop: 4 }}>{t('actions.adminUserHint')}</div>
                <div style={{ color: 'var(--text-dim)', marginTop: 4 }}>{t('actions.followupNote')}</div>
                <div style={{ color: 'var(--text-dim)', marginTop: 4 }}>{t('actions.reinstallNote')}</div>
                <div style={{ color: 'var(--text-dim)', marginTop: 4 }}>{t('actions.consoleHardeningNote')}</div>
              </div>

              <Section title={t('actions.section.remote')}>
                <ActionRow
                  label={t('actions.compmgmt')}
                  hint={compmgmtCmd}
                  launchUrl={`itd-mmc://${name}`}
                  launchLabel={t('actions.launch')}
                  buttonLabel={t('actions.copyCmd')}
                  onClick={async () => { (await copyText(compmgmtCmd)) ? flash(t('actions.copied')) : flash(t('actions.failed')); }}
                />
                <ActionRow
                  label={t('actions.services')}
                  hint={servicesCmd}
                  launchUrl={`itd-services://${name}`}
                  launchLabel={t('actions.launch')}
                  buttonLabel={t('actions.copyCmd')}
                  onClick={async () => { (await copyText(servicesCmd)) ? flash(t('actions.copied')) : flash(t('actions.failed')); }}
                />
                <ActionRow
                  label={t('actions.eventvwr')}
                  hint={eventvwrCmd}
                  launchUrl={`itd-eventvwr://${name}`}
                  launchLabel={t('actions.launch')}
                  buttonLabel={t('actions.copyCmd')}
                  onClick={async () => { (await copyText(eventvwrCmd)) ? flash(t('actions.copied')) : flash(t('actions.failed')); }}
                />
                <ActionRow
                  label={t('actions.taskschd')}
                  hint={taskmgrCmd}
                  launchUrl={`itd-taskschd://${name}`}
                  launchLabel={t('actions.launch')}
                  buttonLabel={t('actions.copyCmd')}
                  onClick={async () => { (await copyText(taskmgrCmd)) ? flash(t('actions.copied')) : flash(t('actions.failed')); }}
                />
              </Section>

              <Section title={t('actions.section.access')}>
                <ActionRow
                  label={t('actions.rdp')}
                  hint={`${name}.rdp → mstsc`}
                  launchUrl={`itd-rdp://${name}`}
                  launchLabel={t('actions.launch')}
                  buttonLabel={t('actions.downloadFile')}
                  onClick={() => { downloadBlob(`${name}.rdp`, rdpFileContent(name)); flash(t('actions.downloaded')); }}
                />
                <ActionRow
                  label={t('actions.psexec')}
                  hint={`psexec \\\\${name} cmd.exe`}
                  launchUrl={`itd-psexec://${name}`}
                  launchLabel={t('actions.launch')}
                  buttonLabel={t('actions.downloadBat')}
                  onClick={() => { downloadBlob(`psexec-${name}.bat`, psexecBat(name)); flash(t('actions.downloaded')); }}
                />
                <ActionRow
                  label={t('actions.psRemote')}
                  hint={`Enter-PSSession -ComputerName ${name} -Credential (Get-Credential)`}
                  launchUrl={`itd-ps://${name}`}
                  launchLabel={t('actions.launch')}
                  buttonLabel={t('actions.copyCmd')}
                  onClick={async () => { (await copyText(`Enter-PSSession -ComputerName ${name} -Credential (Get-Credential)`)) ? flash(t('actions.copied')) : flash(t('actions.failed')); }}
                />
              </Section>

              <Section title={t('actions.section.shares')}>
                {(!disks || disks.length === 0) && (
                  <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>{t('actions.noDisks')}</div>
                )}
                {disks && disks.map((d) => {
                  const letter = d.drive_letter.replace(/:$/, '');
                  const unc = `\\\\${name}\\${letter}$`;
                  return (
                    <ActionRow
                      key={d.drive_letter}
                      label={`${d.drive_letter} (${d.volume_label ?? ''})`.trim()}
                      hint={unc}
                      launchUrl={`itd-explorer://${name}/${letter}`}
                      launchLabel={t('actions.launch')}
                      buttonLabel={t('actions.openShareBat')}
                      onClick={() => { downloadBlob(`open-${letter}-${name}.bat`, shareBat(name, d.drive_letter)); flash(t('actions.downloaded')); }}
                      secondary={{
                        label: t('actions.copyUnc'),
                        onClick: async () => { (await copyText(unc)) ? flash(t('actions.copied')) : flash(t('actions.failed')); },
                      }}
                    />
                  );
                })}
              </Section>

              <Section title={t('actions.section.copy')}>
                <ActionRow
                  label={t('actions.hostname')}
                  hint={name}
                  buttonLabel={t('actions.copy')}
                  onClick={async () => { (await copyText(name)) ? flash(t('actions.copied')) : flash(t('actions.failed')); }}
                />
                {fqdn && (
                  <ActionRow
                    label={t('actions.fqdn')}
                    hint={fqdn}
                    buttonLabel={t('actions.copy')}
                    onClick={async () => { (await copyText(fqdn)) ? flash(t('actions.copied')) : flash(t('actions.failed')); }}
                  />
                )}
                {ipAddress && (
                  <ActionRow
                    label={t('actions.ip')}
                    hint={ipAddress}
                    buttonLabel={t('actions.copy')}
                    onClick={async () => { (await copyText(ipAddress)) ? flash(t('actions.copied')) : flash(t('actions.failed')); }}
                  />
                )}
              </Section>

              {toast && (
                <div style={{ position: 'sticky', bottom: 0, marginTop: 12, color: 'var(--ok)', fontWeight: 600 }}>
                  ✓ {toast}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <h4 style={{ margin: '0 0 6px 0', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-dim)' }}>{title}</h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  );
}

function ActionRow({ label, hint, buttonLabel, onClick, secondary, launchUrl, launchLabel }: {
  label: string; hint: string; buttonLabel: string; onClick: () => void;
  secondary?: { label: string; onClick: () => void };
  launchUrl?: string;
  launchLabel?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px dashed var(--border)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'Consolas, monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{hint}</div>
      </div>
      {launchUrl && (
        <button
          className="refresh-btn"
          onClick={() => launch(launchUrl)}
          style={{ padding: '2px 10px', fontSize: 11, background: 'var(--accent)', color: 'white', border: 'none' }}
        >{launchLabel}</button>
      )}
      {secondary && (
        <button className="refresh-btn" onClick={secondary.onClick} style={{ padding: '2px 8px', fontSize: 11 }}>{secondary.label}</button>
      )}
      <button className="refresh-btn" onClick={onClick} style={{ padding: '2px 10px', fontSize: 11 }}>{buttonLabel}</button>
    </div>
  );
}

import React, { useState } from 'react';
import type { DiskItem } from '../api.js';
import { useI18n } from '../i18n.js';

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

export function PcActionsButton({ name, fqdn, ipAddress, disks }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const onClose = () => setOpen(false);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1800);
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
              <p style={{ marginTop: 0, color: 'var(--text-dim)' }}>{t('actions.hint')}</p>

              <Section title={t('actions.section.remote')}>
                <ActionRow
                  label={t('actions.compmgmt')}
                  hint={compmgmtCmd}
                  buttonLabel={t('actions.copyCmd')}
                  onClick={async () => { (await copyText(compmgmtCmd)) ? flash(t('actions.copied')) : flash(t('actions.failed')); }}
                />
                <ActionRow
                  label={t('actions.services')}
                  hint={servicesCmd}
                  buttonLabel={t('actions.copyCmd')}
                  onClick={async () => { (await copyText(servicesCmd)) ? flash(t('actions.copied')) : flash(t('actions.failed')); }}
                />
                <ActionRow
                  label={t('actions.eventvwr')}
                  hint={eventvwrCmd}
                  buttonLabel={t('actions.copyCmd')}
                  onClick={async () => { (await copyText(eventvwrCmd)) ? flash(t('actions.copied')) : flash(t('actions.failed')); }}
                />
                <ActionRow
                  label={t('actions.taskschd')}
                  hint={taskmgrCmd}
                  buttonLabel={t('actions.copyCmd')}
                  onClick={async () => { (await copyText(taskmgrCmd)) ? flash(t('actions.copied')) : flash(t('actions.failed')); }}
                />
              </Section>

              <Section title={t('actions.section.access')}>
                <ActionRow
                  label={t('actions.rdp')}
                  hint={`${name}.rdp → mstsc`}
                  buttonLabel={t('actions.downloadFile')}
                  onClick={() => { downloadBlob(`${name}.rdp`, rdpFileContent(name)); flash(t('actions.downloaded')); }}
                />
                <ActionRow
                  label={t('actions.psexec')}
                  hint={`psexec \\\\${name} cmd.exe`}
                  buttonLabel={t('actions.downloadBat')}
                  onClick={() => { downloadBlob(`psexec-${name}.bat`, psexecBat(name)); flash(t('actions.downloaded')); }}
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

function ActionRow({ label, hint, buttonLabel, onClick, secondary }: {
  label: string; hint: string; buttonLabel: string; onClick: () => void;
  secondary?: { label: string; onClick: () => void };
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px dashed var(--border)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'Consolas, monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{hint}</div>
      </div>
      {secondary && (
        <button className="refresh-btn" onClick={secondary.onClick} style={{ padding: '2px 8px', fontSize: 11 }}>{secondary.label}</button>
      )}
      <button className="refresh-btn" onClick={onClick} style={{ padding: '2px 10px', fontSize: 11 }}>{buttonLabel}</button>
    </div>
  );
}

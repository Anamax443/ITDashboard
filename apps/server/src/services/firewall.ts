import { spawn } from 'node:child_process';
import { logActivity } from './activity-log.js';

const RULE_DISPLAY_NAME = 'ITDashboard API (4000)';

function runPs(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    let out = '';
    let err = '';
    proc.stdout.on('data', (b) => (out += b.toString('utf8')));
    proc.stderr.on('data', (b) => (err += b.toString('utf8')));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `exit ${code}`));
      resolve(out.trim());
    });
  });
}

export async function getAllowedIPs(): Promise<string[]> {
  const ps = `
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$addr = (Get-NetFirewallRule -DisplayName '${RULE_DISPLAY_NAME}' -ErrorAction Stop |
  Get-NetFirewallAddressFilter).RemoteAddress
if ($addr -is [string]) { $addr = @($addr) }
$addr | ConvertTo-Json -Compress
`;
  const out = await runPs(ps);
  if (!out) return [];
  const parsed = JSON.parse(out) as string | string[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export interface DomainProfileStatus {
  enabled: boolean | null;   // null when query failed
  defaultInboundAction: string | null;
  error?: string;
}

// Reads whether the Windows Firewall Domain profile is enabled. On the live
// server the Domain profile is currently Enabled=False, which makes our
// 'ITDashboard API (4000)' allow rule inert — the OS firewall does not
// evaluate it. The frontend UX gate still works, but operators should know
// the OS-level boundary is down so they can choose to fix it (or accept it).
export async function getDomainProfileStatus(): Promise<DomainProfileStatus> {
  const ps = `
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$p = Get-NetFirewallProfile -Profile Domain -ErrorAction Stop
[pscustomobject]@{
  Enabled = [bool]$p.Enabled
  DefaultInboundAction = "$($p.DefaultInboundAction)"
} | ConvertTo-Json -Compress
`;
  try {
    const out = await runPs(ps);
    if (!out) return { enabled: null, defaultInboundAction: null, error: 'empty output' };
    const parsed = JSON.parse(out) as { Enabled: boolean; DefaultInboundAction: string };
    return {
      enabled: parsed.Enabled,
      defaultInboundAction: parsed.DefaultInboundAction ?? null,
    };
  } catch (err) {
    return {
      enabled: null,
      defaultInboundAction: null,
      error: String(err).split('\n')[0]?.slice(0, 200) ?? 'unknown',
    };
  }
}

export async function setAllowedIPs(ips: string[]): Promise<void> {
  // Validate input — only IPs and CIDRs allowed
  for (const ip of ips) {
    if (!/^[\d.:a-fA-F/]+$/.test(ip)) {
      throw new Error(`Invalid IP/CIDR: ${ip}`);
    }
  }
  if (ips.length === 0) {
    throw new Error('At least one allowed IP required (otherwise nobody can reach the API)');
  }

  const jsonArray = JSON.stringify(ips);
  const ps = `
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ips = '${jsonArray.replace(/'/g, "''")}' | ConvertFrom-Json
Set-NetFirewallRule -DisplayName '${RULE_DISPLAY_NAME}' -RemoteAddress $ips -ErrorAction Stop
'OK'
`;
  const out = await runPs(ps);
  if (out !== 'OK') throw new Error(`unexpected output: ${out}`);
  logActivity('success', 'firewall', `Whitelist updated: ${ips.join(', ')}`);
}

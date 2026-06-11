import { spawn } from 'node:child_process';

/**
 * Wraps ActiveDirectory PowerShell module (Get-ADComputer, Get-ADUser, …).
 * Requires RSAT-AD-PowerShell installed on the API host.
 */

export interface ADComputer {
  Name: string;
  DNSHostName: string;
  OperatingSystem: string;
  LastLogonDate: string | null;
  Enabled: boolean;
}

function runPs<T>(script: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    let out = '';
    let err = '';
    proc.stdout.on('data', (b) => (out += b.toString('utf8')));
    proc.stderr.on('data', (b) => (err += b.toString('utf8')));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `exit ${code}`));
      try {
        resolve(JSON.parse(out.trim() || 'null'));
      } catch (e) {
        reject(e);
      }
    });
  });
}

export async function listComputers(): Promise<ADComputer[]> {
  const ps = `
Import-Module ActiveDirectory
Get-ADComputer -Filter * -Properties OperatingSystem, LastLogonDate |
  Select-Object Name, DNSHostName, OperatingSystem,
    @{n='LastLogonDate';e={ if ($_.LastLogonDate) { $_.LastLogonDate.ToUniversalTime().ToString('o') } else { $null } }},
    Enabled |
  ConvertTo-Json -Compress -Depth 4
`;
  const r = await runPs<ADComputer[] | ADComputer | null>(ps);
  if (r == null) return [];
  return Array.isArray(r) ? r : [r];
}

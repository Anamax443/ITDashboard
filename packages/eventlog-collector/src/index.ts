import { spawn } from 'node:child_process';

export interface CollectOptions {
  computerName: string;
  username: string;
  passwordPlain: string;
  logNames: string[];
  levels: Array<1 | 2 | 3>;
  sinceUtc: Date;
  maxEvents?: number;
}

export interface RawEvent {
  TimeCreated: string;
  Id: number;
  Level: number;
  LogName: string;
  ProviderName: string;
  MachineName: string;
  Message: string;
  TaskDisplayName?: string;
}

/**
 * Pulls events from a remote PC via WinRM using PowerShell Get-WinEvent.
 * Returns parsed objects from JSON-piped output.
 *
 * Why PS subprocess instead of node-winrm: PS Remoting is the supported path in
 * AD environments, handles Kerberos/NTLM transparently, and matches operator
 * mental model when they're debugging from an interactive session.
 */
export function collectEvents(opts: CollectOptions): Promise<RawEvent[]> {
  const filter = {
    LogName: opts.logNames,
    Level: opts.levels,
    StartTime: opts.sinceUtc.toISOString(),
  };

  const ps = `
$ErrorActionPreference = 'Stop'
$secpass = ConvertTo-SecureString $env:ITDB_PWD -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential($env:ITDB_USER, $secpass)
$session = New-PSSession -ComputerName '${opts.computerName}' -Credential $cred -ErrorAction Stop
try {
  Invoke-Command -Session $session -ScriptBlock {
    param($filter, $max)
    Get-WinEvent -FilterHashtable $filter -MaxEvents $max -ErrorAction SilentlyContinue |
      Select-Object @{n='TimeCreated';e={$_.TimeCreated.ToUniversalTime().ToString('o')}},
        Id, Level, LogName, ProviderName, MachineName,
        @{n='Message';e={$_.Message}},
        @{n='TaskDisplayName';e={$_.TaskDisplayName}}
  } -ArgumentList (ConvertFrom-Json '${JSON.stringify(filter).replace(/'/g, "''")}'), ${opts.maxEvents ?? 1000} |
    ConvertTo-Json -Compress -Depth 6
} finally {
  Remove-PSSession $session
}
`;

  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      env: { ...process.env, ITDB_USER: opts.username, ITDB_PWD: opts.passwordPlain },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => (stdout += b.toString('utf8')));
    proc.stderr.on('data', (b) => (stderr += b.toString('utf8')));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`collector exit ${code}: ${stderr}`));
      try {
        const trimmed = stdout.trim();
        if (!trimmed) return resolve([]);
        const parsed = JSON.parse(trimmed);
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch (e) {
        reject(e);
      }
    });
  });
}

import { spawn } from 'node:child_process';

/**
 * Wraps Windows DPAPI via PowerShell. Encryption is bound to the user account
 * (CurrentUser scope) running the API service — only that account can decrypt.
 * The encrypted blob is stored in MSSQL but is opaque from the DB's perspective.
 */

function runPs(script: string, stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    let out = '';
    let err = '';
    proc.stdout.on('data', (b) => (out += b.toString('utf8')));
    proc.stderr.on('data', (b) => (err += b.toString('utf8')));
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))));
    if (stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
  });
}

export async function encryptSecret(plain: string): Promise<Buffer> {
  const ps = `
$plain = [Console]::In.ReadToEnd()
Add-Type -AssemblyName System.Security
$bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($enc))
`;
  const b64 = await runPs(ps, plain);
  return Buffer.from(b64.trim(), 'base64');
}

export async function decryptSecret(blob: Buffer): Promise<string> {
  const ps = `
$b64 = [Console]::In.ReadToEnd()
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String($b64)
$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($dec))
`;
  return (await runPs(ps, blob.toString('base64'))).trim();
}

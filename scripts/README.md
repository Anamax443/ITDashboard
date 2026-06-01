# Script catalog

Versioned PowerShell / Python / C# scripts callable from the desktop client via the API.

## Layout

```
scripts/
  powershell/
    ad-user-info.ps1       # Get-ADUser + group membership
    unlock-account.ps1     # Unlock-ADAccount
    reset-password.ps1     # Set-ADAccountPassword
    pc-services.ps1        # Get-Service on remote PC
  python/
  csharp/
```

## Manifest

Each script is registered in `manifest.json` (loaded by API into `scripts` table on startup):

```json
{
  "scripts": [
    {
      "slug": "ad-user-info",
      "name": "AD User info",
      "language": "powershell",
      "path": "powershell/ad-user-info.ps1",
      "params": [{ "name": "SamAccountName", "type": "string", "required": true }]
    }
  ]
}
```

## Adding a new script

1. Write the script in `powershell/`, `python/`, or `csharp/`.
2. Add an entry to `manifest.json`.
3. Commit + push — auto-deploy refreshes the catalog.

## Safety

- All scripts run on `10.8.2.213` under the API service account.
- Output is captured into `script_runs` table (stdout/stderr/exit code).
- Destructive scripts (reset password, disable account) require an extra confirmation flag in the desktop UI.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SamAccountName
)

$ErrorActionPreference = 'Stop'
Import-Module ActiveDirectory

$user = Get-ADUser -Identity $SamAccountName -Properties `
    DisplayName, EmailAddress, Enabled, LockedOut, PasswordLastSet, `
    PasswordExpired, LastLogonDate, MemberOf, Department, Title

$groups = $user.MemberOf | ForEach-Object {
    (Get-ADGroup -Identity $_).Name
}

[pscustomobject]@{
    SamAccountName  = $user.SamAccountName
    DisplayName     = $user.DisplayName
    Email           = $user.EmailAddress
    Department      = $user.Department
    Title           = $user.Title
    Enabled         = $user.Enabled
    LockedOut       = $user.LockedOut
    PasswordLastSet = $user.PasswordLastSet
    PasswordExpired = $user.PasswordExpired
    LastLogonDate   = $user.LastLogonDate
    Groups          = $groups
} | ConvertTo-Json -Depth 4

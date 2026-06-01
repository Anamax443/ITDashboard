[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ComputerName
)

$ErrorActionPreference = 'Stop'

Get-Service -ComputerName $ComputerName |
    Select-Object Name, DisplayName, Status, StartType |
    ConvertTo-Json -Depth 3

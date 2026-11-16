#Requires -Version 5.1
<#
.SYNOPSIS
  Dot-sourceable PowerShell loader for C:\aphrody\.env (`C:\aphrody\packages\env-kit\loaders\shell\load-env.ps1`).
  Never prints raw secret values. Does not override existing process env vars unless -Override is specified.
.EXAMPLE
  . C:\aphrody\packages\env-kit\loaders\shell\load-env.ps1
#>
param(
  [string]$EnvPath = "C:\aphrody\.env",
  [switch]$Override,
  [string[]]$Required = @(),
  [string]$Service = "powershell"
)

if (-not (Test-Path -LiteralPath $EnvPath)) {
  if ($Required.Count -gt 0) {
    throw "[$Service] Master .env not found at $EnvPath"
  }
  return
}

$loadedCount = 0
foreach ($rawLine in [System.IO.File]::ReadAllLines($EnvPath)) {
  $line = $rawLine.Trim()
  if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }
  if ($line.StartsWith('export ')) { $line = $line.Substring(7).Trim() }

  $eq = $line.IndexOf('=')
  if ($eq -le 0) { continue }

  $key = $line.Substring(0, $eq).Trim()
  if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { continue }

  $rawVal = $line.Substring($eq + 1).Trim()
  $val = ''
  if ($rawVal.StartsWith('"')) {
    $sb = New-Object System.Text.StringBuilder
    $esc = $false
    for ($i = 1; $i -lt $rawVal.Length; $i++) {
      $ch = $rawVal[$i]
      if ($esc) {
        switch ($ch) {
          'n' { [void]$sb.Append("`n") }
          'r' { [void]$sb.Append("`r") }
          't' { [void]$sb.Append("`t") }
          default { [void]$sb.Append($ch) }
        }
        $esc = $false
      } elseif ($ch -eq '\') {
        $esc = $true
      } elseif ($ch -eq '"') {
        break
      } else {
        [void]$sb.Append($ch)
      }
    }
    $val = $sb.ToString()
  } elseif ($rawVal.StartsWith("'")) {
    $endQ = $rawVal.IndexOf("'", 1)
    $val = if ($endQ -ge 1) { $rawVal.Substring(1, $endQ - 1) } else { $rawVal.Substring(1) }
  } else {
    if ($rawVal -match '^(.*?)\s+#.*$') {
      $rawVal = $Matches[1]
    }
    $val = $rawVal.Trim()
  }

  $existing = [Environment]::GetEnvironmentVariable($key, 'Process')
  if ($Override -or [string]::IsNullOrEmpty($existing)) {
    if ($val.Length -gt 0 -or $Override) {
      [Environment]::SetEnvironmentVariable($key, $val, 'Process')
      $loadedCount++
    }
  }
}

$missing = @()
foreach ($req in $Required) {
  $cur = [Environment]::GetEnvironmentVariable($req, 'Process')
  if ([string]::IsNullOrEmpty($cur)) {
    $missing += $req
  }
}

if ($missing.Count -gt 0) {
  throw "[service=$Service] Missing required environment keys ($($missing -join ', ')) after loading $EnvPath"
}

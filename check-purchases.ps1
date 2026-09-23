# 購入がどの経路 (confirm / webhook) で記録されたかを一覧する。
# 利用者 ID は表示しない (log: キーだけを読む)。
#   pwsh -File .\check-purchases.ps1          # デプロイ先の KV
#   pwsh -File .\check-purchases.ps1 -Local   # wrangler dev のローカル KV
param([switch]$Local)

Set-Location $PSScriptRoot
$where = if ($Local) { '--local' } else { '--remote' }
# 自分の環境の値を入れた wrangler.local.jsonc があればそれを使う
$config = if (Test-Path 'wrangler.local.jsonc') { 'wrangler.local.jsonc' } else { 'wrangler.jsonc' }

$ErrorActionPreference = 'Stop'

# wrangler は対話型のターミナルだと JSON の前に案内文を出すことがあるので、JSON の部分だけを取り出す
function Read-WranglerJson([string[]]$lines, [string]$open, [string]$close) {
    $out = $lines -join "`n"
    $start = $out.IndexOf($open)
    $end = $out.LastIndexOf($close)
    if ($start -lt 0 -or $end -lt $start) { throw "wrangler の出力を読み取れませんでした:`n$out" }
    $out.Substring($start, $end - $start + 1) | ConvertFrom-Json
}

$keys = Read-WranglerJson (npx --yes wrangler@4 kv key list --binding PURCHASES -c $config --prefix 'log:' $where 2>$null) '[' ']'
if (-not $keys) { 'log: の記録はありません'; return }

$rows = foreach ($k in $keys) {
    $null, $sessionId, $source = $k.name -split ':'
    $value = Read-WranglerJson (npx --yes wrangler@4 kv key get --binding PURCHASES -c $config $k.name $where 2>$null) '{' '}'
    [pscustomobject]@{
        Session = '...' + $sessionId.Substring($sessionId.Length - 8)
        Source  = $source
        Product = $value.productId
        At      = $value.at
    }
}
$rows | Sort-Object Session, At | Format-Table -AutoSize

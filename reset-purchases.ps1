# デモ用: 購入記録を消して全員を「未購入」に戻す。
# 既定では消す対象を表示するだけ。-Yes を付けたときだけ削除する。
# 経路ログ (log:) は記事の裏付けとして残す。-IncludeLogs で一緒に消す。
# Stripe 側の支払い記録 (テストモード) には触れない。
#
#   pwsh -File .\reset-purchases.ps1                    # 対象を確認
#   pwsh -File .\reset-purchases.ps1 -Yes               # 購入記録を削除
#   pwsh -File .\reset-purchases.ps1 -Yes -IncludeLogs  # 経路ログも削除
#   -Local を付けると wrangler dev のローカル KV が対象
param([switch]$Yes, [switch]$IncludeLogs, [switch]$Local)

Set-Location $PSScriptRoot
$where = if ($Local) { '--local' } else { '--remote' }
# 自分の環境の値を入れた wrangler.local.jsonc があればそれを使う
$config = if (Test-Path 'wrangler.local.jsonc') { 'wrangler.local.jsonc' } else { 'wrangler.jsonc' }

# wrangler は対話型のターミナルだと JSON の前に案内文を出すことがあるので、
# 出力から [ ... ] の部分だけを取り出して読む。読めなければ 0 件扱いにせず止める
function Get-Keys([string]$prefix) {
    $out = (npx --yes wrangler@4 kv key list --binding PURCHASES -c $config --prefix $prefix $where 2>$null) -join "`n"
    $start = $out.IndexOf('[')
    $end = $out.LastIndexOf(']')
    if ($start -lt 0 -or $end -lt $start) {
        throw "wrangler の出力から一覧を読み取れませんでした (wrangler login が切れていないか確認してください):`n$out"
    }
    $list = $out.Substring($start, $end - $start + 1) | ConvertFrom-Json
    @($list | ForEach-Object { $_.name } | Where-Object { $_ })
}
$ErrorActionPreference = 'Stop'

$purchases = Get-Keys 'purchase:'
$logs = if ($IncludeLogs) { Get-Keys 'log:' } else { @() }
$targets = @($purchases) + @($logs) | Where-Object { $_ }

$scope = if ($Local) { 'ローカル' } else { 'デプロイ先' }
"対象 ($scope の KV): 購入記録 $($purchases.Count) 件" + $(if ($IncludeLogs) { " / 経路ログ $($logs.Count) 件" } else { '' })
# 利用者 ID は表示せず、商品 ID だけ出す (purchase:<userId>:<productId>)
$purchases | ForEach-Object { '  - ' + ($_ -split ':')[-1] }

if ($targets.Count -eq 0) { '消すものはありません'; return }
if (-not $Yes) { '確認のみ。削除するには -Yes を付けて実行してください'; return }

$file = Join-Path ([IO.Path]::GetTempPath()) "woff-stripe-reset-$PID.json"
try {
    ConvertTo-Json -InputObject @($targets) | Set-Content -Path $file -Encoding utf8NoBOM
    npx --yes wrangler@4 kv bulk delete $file --binding PURCHASES -c $config $where --force 2>&1 |
        Where-Object { $_ -match 'Success|Deleted|error' }
} finally {
    Remove-Item $file -ErrorAction SilentlyContinue
}

$left = (Get-Keys 'purchase:').Count
"削除後の購入記録: $left 件"

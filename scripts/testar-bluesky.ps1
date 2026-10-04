<#
  Testa a credencial do Bluesky direto na API, sem passar pelo Postiz.

  Serve para separar "a senha esta errada" de "o Postiz esta enviando algo
  diferente". O Postiz engole o erro real e sempre mostra "Invalid credentials"
  (bluesky.provider.ts), entao o diagnostico precisa sair de fora.

  A senha e lida com -AsSecureString: nao aparece na tela nem no historico.

  Uso:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\testar-bluesky.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\testar-bluesky.ps1 -Handle voce.bsky.social
#>
param(
  [string]$Handle = 'itamidia.bsky.social',
  [string]$Service = 'https://bsky.social'
)

$ErrorActionPreference = 'Stop'

Write-Host "Service : $Service" -ForegroundColor DarkGray
Write-Host "Handle  : $Handle"  -ForegroundColor DarkGray

# Identificador: o Bluesky aceita handle ou email, e normaliza para minusculas.
$identifier = $Handle.Trim().ToLower()

Write-Host "`nDigite a APP PASSWORD (nao a senha da conta)." -ForegroundColor Yellow
$secure = Read-Host -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}

# O Postiz repassa o texto como veio do formulario. Se o erro for so no Postiz,
# o culpado costuma ser um espaco colado junto -- por isso o teste de whitespace.
Write-Host ("`nTamanho da senha: {0} caracteres" -f $password.Length)
if ($password -ne $password.Trim()) {
  Write-Warning "A senha tem espaco no inicio ou no fim. O Bluesky rejeita. Apague os espacos e tente de novo."
}

$body = @{ identifier = $identifier; password = $password } | ConvertTo-Json

try {
  $r = Invoke-RestMethod -Method Post -Uri "$Service/xrpc/com.atproto.server.createSession" `
       -ContentType 'application/json' -Body $body -TimeoutSec 25

  Write-Host "`nOK - credencial valida." -ForegroundColor Green
  Write-Host ("  handle : " + $r.handle)
  Write-Host ("  did    : " + $r.did)
  Write-Host "`nSe isso funciona mas o Postiz ainda falha, me mande a msg de erro que aparece na tela."
  exit 0

} catch {
  Write-Host "`nFALHOU" -ForegroundColor Red
  $detail = $_.ErrorDetails.Message
  if ($detail) {
    try {
      $j = $detail | ConvertFrom-Json
      Write-Host ("  erro    : " + $j.error)
      Write-Host ("  mensagem: " + $j.message)
    } catch {
      Write-Host ("  " + $detail)
    }
  } else {
    Write-Host ("  " + $_.Exception.Message)
  }

  Write-Host @"

Como ler:
  AuthenticationRequired  -> handle ou senha errados. Se a senha esta certa,
                              provavelmente colou a senha da conta em vez da
                              app password, ou a app password foi copiada incompleta.
  AuthFactorTokenRequired -> a conta tem 2FA ligado. Desligue nas configuracoes
                              do Bluesky, ou use uma conta sem 2FA.
  InvalidIdentifier       -> o handle nao existe. Confira a grafia.
  RateLimitExceeded       -> conta nova, muitas tentativas. Espere alguns minutos.

"@ -ForegroundColor DarkGray
  exit 1
}
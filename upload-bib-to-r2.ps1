# ============================================================================
# Envoi de bib.xml vers Cloudflare R2 - PowerShell pur, aucune installation
# requise (PowerShell est livre avec Windows). Reproduit exactement la
# signature AWS SigV4 utilisee par lib/r2.mjs (upload:bib) du projet
# douai-patrimoine.
#
# UTILISATION :
#   1. Remplissez les 4 valeurs ci-dessous (memes identifiants R2 que ceux
#      deja utilises sur le projet).
#   2. Verifiez/ajustez $FilePath (chemin local vers votre bib.xml).
#   3. Ouvrez PowerShell, placez-vous dans le dossier de ce script, puis :
#        powershell -ExecutionPolicy Bypass -File .\upload-bib-to-r2.ps1
#      (le flag -ExecutionPolicy Bypass ne s'applique qu'a cette execution,
#      ne necessite pas les droits admin, et ne change rien de permanent).
#      Si ca ne fonctionne toujours pas, ouvrez PowerShell et collez
#      directement tout le contenu de ce fichier dans la fenetre puis
#      Entree : l'execution de commandes tapees/collees n'est jamais
#      bloquee par la politique d'execution, seule l'execution d'un
#      FICHIER .ps1 peut l'etre.
# ============================================================================

# --- A REMPLIR -----------------------------------------------------------
$AccountId      = "4daa7ada5935d5e5943e8d6ac92dc5f7"
$Bucket         = "douai-patrimoine"
$AccessKeyId    = "281fa82452275769996729bf5865e12e"
$SecretAccessKey = "b1a569b6709e793316f35fbf582ad9145490904d761c46ea3df365861ec3b2b1"
$FilePath       = "data/xml/bib.xml"          # chemin local vers votre fichier
$Key            = "xml/bib.xml"      # cle R2 de destination (ne pas changer)
# ---------------------------------------------------------------------------

$ErrorActionPreference = "Stop"

if ($AccountId -like "COLLEZ_ICI*" -or $Bucket -like "COLLEZ_ICI*" -or
    $AccessKeyId -like "COLLEZ_ICI*" -or $SecretAccessKey -like "COLLEZ_ICI*") {
    Write-Host "Merci de remplir les 4 identifiants R2 en haut du script avant de le lancer." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $FilePath)) {
    Write-Host "Fichier introuvable : $FilePath" -ForegroundColor Red
    exit 1
}

function Get-SHA256HexOfString([string]$Text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text))
    } finally {
        $sha.Dispose()
    }
    return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function Get-HMACSHA256Bytes([byte[]]$KeyBytes, [string]$Data) {
    $hmac = New-Object System.Security.Cryptography.HMACSHA256
    $hmac.Key = $KeyBytes
    try {
        return $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Data))
    } finally {
        $hmac.Dispose()
    }
}

$fileInfo = Get-Item -LiteralPath $FilePath
$contentLength = $fileInfo.Length
Write-Host ("Fichier : {0} ({1:N1} Mo)" -f $fileInfo.FullName, ($contentLength / 1MB))

Write-Host "Calcul du hash SHA256 du fichier (peut prendre plusieurs minutes pour un gros fichier)..."
$payloadHash = (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash.ToLower()
Write-Host "  -> $payloadHash"

$rHost = "$AccountId.r2.cloudflarestorage.com"
$path = "/$Bucket/$Key"
$contentType = "application/xml"

$now = [DateTime]::UtcNow
$amzDate = $now.ToString("yyyyMMddTHHmmssZ")
$dateStamp = $now.ToString("yyyyMMdd")

$canonicalHeadersBlock = "content-length:$contentLength`n" +
                          "content-type:$contentType`n" +
                          "host:$rHost`n" +
                          "x-amz-content-sha256:$payloadHash`n" +
                          "x-amz-date:$amzDate`n"
$signedHeaders = "content-length;content-type;host;x-amz-content-sha256;x-amz-date"

$canonicalRequest = "PUT`n$path`n`n$canonicalHeadersBlock`n$signedHeaders`n$payloadHash"
$hashedCanonicalRequest = Get-SHA256HexOfString $canonicalRequest

$credentialScope = "$dateStamp/auto/s3/aws4_request"
$stringToSign = "AWS4-HMAC-SHA256`n$amzDate`n$credentialScope`n$hashedCanonicalRequest"

$kDate = Get-HMACSHA256Bytes ([System.Text.Encoding]::UTF8.GetBytes("AWS4$SecretAccessKey")) $dateStamp
$kRegion = Get-HMACSHA256Bytes $kDate "auto"
$kService = Get-HMACSHA256Bytes $kRegion "s3"
$kSigning = Get-HMACSHA256Bytes $kService "aws4_request"
$signatureBytes = Get-HMACSHA256Bytes $kSigning $stringToSign
$signature = -join ($signatureBytes | ForEach-Object { $_.ToString("x2") })

$authorization = "AWS4-HMAC-SHA256 Credential=$AccessKeyId/$credentialScope, SignedHeaders=$signedHeaders, Signature=$signature"

Add-Type -AssemblyName System.Net.Http

# Force TLS 1.2 : sur Windows PowerShell 5.1 (.NET Framework), le protocole
# par defaut peut ne pas inclure TLS 1.2, que Cloudflare exige - sans cette
# ligne la connexion peut echouer silencieusement sur certains postes.
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12

$uri = "https://$rHost$path"
Write-Host "Envoi vers $uri ..."
Write-Host "(aucune barre de progression - patientez, ca peut prendre longtemps selon votre connexion)"

$fileStream = [System.IO.File]::OpenRead($fileInfo.FullName)
$httpClient = $null
$response = $null
try {
    $handler = New-Object System.Net.Http.HttpClientHandler
    $httpClient = New-Object System.Net.Http.HttpClient($handler)
    $httpClient.Timeout = [System.TimeSpan]::FromHours(6)

    $streamContent = New-Object System.Net.Http.StreamContent($fileStream)
    $streamContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($contentType)
    $streamContent.Headers.ContentLength = $contentLength

    $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Put, $uri)
    $request.Content = $streamContent
    $request.Headers.TryAddWithoutValidation("x-amz-date", $amzDate) | Out-Null
    $request.Headers.TryAddWithoutValidation("x-amz-content-sha256", $payloadHash) | Out-Null
    $request.Headers.TryAddWithoutValidation("Authorization", $authorization) | Out-Null

    $response = $httpClient.SendAsync($request).GetAwaiter().GetResult()
    $responseBody = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()

    if ($response.IsSuccessStatusCode) {
        Write-Host ("OK - upload termine (statut {0})." -f [int]$response.StatusCode) -ForegroundColor Green
    } else {
        Write-Host ("ECHEC - statut {0}" -f [int]$response.StatusCode) -ForegroundColor Red
        Write-Host $responseBody
        exit 1
    }
} finally {
    $fileStream.Dispose()
    if ($response) { $response.Dispose() }
    if ($httpClient) { $httpClient.Dispose() }
}

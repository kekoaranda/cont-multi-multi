# Instalador de Partida para Windows 10 y 11.
#
# Abrilo con doble clic en instalar.bat (pide permisos de administrador).
# Instala lo que falte (Node.js y PostgreSQL) con winget, crea la base "contable", el archivo .env,
# las tablas y el usuario administrador, y opcionalmente deja el sistema iniciando solo con Windows.

$ErrorActionPreference = 'Stop'
$PG_WINGET = 'PostgreSQL.PostgreSQL.17'
$NODE_MINIMO = [version]'20.11.0'
$Raiz = Split-Path -Parent $PSScriptRoot
Set-Location $Raiz

# ---------- utilidades ----------
function Titulo($t) { Write-Host ''; Write-Host "== $t ==" -ForegroundColor Cyan }
function Ok($t)     { Write-Host "  OK  $t" -ForegroundColor Green }
function Aviso($t)  { Write-Host "  !   $t" -ForegroundColor Yellow }
function Fallar($t) {
  Write-Host "  X   $t" -ForegroundColor Red
  Read-Host 'Presioná Enter para cerrar'
  exit 1
}
function PreguntarSN($texto, $defecto = 'S') {
  $opciones = if ($defecto -eq 'S') { 'S/n' } else { 's/N' }
  $r = Read-Host "$texto [$opciones]"
  if ([string]::IsNullOrWhiteSpace($r)) { $r = $defecto }
  return ($r -match '^[sSyY]')
}
function LeerClave($texto) {
  $segura = Read-Host $texto -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($segura)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
function ActualizarPath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function VersionNode {
  try { return [version](& node -p "process.versions.node" 2>$null) } catch { return $null }
}
function ClaveAlAzar {
  $caracteres = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = New-Object byte[] 20
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return -join ($bytes | ForEach-Object { $caracteres[$_ % $caracteres.Length] })
}
function InstalarConWinget($id, $extra) {
  $argumentos = @('install', '--id', $id, '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements') + $extra
  & winget @argumentos
}

# ---------- permisos de administrador ----------
$esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $esAdmin) {
  Write-Host 'El instalador necesita permisos de administrador: se abre una ventana nueva.'
  Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  exit
}

Write-Host 'Partida: instalador para Windows' -ForegroundColor White
Write-Host "Carpeta del sistema: $Raiz"

# ---------- 1. Sistema operativo ----------
Titulo '1. Sistema operativo'
$so = (Get-CimInstance Win32_OperatingSystem).Caption
Write-Host "Sistema detectado: $so"
if (-not (PreguntarSN '¿Es correcto?')) {
  Write-Host 'Este instalador es para Windows. En Linux o macOS usá: bash instalacion/instalar.sh'
  Read-Host 'Presioná Enter para cerrar'
  exit
}
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Fallar 'Falta winget. Instalá "Instalador de aplicación" (App Installer) desde Microsoft Store y volvé a ejecutar el instalador.'
}
Ok 'Windows con winget disponible'

# ---------- 2. Node.js ----------
Titulo '2. Node.js'
$vn = VersionNode
if ($vn -and $vn -ge $NODE_MINIMO) {
  Ok "Node.js $vn ya está instalado"
} else {
  if ($vn) { Aviso "Node.js $vn es anterior a $NODE_MINIMO; se instala la versión LTS" }
  InstalarConWinget 'OpenJS.NodeJS.LTS' @()
  ActualizarPath
  $vn = VersionNode
  if (-not $vn -or $vn -lt $NODE_MINIMO) { Fallar 'No se pudo instalar Node.js. Instalalo desde https://nodejs.org y volvé a ejecutar el instalador.' }
  Ok "Node.js $vn instalado"
}

# ---------- 3. PostgreSQL ----------
Titulo '3. PostgreSQL'
$servicio = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
$pgExistente = [bool]$servicio
$claveGenerada = $false
if ($pgExistente) {
  Ok "PostgreSQL ya está instalado (servicio $($servicio.Name))"
  Write-Host 'Para continuar se necesita la clave del usuario postgres que se eligió al instalarlo.'
  $pgClave = LeerClave 'Clave del usuario postgres'
} else {
  Write-Host 'Elegí la clave del administrador de la base (usuario postgres). Usá letras, números, punto o guion.'
  do {
    $pgClave = LeerClave 'Clave nueva para postgres (vacío = generar una al azar)'
    if ([string]::IsNullOrEmpty($pgClave)) { $pgClave = ClaveAlAzar; $claveGenerada = $true }
    $valida = $pgClave -match '^[A-Za-z0-9._-]{8,}$'
    if (-not $valida) { Aviso 'La clave necesita al menos 8 caracteres entre letras, números, punto o guion.' }
  } until ($valida)

  # Algunas versiones del instalador de PostgreSQL usan VBScript, que Windows 11 puede traer desactivado
  try { Add-WindowsCapability -Online -Name 'VBSCRIPT~~~~' -ErrorAction Stop | Out-Null } catch { }

  Write-Host 'Instalando PostgreSQL (puede tardar varios minutos)...'
  $opciones = "--mode unattended --unattendedmodeui none --superpassword $pgClave --serverport 5432 --enable-components server,commandlinetools"
  InstalarConWinget $PG_WINGET @('--override', $opciones)
  $servicio = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
  if (-not $servicio) { Fallar 'PostgreSQL no quedó instalado. Instalalo desde https://www.postgresql.org/download/windows/ y volvé a ejecutar el instalador.' }
  Ok 'PostgreSQL instalado'
}

if ($servicio.Status -ne 'Running') { Start-Service $servicio.Name }
Set-Service $servicio.Name -StartupType Automatic
Ok "Servicio $($servicio.Name) en ejecución"

# Agregar las herramientas de PostgreSQL (psql, pg_dump) al PATH de esta sesión y del sistema
$psql = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue |
  Sort-Object { [int]($_.Directory.Parent.Name -replace '\D', '') } -Descending | Select-Object -First 1
if ($psql) {
  $pgBin = $psql.DirectoryName
  if (($env:Path -split ';') -notcontains $pgBin) {
    $env:Path += ";$pgBin"
    $pathMaquina = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    if (($pathMaquina -split ';') -notcontains $pgBin) {
      [Environment]::SetEnvironmentVariable('Path', "$pathMaquina;$pgBin", 'Machine')
    }
  }
  $env:PGPASSWORD = $pgClave
  $verificada = $false
  try {
    & $psql.FullName -h localhost -U postgres -d postgres -tAc 'SELECT 1' *> $null
    $verificada = ($LASTEXITCODE -eq 0)
  } catch { $verificada = $false }
  if ($verificada) { Ok 'Conexión con clave verificada' } else { Aviso 'No se pudo verificar la clave; el configurador la va a volver a pedir si hace falta.' }
  Remove-Item Env:PGPASSWORD
}

# ---------- 4. Dependencias ----------
Titulo '4. Dependencias de Node.js'
& npm install --omit=dev --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { Fallar 'npm install no terminó bien. Revisá la conexión a internet.' }
Ok 'Dependencias instaladas'

# ---------- 5. Base, .env, tablas y usuario ----------
Titulo '5. Configuración de Partida'
$env:PG_SUPERUSUARIO = 'postgres'
$env:PG_SUPERCLAVE = $pgClave
& node instalacion\configurar.js
$resultado = $LASTEXITCODE
Remove-Item Env:PG_SUPERCLAVE
if ($resultado -ne 0) { Fallar 'La configuración no terminó bien. Revisá el mensaje de arriba.' }

# ---------- 6. Inicio automático, acceso directo y red ----------
Titulo '6. Inicio automático'
$nodeExe = (Get-Command node).Source
$autoinicio = $false
if (PreguntarSN '¿Iniciar Partida automáticamente al prender la computadora?' 'S') {
  $accion = New-ScheduledTaskAction -Execute $nodeExe -Argument "--env-file=`"$Raiz\.env`" `"$Raiz\src\app.js`"" -WorkingDirectory $Raiz
  $disparador = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName 'Partida' -Action $accion -Trigger $disparador -Principal $principal -Settings $ajustes -Force | Out-Null
  Start-ScheduledTask -TaskName 'Partida'
  Ok 'Tarea programada "Partida" creada: el sistema arranca solo con Windows'
  $autoinicio = $true
}

# Acceso directo en el escritorio
$escritorio = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$acceso = $shell.CreateShortcut((Join-Path $escritorio 'Partida.lnk'))
if ($autoinicio) {
  $acceso.TargetPath = 'http://localhost:3000'
} else {
  $acceso.TargetPath = Join-Path $Raiz 'instalacion\iniciar.bat'
  $acceso.WorkingDirectory = $Raiz
}
$acceso.Save()
Ok 'Acceso directo "Partida" creado en el escritorio'

if (PreguntarSN '¿Permitir que otras computadoras de la red local usen el sistema (puerto 3000)?' 'N') {
  New-NetFirewallRule -DisplayName 'Partida (puerto 3000)' -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private -ErrorAction SilentlyContinue | Out-Null
  $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1).IPAddress
  Ok "Puerto 3000 habilitado en redes privadas. Desde otras computadoras: http://${ip}:3000"
}

# ---------- 7. Copia de seguridad diaria ----------
Titulo '7. Copia de seguridad diaria'
if (PreguntarSN '¿Programar una copia de seguridad todos los días a las 21:00 (se guardan 30 días)?' 'S') {
  New-Item -ItemType Directory -Force -Path (Join-Path $Raiz 'respaldos') | Out-Null
  $accionR = New-ScheduledTaskAction -Execute 'cmd.exe' -WorkingDirectory $Raiz `
    -Argument "/c `"`"$nodeExe`" instalacion\respaldo.js >> respaldos\respaldo.log 2>&1`""
  $disparadorR = New-ScheduledTaskTrigger -Daily -At '21:00'
  $principalR = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $ajustesR = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName 'Partida - copia de seguridad' -Action $accionR -Trigger $disparadorR `
    -Principal $principalR -Settings $ajustesR -Force | Out-Null
  Ok "Copia diaria programada. Las copias quedan en $Raiz\respaldos"
  Aviso 'Copiá esa carpeta a otro disco o a la nube: una copia en la misma computadora no protege si se rompe el disco.'
}

# ---------- Resumen ----------
Titulo 'Instalación terminada'
Write-Host '  Dirección:  http://localhost:3000'
Write-Host '  Usuario:    nelson'
Write-Host '  Clave:      hola012026   (cambiala el primer día)'
if ($claveGenerada) {
  Write-Host ''
  Write-Host "  Clave generada para el usuario postgres: $pgClave" -ForegroundColor White
  Write-Host '  Guardala en un lugar seguro. También queda en el archivo .env (DATABASE_URL_ADMIN).'
}
if ($autoinicio) {
  Start-Sleep -Seconds 3
  Start-Process 'http://localhost:3000'
} else {
  Write-Host ''
  Write-Host '  Para iniciar el sistema: doble clic en el acceso directo "Partida" del escritorio.'
}
Read-Host 'Presioná Enter para cerrar'

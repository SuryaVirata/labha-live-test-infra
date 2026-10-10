$ErrorActionPreference = 'Stop'

$serversJson = '{"Servers":{"1":{"Name":"LABHA Local","Group":"Servers","Host":"host.docker.internal","Port":5432,"MaintenanceDB":"labha","Username":"labha","PassFile":"/pgpass/pgpass","SSLMode":"prefer"}}}'
$pgpassLine  = 'host.docker.internal:5432:labha:labha:labha'

$bashScript = @'
mkdir -p ~/.labha-pgadmin
cp /mnt/c/Users/surya/AppData/Local/Temp/labha-pgadmin-servers.json ~/.labha-pgadmin/servers.json
cp /mnt/c/Users/surya/AppData/Local/Temp/labha-pgadmin-pgpass ~/.labha-pgadmin/pgpass
chmod 600 ~/.labha-pgadmin/pgpass
if docker ps -q --filter name=labha-pgadmin --filter status=running | grep -q .; then echo "    pgAdmin already running."; elif docker ps -aq --filter name=labha-pgadmin | grep -q .; then docker start labha-pgadmin >/dev/null; echo "    pgAdmin container restarted."; else docker run -d --name labha-pgadmin --add-host=host.docker.internal:host-gateway -p 5050:80 -e PGADMIN_DEFAULT_EMAIL=admin@labha-dev.com -e PGADMIN_DEFAULT_PASSWORD=labha -e PGADMIN_CONFIG_SERVER_MODE=False -e PGADMIN_CONFIG_MASTER_PASSWORD_REQUIRED=False -v ~/.labha-pgadmin/servers.json:/pgadmin4/servers.json -v ~/.labha-pgadmin/pgpass:/pgpass/pgpass dpage/pgadmin4 >/dev/null; echo "    pgAdmin container created."; fi
'@
$bashScript = $bashScript -replace "`r`n", "`n"

$tmpServers = Join-Path $env:TEMP 'labha-pgadmin-servers.json'
$tmpPgpass  = Join-Path $env:TEMP 'labha-pgadmin-pgpass'
$tmpScript  = Join-Path $env:TEMP 'labha-pgadmin-provision.sh'
Set-Content -Path $tmpServers -Value $serversJson -NoNewline -Encoding ascii
Set-Content -Path $tmpPgpass  -Value $pgpassLine  -NoNewline -Encoding ascii
Set-Content -Path $tmpScript  -Value $bashScript   -NoNewline -Encoding ascii

wsl -d Ubuntu -- bash -lc "bash /mnt/c/Users/surya/AppData/Local/Temp/labha-pgadmin-provision.sh"

$deadline = (Get-Date).AddSeconds(30)
$up = $false
while ((Get-Date) -lt $deadline) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $c.Connect('localhost', 5050)
        $c.Close()
        $up = $true
        break
    } catch {
        Start-Sleep -Milliseconds 500
    }
}
if (-not $up) {
    Write-Host "  pgAdmin did not come up in time, opening anyway..."
}
Start-Process "http://localhost:5050"

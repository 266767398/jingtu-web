$ErrorActionPreference = 'Continue'
$mysql = 'D:\phpstudy_pro\Extensions\MySQL5.7.26\bin\mysql.exe'
$cands = @('','root','123456','password','admin','1qaz2wsx','123456789','root123','mysql','jtw123','Jt123456','jingtu','123','88888888','root@123','mysql5.7','phpstudy','MySQL5.7','abc123','password123')
foreach ($p in $cands) {
  $out = & $mysql -h 127.0.0.1 -P 3306 -u root "--password=$p" --connect-timeout=3 -e 'SELECT 1' 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Output ("OK: [" + $p + "]")
  } else {
    Write-Output ("NO: [" + $p + "]")
  }
}
Write-Output 'DONE'

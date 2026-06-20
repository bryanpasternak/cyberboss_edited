param(
  [string]$action = "state",
  [string]$x = "0",
  [string]$y = "0",
  [string]$dir = "",
  [string]$msg = "",
  [int]$port = 7843
)

$BASE = "http://localhost:$port"

function call-api($method, $endpoint, $body) {
  if ($body) {
    $json = $body | ConvertTo-Json -Compress
    curl.exe -s -X $method "$BASE$endpoint" -H "Content-Type: application/json" -d $json
  } else {
    curl.exe -s "$BASE$endpoint"
  }
}

switch ($action) {
  "state" { call-api GET "/state" }
  "surround" { call-api GET "/surroundings?radius=10" }

  "move" {
    call-api POST "/move" @{x=[int]$x; y=[int]$y; fast=$true}
  }

  "face" {
    call-api POST "/face" @{direction=[int]$dir}
  }

  "walk" {
    $xs = $x -split ','
    $ys = $y -split ','
    for ($i = 0; $i -lt $xs.Length; $i++) {
      $r = call-api POST "/move" @{x=[int]$xs[$i]; y=[int]$ys[$i]; fast=$true}
      Write-Output "step $($i+1): $($r | ConvertTo-Json -Compress)"
      Start-Sleep 1.5
    }
  }

  "chat" {
    curl.exe -s -X POST "http://localhost:7842/chat/push" -H "Content-Type: application/json" -d (@{sender="A Xing"; message=$msg} | ConvertTo-Json -Compress)
  }

  "tool" {
    call-api POST "/tool" @{name=$x}
  }

  "interact" { call-api POST "/interact" }
  "use" { call-api POST "/use" }
  "sleep" { call-api POST "/sleep" }

  "chop" {
    call-api POST "/tool" @{name="Axe"}
    Start-Sleep 0.5
    call-api POST "/use"
  }

  "water" {
    call-api POST "/tool" @{name="Watering Can"}
    Start-Sleep 0.5
    call-api POST "/use"
  }

  default { call-api GET "/state" }
}

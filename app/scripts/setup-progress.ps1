param([string]$StatusFile)
# The small window of "npm run start:built" while the LLM program is built: the stage, a progress bar and the elapsed time.
# It reads the status file {pct, text, done, error, t} that scripts/start-built.js writes, and closes itself when the work is done. An error stays on the screen.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'NLPmanager - preparing the LLM program'
$form.ClientSize = New-Object System.Drawing.Size(560, 170)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.TopMost = $true

$intro = New-Object System.Windows.Forms.Label
$intro.Text = 'NLPmanager is building its LLM program. This takes a few minutes, happens once on this computer (and again after the program was updated), and the app starts when it is finished.'
$intro.SetBounds(16, 12, 528, 44)
$form.Controls.Add($intro)

$stage = New-Object System.Windows.Forms.Label
$stage.Text = 'Starting'
$stage.Font = New-Object System.Drawing.Font($form.Font, [System.Drawing.FontStyle]::Bold)
$stage.SetBounds(16, 62, 528, 22)
$form.Controls.Add($stage)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Minimum = 0
$bar.Maximum = 100
$bar.Style = 'Continuous'
$bar.SetBounds(16, 90, 528, 24)
$form.Controls.Add($bar)

$info = New-Object System.Windows.Forms.Label
$info.Text = 'Elapsed 0:00'
$info.SetBounds(16, 124, 528, 36)
$form.Controls.Add($info)

$script:shown = 0.0
$script:target = 0.0
$script:failed = $false
$script:last = Get-Date
$start = Get-Date

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 300
$timer.Add_Tick({
  $s = $null
  try { $s = Get-Content -Raw -Path $StatusFile -ErrorAction Stop | ConvertFrom-Json } catch { }
  if ($s -ne $null) {
    $script:last = Get-Date
    if ([double]$s.pct -gt $script:target) { $script:target = [double]$s.pct }
    if ($s.text) { $stage.Text = [string]$s.text }
    if ($s.error) {
      $script:failed = $true
      $stage.Text = 'The LLM program could not be built'
      $stage.ForeColor = [System.Drawing.Color]::Firebrick
      $info.Text = [string]$s.error + '  (details: prepare-llm.log in the NLPmanager folder; the app starts without the LLM program)'
      $timer.Stop()
      return
    }
    if ($s.done) { $timer.Stop(); $form.Close(); return }
  }
  if ($script:shown -lt $script:target) { $script:shown = [Math]::Min($script:target, $script:shown + 1.0) }       # the bar creeps up to the reported stage
  $bar.Value = [int][Math]::Min(100, $script:shown)
  $el = (Get-Date) - $start
  $info.Text = ('Elapsed {0}:{1:00}' -f [int][Math]::Floor($el.TotalMinutes), $el.Seconds)
  if (((Get-Date) - $script:last).TotalMinutes -gt 15) { $timer.Stop(); $form.Close() }                           # nobody reports any more: do not stay forever
})
$form.Add_Shown({ $timer.Start() })
[void]$form.ShowDialog()

# 生成大量历史日程测试数据（MOMENT 新格式）
# 日期范围：2025-01-01 ~ 2026-09-11（含今天）
# 每天 1~5 条动态，2026 年每月 10 日带一张配图（复制自封面 img.jpg）
# 输出格式与插件写入端完全一致：
#   ---
#   mood: [...]
#   quote: ...
#   updated: ...
#   ---
#
#   #此刻
#
#   ## HH:MM
#   正文
#   ![名](../附件/YYYY-M/名)
#   > 心情：xx
$ErrorActionPreference = "Stop"

$base       = "E:\Documents\obs测试\插件测试\此刻"
$attDirName = "附件"
$tag        = "#此刻"

$moods = @("元气","有灵感","满足","平静","摸鱼","低落","感恩","兴奋","高兴")
$quotes = @(
  "万物皆有裂缝，那是光进来的地方。",
  "把日子过成想要的样子。",
  "慢慢来，反而比较快。",
  "今天的风，有初秋的味道。",
  "记录本身，就是认真活过的证据。",
  "愿你眼里有光，心里有海。"
)
$texts = @(
  "傍晚的风很舒服，沿着河边走了很久。",
  "把房间整理了一遍，心情也跟着清爽了。",
  "读了几页书，有一句话在脑子里转了一整天。",
  "午饭试了新开的店，味道意外地不错。",
  "给自己泡了杯热茶，发了一会儿呆。",
  "下班路上看到很美的晚霞，忍不住拍了张照。",
  "和旧友聊了一会儿，像回到从前一样。",
  "写完了今天的计划，又把明天的事也排好了。",
  "今天走路去了很远的地方，腿有点酸但很开心。",
  "窗外的桂花开了，整条街都是甜的。",
  "完成了一件拖了很久的事，轻松多了。",
  "夜跑三公里，风从耳边过，很解压。",
  "把桌面和书架都收拾整齐了。",
  "今天天气很好，适合把所有窗户都打开。",
  "给自己做了顿好吃的，慢慢吃完。",
  "听到一首老歌，旋律一直在耳边打转。"
)

$start = [datetime]::new(2025,1,1)
$end   = [datetime]::new(2026,9,11)
$rng   = [System.Random]::new(20260911)
$count = 0

for ($d = $start; $d -le $end; $d = $d.AddDays(1)) {
  $monthDir = "{0}-{1}" -f $d.Year, $d.Month
  $dateKey  = "{0}-{1}-{2}" -f $d.Year, $d.Month, $d.Day
  $dir = Join-Path $base $monthDir
  New-Item -ItemType Directory -Force -Path $dir | Out-Null

  # 每天 1~5 条，时间去重并排序
  # 注意：必须用 @(...) 包裹，否则单元素数组会被管道降级为字符串标量，
  #       导致 $times[0] 取到的是首字符（例如 "10:42" -> "1"）。
  $n = $rng.Next(1,6)
  $times = @()
  while ($times.Count -lt $n) {
    $t = "{0:D2}:{1:D2}" -f $rng.Next(7,23), $rng.Next(0,60)
    if ($times -notcontains $t) { $times += $t }
  }
  $times = @($times | Sort-Object)

  # frontmatter：0~3 个去重心情
  $fmMoods = @()
  $k = $rng.Next(0,4)
  for ($i=0; $i -lt $k; $i++) {
    $mm = $moods[$rng.Next(0,$moods.Count)]
    if ($fmMoods -notcontains $mm) { $fmMoods += $mm }
  }
  $fm  = '---'
  $fm += "`nmood: [" + (($fmMoods | ForEach-Object { '"' + $_ + '"' }) -join ", ") + "]"
  if ($rng.Next(0,10) -lt 8) {
    $fm += "`nquote: " + $quotes[$rng.Next(0,$quotes.Count)]
  }
  $fm += "`nupdated: " + $d.ToString("yyyy-MM-dd") + "T12:00:00.000Z"
  $fm += "`n---`n"

  # 正文：仓库标签 + 若干动态
  $body = "`n" + $tag + "`n"
  for ($i=0; $i -lt $n; $i++) {
    $body += "`n## " + $times[$i] + "`n"
    $body += $texts[$rng.Next(0,$texts.Count)] + "`n"
    # 2026 年每月 10 日首条动态带配图（markdown 图片链接，相对路径 ../附件/YYYY-M/）
    if ($d.Year -eq 2026 -and $d.Day -eq 10 -and $i -eq 0) {
      $imgName = $dateKey + "-08-30-15.jpg"
      $body += "![$imgName](../$attDirName/$monthDir/$imgName)`n"
    }
    if ($rng.Next(0,10) -lt 8) {
      $body += "> 心情：" + $moods[$rng.Next(0,$moods.Count)] + "`n"
    }
  }

  $content = $fm + $body
  [System.IO.File]::WriteAllText(
    (Join-Path $dir ($dateKey + ".md")),
    $content,
    (New-Object System.Text.UTF8Encoding($false))
  )
  $count++
}

# 配图：复制封面到 2026 年各月附件目录
for ($m=1; $m -le 9; $m++) {
  $monthDir = "2026-$m"
  $attDir = Join-Path $base ($attDirName + "\" + $monthDir)
  New-Item -ItemType Directory -Force -Path $attDir | Out-Null
  Copy-Item (Join-Path $base ($attDirName + "\img.jpg")) (Join-Path $attDir ("2026-$m-10-08-30-15.jpg")) -Force
}

Write-Host "完成：生成 $count 个日程文件 + 9 张配图"

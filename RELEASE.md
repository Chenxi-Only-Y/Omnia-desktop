# 发布流程（打版本 → 出安装包 → 推 tag → 建 Release 传 asset）

> 2026-10-10 用这套流程发布了 **v0.2.1**，**全程不需要点网页**（本机没装 `gh`，
> 靠的是 Git Credential Manager 里已存的令牌 + GitHub API）。
> 目标读者：下一个要发版本的人（含未来的我）。

---

## 0. 前置确认

```bash
cd D:\AI\ds.5\lis-desktop
git status                 # 必须干净
npm run typecheck          # 必须通过
npm run smoke              # 必须 PASS（约 3 分钟）
```
> 💡 应用窗口开着也能跑自检：给自检换个 userData 就不抢单实例锁 ——
> `$env:OMNIA_DATA_DIR = Join-Path $env:TEMP 'omnia-smoke-iso'` 再 `npm run smoke`。

---

## 1. 升版本号（**只有 3 处**）

| 文件 | 位置 |
|---|---|
| `package.json` | 顶层 `"version"` |
| `package-lock.json` | 顶层 `"version"` + `packages.""` 那个 `"version"` |

⚠️ **别用全局替换**：lock 里还有**依赖**的版本号长得一样（例：`chromium-pickle-js` 就是 `0.2.0`），
改错会让 `npm ci` 报 lock 不一致。

同时在 `README.md` 的「版本变更」加一节（`### vX.Y.Z（日期）`），并在开头「当前版本」同步。

## 2. 打包

```bash
npm run dist
```
产出 `release\Omnia-Setup-<版本>.exe`（约 110 MB）。
- `dist` 会先跑 `clean:release`（**删掉 release/**，包括上一个版本的包 —— 旧包在 GitHub Releases 上，不受影响）。
- 偶发 `EPERM: rename release\win-unpacked.tmp`（杀软占着刚解压的目录）→ **直接重跑一次就好**。
- 核对包内版本（别只看文件名）：
  ```bash
  node -e "const a=require('@electron/asar');const j=JSON.parse(a.extractFile('release/win-unpacked/resources/app.asar','package.json').toString());console.log(j.version)"
  ```

## 3. 提交 + tag + 推

```bash
git add -A && git commit -m "版本 X.Y.Z → X.Y.Z+1：<一句话>"
git tag -a vX.Y.Z -m "vX.Y.Z：<一句话>"      # 用**附注 tag**，与 v0.2.0 / v0.2.1 一致
git push && git push origin vX.Y.Z
```
- ⚠️ GitHub 推送偶发 `Connection was reset` / `Failed to connect ... 443` → **过一会儿重试**（本机遇到过几次）。
- ⚠️ PowerShell 里 `git push 2>&1 | ...` 会把 git 的进度当 stderr 报出来，**看着像失败其实成功了** ✗
  → 用 `(git rev-parse HEAD) -eq (git rev-parse origin/main)` 判断，别看红字。

## 4. 建 Release + 传 asset（API，不用点网页）

```powershell
# 取令牌：不落盘、不打印，只放进环境变量
$out = "protocol=https`nhost=github.com`n`n" | git credential fill 2>&1
$env:GH_TOKEN = ($out | Where-Object { $_ -like 'password=*' } | Select-Object -First 1).Substring(9)

# 先验证令牌与权限（可选；需要 repo scope 才能建 release）
$me = Invoke-WebRequest -Uri 'https://api.github.com/user' -UseBasicParsing `
  -Headers @{ Authorization="Bearer $env:GH_TOKEN"; 'User-Agent'='omnia' } -TimeoutSec 20
'登录为 ' + ($me.Content | ConvertFrom-Json).login + '  scopes=' + $me.Headers['x-oauth-scopes']

# 建 Release —— ⚠️ body 必须发 **UTF-8 字节**：PowerShell 5.1 直接发字符串会按 ISO-8859-1
#   编码 → 中文全变乱码 ✗（实测过一次）
$notes = [System.IO.File]::ReadAllText("$PWD\dev-data\release-notes-X.Y.Z.md", [Text.Encoding]::UTF8)
$json  = (@{ tag_name='vX.Y.Z'; name='vX.Y.Z'; body=$notes; draft=$false; prerelease=$false } | ConvertTo-Json -Depth 3)
$rel = Invoke-RestMethod -Method Post -Uri 'https://api.github.com/repos/Chenxi-Only-Y/Omnia-desktop/releases' `
  -Headers @{ Authorization="Bearer $env:GH_TOKEN"; 'User-Agent'='omnia' } `
  -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json))
$rel.id

# 传 asset（110 MB ≈ 90 秒）
# ⚠️ 必须写 curl.exe：PowerShell 里裸写 curl 是 Invoke-WebRequest 的**别名** ✗
curl.exe -sS -X POST -H "Authorization: Bearer $env:GH_TOKEN" `
  -H "Content-Type: application/octet-stream" -H "User-Agent: omnia" `
  --data-binary "@release/Omnia-Setup-X.Y.Z.exe" `
  "https://uploads.github.com/repos/Chenxi-Only-Y/Omnia-desktop/releases/$($rel.id)/assets?name=Omnia-Setup-X.Y.Z.exe" `
  -o dev-data/upload-result.json -w "HTTP=%{http_code} 用时=%{time_total}s`n"
```
- 返回 `HTTP=201` + JSON 里 `"state":"uploaded"` 即成功 ✓
- 失败（网络重置）→ 直接重跑那条 `curl.exe` 即可；**别重复建 Release**（会 422 already_exists）。

## 5. 核对

```powershell
Invoke-RestMethod https://api.github.com/repos/Chenxi-Only-Y/Omnia-desktop/releases |
  ForEach-Object { "$($_.tag_name)  draft=$($_.draft)  assets=$(($_.assets | ForEach-Object { $_.name + ' ' + [math]::Round($_.size/1MB,1) + 'MB' }) -join ', ')" }
```
公开仓库**不带令牌也能查** ✓ 应当看到新 tag、`draft=False`、asset 大小对得上。

---

## 备忘

- 没装 `gh`：装了以后第 4 步能简化成 `gh release create vX.Y.Z release/Omnia-Setup-X.Y.Z.exe`。
- GitHub **Release asset** 单文件上限约 2 GB，110 MB 没问题；
  但**不能提交进 git**（git 单文件 100 MB 上限，且 `release/` 已在 `.gitignore` 里）。
- 发布说明草稿放 `dev-data/release-notes-<版本>.md`（`dev-data/` 不入库，属临时产物）。
- 历史：`v0.1.1` / `v0.2.0` 的 asset 是**手动**在网页传的；`v0.2.1` 起用本文档的 API 流程。

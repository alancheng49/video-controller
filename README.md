# Video Controller（Safari 擴充功能）

控制網頁上正在播放的影片／音訊：

| 功能 | 範圍 | 做法 |
| --- | --- | --- |
| 倍速 | 0.1× – 16× | `HTMLMediaElement.playbackRate` |
| 音量 | 0% – 400% | 0–100% 用影片元素的 `volume`；超過 100% 用 Web Audio `GainNode` |
| 立體聲轉單聲道 | 開／關 | 把 `GainNode` 的聲道數固定為 1，左右聲道會以 (L+R)/2 混合後送到兩邊喇叭 |

兩種圖形介面，可在設定頁選擇「兩者都使用／只用工具列面板／只用影片浮動面板」：

- **工具列面板**：點 Safari 工具列上的圖示。
- **影片浮動面板**：滑鼠移到影片上時出現在角落的倍速標籤，移上去會展開完整控制。

倍速、音量、單聲道**不會被記住**：重新整理或換頁（包含 YouTube 切換到下一支影片）就回到 1× / 100% / 立體聲。

## 預設快捷鍵

只在頁面有影片時生效，在輸入框打字時自動停用。可在設定頁自訂。

| 按鍵 | 動作 |
| --- | --- |
| `S` / `D` | 減速／加速（預設每次 0.25×，4× 以上每次 1×） |
| `R` | 在 1× 與上次倍速之間切換 |
| `Q` / `W` | 音量 −10% / +10% |
| `N` | 切換單聲道 |
| `⇧R` | 全部重設 |
| `V` | 顯示／隱藏浮動面板 |

## 安裝

### 方法一：暫時載入（不需要 Xcode，最快）

1. Safari ▸ 設定 ▸ 進階，勾選「顯示網頁開發者功能」。
2. Safari ▸ 設定 ▸ 開發者，按「加入暫時性延伸功能…」，選擇這個專案裡的 `extension` 資料夾。
3. 第一次在網站上使用時，點工具列圖示並允許它存取該網站。

暫時性延伸功能會在 Safari 結束或 24 小時後被移除，需要重新加入。

### 方法二：打包成 App（永久安裝，需要 Xcode）

1. 從 App Store 安裝 Xcode，並執行：

   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   ```

2. 在 Xcode ▸ Settings ▸ Accounts 登入自己的 Apple ID（免費帳號的 Personal Team 就可以）。
3. 建置：

   ```bash
   ./scripts/build-xcode.sh
   ```

   腳本會自動使用 Xcode 裡的第一個團隊簽署，Xcode 會自動建立「Apple Development」憑證。
   要指定團隊可以用 `TEAM_ID=XXXXXXXXXX ./scripts/build-xcode.sh`；不想用 Apple ID 則用 `TEAM_ID=none`（本機簽署）。
4. 開啟產生的 `Video Controller.app` 一次。
5. Safari ▸ 設定 ▸ 延伸功能，啟用「Video Controller」。

用 Apple ID 簽署的版本**不需要**勾「允許未簽署的延伸功能」，重開 Safari 後也會保持啟用。
只有用 `TEAM_ID=none` 本機簽署時，才需要在 Safari ▸ 設定 ▸ 開發者 勾選「允許未簽署的延伸功能」，而且每次重開 Safari 都要再勾一次。

### 方法三：Google Chrome（或 Edge、Brave 等 Chromium 瀏覽器）

同一個 `extension` 資料夾可以直接用，不需要另外打包：

1. 在 Chrome 網址列輸入 `chrome://extensions`。
2. 打開右上角的「開發人員模式」。
3. 按「載入未封裝項目」，選擇這個專案裡的 `extension` 資料夾。
4. 點工具列的拼圖圖示，把「Video Controller」釘選到工具列。

Chrome 允許擴充功能處理串流影片的聲音，所以在 YouTube 等網站上也能放大超過 100% 與轉單聲道。
更新程式碼後，到 `chrome://extensions` 按 Video Controller 卡片上的重新載入按鈕（↻），再重新整理影片頁面即可。

### 更新程式碼後如何套用

- **Safari 方法一（暫時載入）**：到 Safari ▸ 設定 ▸ 開發者，在暫時性延伸功能旁按「重新載入」（或移除後重新加入），再重新整理影片頁面。
- **Safari 方法二（App）**：
  1. 執行 `./scripts/build-xcode.sh` 重新建置。
  2. 完全結束 Safari（⌘Q），開啟新建好的 `Video Controller.app` 一次。
  3. 重開 Safari，確認 Safari ▸ 設定 ▸ 延伸功能 裡的 Video Controller 是啟用的（本機簽署的版本還要再勾一次「允許未簽署的延伸功能」）。
  4. 重新整理影片頁面（已開著的分頁仍在跑舊版程式）。

## 限制

- **Safari 上串流影片（YouTube 等）無法放大或轉單聲道**（Chrome 沒有這個限制）：大多數影音網站用 MSE 串流播放，而 Safari（WebKit）不會把這類影片的聲音交給 Web Audio，也不支援 `captureStream()`，所以擴充功能拿不到聲音。這種影片只能在 0–100% 之間調整音量（直接設定影片元素的音量），面板會顯示提示。一般影片檔（`.mp4` 等直接播放的）則可以放大到 400% 與轉單聲道。
- **跨網域影片**：若影片檔來自其他網域且沒有開放 CORS，Safari 不允許 Web Audio 讀取它的聲音（會變成靜音），所以這種影片只能調倍速，面板上會顯示提示。YouTube、Netflix 這類用 MSE 串流的網站不受影響。
- **需要先互動一次**：Safari 規定音訊處理必須由使用者在網頁上的操作啟動。若在工具列面板調音量時出現提示，點一下影片畫面即可自動套用。
- **高倍速靜音**：倍速超過約 4× 時，Safari 可能會自動把聲音靜音，這是瀏覽器的行為。
- **Safari 原生全螢幕**：使用 Safari 內建影片播放器全螢幕時無法顯示浮動面板；網站自己的全螢幕（例如 YouTube）可以正常顯示。快捷鍵兩種情況都能用。
- 一旦對某個影片啟用過音量放大／單聲道，它的聲音就會一直經過 Web Audio（設定回 100% 時效果等同原音）；重新整理頁面即可完全還原。

## 專案結構

```
extension/            擴充功能本體（Safari 載入這個資料夾）
  manifest.json
  content.js          注入網頁：控制影片、快捷鍵、浮動面板
  shared/common.js    共用常數與工具
  popup/              工具列面板
  options/            設定頁
  icons/
scripts/
  make-icons.py       重新產生圖示
  build-xcode.sh      轉成 Xcode 專案並建置
dev/                  開發用測試頁（不會包進擴充功能）
```

### 開發測試

不用安裝擴充功能也能在一般瀏覽器測試介面與邏輯：

```bash
python3 dev/server.py 8765
```

然後開啟 <http://localhost:8765/dev/harness.html>。`dev/shim.js` 會模擬擴充功能 API，測試影片只有左聲道有聲音，方便確認單聲道是否生效。

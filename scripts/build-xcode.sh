#!/bin/zsh
# 把 extension/ 轉成 Safari 延伸功能的 Xcode 專案並建置（需要完整版 Xcode，不能只有 Command Line Tools）。
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="Video Controller"
BUNDLE_ID="${BUNDLE_ID:-com.alancheng.VideoController}"
OUT_DIR="xcode"
# 用 Xcode 裡登入的 Apple ID（Personal Team 也可以）簽署：預設自動抓 Xcode 的第一個團隊，
# 也可以手動指定 TEAM_ID=XXXXXXXXXX；設成 TEAM_ID=none 則改用本機簽署
TEAM_ID="${TEAM_ID:-$(defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null \
  | grep -m1 'teamID' | sed -E 's/.*= "?([A-Z0-9]+)"?;.*/\1/' || true)}"
[[ "$TEAM_ID" == "none" ]] && TEAM_ID=""

if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  echo "找不到 safari-web-extension-converter。請先從 App Store 安裝 Xcode，然後執行："
  echo "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
  exit 1
fi

xcrun safari-web-extension-converter extension \
  --project-location "$OUT_DIR" \
  --app-name "$APP_NAME" \
  --bundle-identifier "$BUNDLE_ID" \
  --macos-only \
  --swift \
  --no-open \
  --no-prompt \
  --force

# converter 會用 App 名稱重新產生 App 的 bundle ID（例如 com.alancheng.Video-Controller），
# 跟擴充功能的 $BUNDLE_ID.Extension 前綴不一致，建置時會在 ValidateEmbeddedBinary 失敗，所以改回來
PBXPROJ="$OUT_DIR/$APP_NAME/$APP_NAME.xcodeproj/project.pbxproj"
sed -i '' -E "/PRODUCT_BUNDLE_IDENTIFIER = .*\.Extension;/! s/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/PRODUCT_BUNDLE_IDENTIFIER = $BUNDLE_ID;/" "$PBXPROJ"

if [[ -n "$TEAM_ID" ]]; then
  echo "使用 Apple ID 團隊 $TEAM_ID 簽署"
  SIGN_ARGS=(-allowProvisioningUpdates CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$TEAM_ID")
else
  # 「Sign to Run Locally」：不需要 Apple ID，但 Safari 需要勾「允許未簽署的延伸功能」
  echo "未找到 Apple ID 團隊，改用本機簽署"
  SIGN_ARGS=(CODE_SIGN_IDENTITY="-" CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="")
fi

xcodebuild \
  -project "$OUT_DIR/$APP_NAME/$APP_NAME.xcodeproj" \
  -scheme "$APP_NAME" \
  -configuration Release \
  -derivedDataPath "$OUT_DIR/build" \
  "${SIGN_ARGS[@]}" \
  build

APP_PATH="$OUT_DIR/build/Build/Products/Release/$APP_NAME.app"
echo
echo "完成：$APP_PATH"
echo "接下來：開啟這個 App 一次，然後到 Safari ▸ 設定 ▸ 延伸功能 勾選「Video Controller」。"
if [[ -z "$TEAM_ID" ]]; then
  echo "（本機簽署的延伸功能需要先在 Safari ▸ 設定 ▸ 開發者 勾選「允許未簽署的延伸功能」）"
fi
open -R "$APP_PATH"

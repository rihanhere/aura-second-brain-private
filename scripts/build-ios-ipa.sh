#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE_DIR="$ROOT_DIR/apps/mobile"
IOS_DIR="$MOBILE_DIR/ios"
OUTPUT_DIR="$ROOT_DIR/build/ios"
APP_NAME="${IOS_APP_NAME:-AURA}"
ARCHIVE_PATH="$OUTPUT_DIR/$APP_NAME.xcarchive"
EXPORT_PATH="$OUTPUT_DIR/export"
UNSIGNED_IPA="$OUTPUT_DIR/$APP_NAME-unsigned-sideloadly.ipa"

mkdir -p "$OUTPUT_DIR"

if [ ! -f "$MOBILE_DIR/.env" ] && [ -f "$MOBILE_DIR/.env.example" ]; then
  cp "$MOBILE_DIR/.env.example" "$MOBILE_DIR/.env"
fi

cd "$MOBILE_DIR"

if [ "${IOS_KEEP_NATIVE:-0}" != "1" ]; then
  rm -rf "$IOS_DIR" "$OUTPUT_DIR"
  mkdir -p "$OUTPUT_DIR"
fi

npx expo prebuild --platform ios --no-install

INFO_PLIST="$(find "$IOS_DIR" -maxdepth 2 -name Info.plist -print -quit)"
if [ -z "$INFO_PLIST" ]; then
  echo "Generated iOS Info.plist was not found after prebuild."
  exit 1
fi

if ! /usr/libexec/PlistBuddy -c "Print :NSLocalNetworkUsageDescription" "$INFO_PLIST" >/dev/null 2>&1; then
  echo "Info.plist is missing NSLocalNetworkUsageDescription. Refusing to build an IPA that cannot reach the local backend."
  exit 1
fi

ATS_LOCAL="$({ /usr/libexec/PlistBuddy -c "Print :NSAppTransportSecurity:NSAllowsLocalNetworking" "$INFO_PLIST" 2>/dev/null || true; } | tr '[:upper:]' '[:lower:]')"
ATS_ARBITRARY="$({ /usr/libexec/PlistBuddy -c "Print :NSAppTransportSecurity:NSAllowsArbitraryLoads" "$INFO_PLIST" 2>/dev/null || true; } | tr '[:upper:]' '[:lower:]')"
if [ "$ATS_LOCAL" != "true" ] && [ "$ATS_ARBITRARY" != "true" ]; then
  echo "Info.plist ATS config does not allow local HTTP networking. Refusing to build."
  exit 1
fi

cd "$IOS_DIR"
NODE_PATH="$(command -v node || true)"
if [ -z "$NODE_PATH" ]; then
  echo "Node.js was not found in PATH. Install Node or run this script from a shell where node works."
  exit 1
fi
echo "export NODE_BINARY=$NODE_PATH" > .xcode.env.local
pod install
ruby <<'RUBY'
project = "Pods/Pods.xcodeproj/project.pbxproj"
contents = File.read(project)

# Xcode 26 is stricter with old React Native 0.76 C++ pods. Yoga/fmt ship
# standalone -Werror flags, so warning-level C++ diagnostics become hard
# failures on the M4 build machine. Keep real compiler errors intact, but stop
# third-party warnings from killing the local unsigned IPA build.
contents.gsub!(/\s-Werror(?=[\s"])/, " -Wno-error")
contents.gsub!(/GCC_TREAT_WARNINGS_AS_ERRORS = YES;/, "GCC_TREAT_WARNINGS_AS_ERRORS = NO;")
contents.gsub!(/SWIFT_TREAT_WARNINGS_AS_ERRORS = YES;/, "SWIFT_TREAT_WARNINGS_AS_ERRORS = NO;")
contents.gsub!(/IPHONEOS_DEPLOYMENT_TARGET = [0-9.]+;/, "IPHONEOS_DEPLOYMENT_TARGET = 15.1;")

lines = contents.lines
inside = false
lines.map! do |line|
  inside = true if line.include?('[CP-User] [Hermes] Replace Hermes for the right configuration, if needed')
  if inside && line.include?('shellScript = ')
    inside = false
    "\t\t\tshellScript = \"echo Skipping Hermes replacement for local unsigned IPA build\\n\";\n"
  else
    line
  end
end
File.write(project, lines.join)

fmt_base = "Pods/fmt/include/fmt/base.h"
if File.exist?(fmt_base)
  content = File.read(fmt_base)
  patched = content.gsub(/#\s*define FMT_USE_CONSTEVAL 1/, "#  define FMT_USE_CONSTEVAL 0")
  if patched != content
    File.chmod(0644, fmt_base)
    File.write(fmt_base, patched)
  end
end

Dir.glob("Pods/Target Support Files/fmt/fmt.*.xcconfig").each do |xcconfig|
  content = File.read(xcconfig)
  unless content.include?("AURA_XCODE_26_FMT_PATCH")
    content << "\n// AURA_XCODE_26_FMT_PATCH\n"
    content << "CLANG_CXX_LANGUAGE_STANDARD = c++17\n"
    content << "OTHER_CPLUSPLUSFLAGS = $(inherited) -DFMT_USE_CONSTEVAL=0\n"
  end
  File.write(xcconfig, content)
end
RUBY

WORKSPACE="$(find "$IOS_DIR" -maxdepth 1 -name "*.xcworkspace" -print -quit)"
if [ -z "$WORKSPACE" ]; then
  echo "No .xcworkspace found in $IOS_DIR"
  exit 1
fi

SCHEME="${IOS_SCHEME:-AURA}"
if ! xcodebuild -list -workspace "$WORKSPACE" | grep -q "^[[:space:]]*$SCHEME$"; then
  SCHEME="$(xcodebuild -list -workspace "$WORKSPACE" | awk '/Schemes:/{flag=1; next} flag && NF {print $1; exit}')"
fi

echo "Using workspace: $WORKSPACE"
echo "Using scheme: $SCHEME"

if [ "${IOS_SIGNED_ARCHIVE:-0}" = "1" ]; then
  EXPORT_OPTIONS="$OUTPUT_DIR/ExportOptions.plist"
  METHOD="${IOS_EXPORT_METHOD:-development}"

  cat > "$EXPORT_OPTIONS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>$METHOD</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>compileBitcode</key>
  <false/>
</dict>
</plist>
PLIST

  TEAM_ARGS=()
  if [ -n "${IOS_TEAM_ID:-}" ]; then
    TEAM_ARGS+=(DEVELOPMENT_TEAM="$IOS_TEAM_ID")
  fi

  xcodebuild archive \
    -workspace "$WORKSPACE" \
    -scheme "$SCHEME" \
    -configuration Release \
    -destination "generic/platform=iOS" \
    -archivePath "$ARCHIVE_PATH" \
    -allowProvisioningUpdates \
    CODE_SIGN_STYLE=Automatic \
    GCC_TREAT_WARNINGS_AS_ERRORS=NO \
    SWIFT_TREAT_WARNINGS_AS_ERRORS=NO \
    ENABLE_USER_SCRIPT_SANDBOXING=NO \
    "${TEAM_ARGS[@]}"

  xcodebuild -exportArchive \
    -archivePath "$ARCHIVE_PATH" \
    -exportPath "$EXPORT_PATH" \
    -exportOptionsPlist "$EXPORT_OPTIONS" \
    -allowProvisioningUpdates

  echo "Signed IPA output:"
  find "$EXPORT_PATH" -name "*.ipa" -maxdepth 1 -print
  exit 0
fi

DERIVED_DATA="$OUTPUT_DIR/DerivedData"
rm -rf "$DERIVED_DATA" "$OUTPUT_DIR/Payload" "$UNSIGNED_IPA"

xcodebuild build \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -sdk iphoneos \
  -destination "generic/platform=iOS" \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGNING_ALLOWED=NO \
  GCC_TREAT_WARNINGS_AS_ERRORS=NO \
  SWIFT_TREAT_WARNINGS_AS_ERRORS=NO \
  ENABLE_USER_SCRIPT_SANDBOXING=NO

APP_PATH="$(find "$DERIVED_DATA/Build/Products/Release-iphoneos" -maxdepth 1 -name "*.app" -print -quit)"
if [ -z "$APP_PATH" ]; then
  echo "No .app found after build"
  exit 1
fi

mkdir -p "$OUTPUT_DIR/Payload"
cp -R "$APP_PATH" "$OUTPUT_DIR/Payload/"
cd "$OUTPUT_DIR"
zip -qry "$UNSIGNED_IPA" Payload
rm -rf "$OUTPUT_DIR/Payload"

echo "Unsigned IPA for Sideloadly:"
echo "$UNSIGNED_IPA"

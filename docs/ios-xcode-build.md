# iOS Xcode Build Handoff

This project is prepared for building on a second Mac with Xcode. Android/APK work can wait.

## On This Mac

Copy the whole project folder to the Mac that has Xcode:

```bash
/Users/rihan/Documents/Codex/2026-05-13/build-a-mobile-application-called-second
```

## On The Xcode Mac

Install dependencies:

```bash
npm install
```

Configure the mobile API URL:

```bash
cp apps/mobile/.env.example apps/mobile/.env
```

Set `EXPO_PUBLIC_API_URL` to the backend URL reachable by the phone. For physical iPhone testing, do not use `localhost`; use the Mac LAN IP or deployed Railway URL.

Example for local API on the same Wi-Fi network:

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.25:4000
```

Start the API locally if you are not using Railway:

```bash
cp apps/api/.env.example apps/api/.env
npm run api
```

Generate the native iOS project:

```bash
npm run prebuild:ios --workspace apps/mobile
npm run ios:pods --workspace apps/mobile
```

Open the generated workspace:

```bash
open apps/mobile/ios/SecondBrainAI.xcworkspace
```

If Xcode generates a slightly different workspace name, open the `.xcworkspace` file inside `apps/mobile/ios`.

## Xcode Settings

In Xcode:

- Select the app target.
- Choose your Apple team under Signing & Capabilities.
- Confirm bundle id: `ai.secondbrain.mobile`.
- Use a physical iPhone target if you want to archive for sideloading.
- Product > Archive.
- Export the archive as an iOS App `.ipa`.
- Sideload the IPA with Sideloadly.

## Important Notes

- Voice capture requests microphone access and records local audio. Real speech-to-text should be wired with Apple Speech, Whisper, or a backend STT endpoint in the native phase.
- Push notification permissions are configured. FCM credentials still need to be added before production push delivery.
- If the phone cannot reach the API, the app shell still opens, but AI capture calls will fail until `EXPO_PUBLIC_API_URL` points to a reachable API.
- Supabase/OpenRouter can be left empty for early UI testing; the API has local mock-safe fallbacks.
- Android is intentionally not part of this handoff. APK testing can be added later from the same Expo app.

## One-Line IPA Build

For Sideloadly, run this from the repo root on the Xcode Mac:

```bash
npm run ipa:ios
```

The script generates the native iOS project if needed, installs pods, builds a Release `.app` with Xcode, and packages:

```bash
build/ios/SecondBrainAI-unsigned-sideloadly.ipa
```

If you want Xcode to create a signed archive instead, use:

```bash
IOS_SIGNED_ARCHIVE=1 IOS_TEAM_ID=YOUR_TEAM_ID npm run ipa:ios
```

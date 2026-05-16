# AURA IPA Build

Run from the project root:

```bash
cd ~/Downloads/AURA-IPA-BUILD
npm install
npm run ipa:ios
```

The build script intentionally regenerates `apps/mobile/ios` from scratch, installs pods, sets `NODE_BINARY`, disables Xcode script sandboxing for the unsigned local build, and outputs:

```text
build/ios/AURA-unsigned-sideloadly.ipa
```

If the folder is somewhere else, replace `~/Downloads/AURA-IPA-BUILD` with the actual folder path.

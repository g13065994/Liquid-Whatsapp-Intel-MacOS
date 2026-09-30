# Liquid WhatsApp

Liquid WhatsApp is an unofficial Electron desktop client for **macOS Catalina and Intel Macs**. It provides a custom WhatsApp-style desktop experience with local message storage, media tools, voice notes, groups, status, polls, diagnostics, secure AI credentials, and WhatsApp Web calling.

Made by **Gerald (Mateo devs)**.

> **Unofficial software:** Liquid WhatsApp is independent software and is not affiliated with, endorsed by, sponsored by, or officially supported by WhatsApp or Meta Platforms, Inc. WhatsApp, the WhatsApp name, logo and related marks are trademarks of Meta Platforms, Inc.

## Download

### GitHub Releases

All downloadable versions are published through **GitHub Releases**:

**https://github.com/Romeoisl/Whatsapp-MacOS-Intel/releases**

Each release has its own version tag, such as `v1.0.0`, so older versions remain available instead of being replaced by a temporary GitHub Actions artifact.

Release assets are built for **Intel x64 Macs**:

- **DMG** — `Liquid-WhatsApp-<version>-Catalina-Intel.dmg`
- **ZIP** — `Liquid-WhatsApp-<version>-x64.zip`

### Current target

- macOS 10.15 Catalina or newer
- Intel x64 Macs
- DMG and ZIP packages
- Minimum macOS version: 10.15
- Apple Silicon is not currently packaged
- Built-in GitHub Release updater for packaged Intel builds

## Features

- Native macOS notifications with preview/sound controls
- Persistent append-only local message database with legacy migration
- Offline text outbox with automatic retry after reconnection
- Automatic local backup plus manual JSON export
- Chat search and in-chat message search
- Contact/profile and group-management views
- Media gallery and drag-and-drop attachments
- Pin, mute, archive and starred messages
- System/light/dark/Liquid Glass-inspired themes
- macOS keyboard shortcuts
- Dock unread badge and notification click-to-open-chat
- Reconnection and session recovery
- Settings & Preferences navigation
- Storage management
- Status posting
- Polls with multiple-answer support
- Group controls and `@all` mentions
- Call history and call links
- Voice notes through the bundled FFmpeg pipeline
- Catalina/Intel-focused performance optimizations
- WhatsApp Web calling bridge for supported one-to-one voice/video calls
- Optional screen/window sharing source selection through the WhatsApp Web calling window

## v1.0.0 Security and Calling Architecture

Version 1.0.0 uses a **WhatsApp Web calling bridge** for the desktop call experience.

When a user starts a one-to-one voice or video call, Liquid WhatsApp opens a dedicated Electron window containing **web.whatsapp.com** and lets WhatsApp Web handle the supported call/media flow. The window uses a persistent application session so the WhatsApp Web login can remain available between launches.

Liquid WhatsApp does **not** claim to implement or operate Meta's proprietary WhatsApp calling service itself. Availability of calling, video, and screen sharing depends on WhatsApp Web, the user's account, WhatsApp's rollout, browser/Electron compatibility, and applicable service restrictions.

The project also contains legacy/internal VoIP/WASM calling dependencies from earlier development. These should not be interpreted as an assertion that Liquid WhatsApp independently implements or replaces WhatsApp's official calling infrastructure.

**Testing note:** real-world voice/video calling still needs end-to-end testing on the target Catalina Intel Mac and with a second WhatsApp account. Group calling is not presented as a native Liquid WhatsApp implementation.

## Voice notes

Electron recordings are normalized with the bundled `ffmpeg-static` binary before upload. Browser WebM/Opus recordings are converted to OGG/Opus for WhatsApp push-to-talk audio.

## Electron security posture

The main application renderer runs with:

- `contextIsolation: true`
- `nodeIntegration: false`
- Electron renderer sandboxing enabled
- a restrictive Content Security Policy in `renderer/index.html`
- an allowlisted preload IPC surface
- main-process IPC sender/frame validation
- no direct renderer access to raw Baileys/WhatsApp message objects

Raw protocol message objects needed for media download, reactions, forwarding, and quoted sends are kept in a bounded main-process cache and are never exposed through the renderer API. Local session files are also restricted to owner-only permissions where the filesystem supports POSIX modes.

The separate WhatsApp Web calling window is independently sandboxed, has Node integration disabled, and is restricted to `https://web.whatsapp.com` for in-app navigation. Media and screen-capture permissions are explicitly scoped to that origin.

## Runtime integrity and modified-build detection

Packaged macOS builds include a runtime integrity verifier. On startup, Liquid WhatsApp checks the application's macOS code signature and Gatekeeper status. The verifier distinguishes:

- **modified** — a previously signed app no longer passes strict signature verification.
- **signed-unverified** — the app has a valid signature, but the build is not fully verified as a Developer ID + Hardened Runtime + Gatekeeper-accepted distribution.
- **official** — the app has a valid Developer ID Application signature, Hardened Runtime, and Gatekeeper acceptance. This is a practical release-integrity classification; it does not independently prove that a notarization ticket is stapled.
- **older** — a fully verified signed build is running while a newer GitHub Release is available.
- **unsigned/development** — the build was not distributed with a verifiable signing identity.

If a packaged signed application fails strict verification, Liquid WhatsApp closes instead of continuing to run the modified copy. A merely valid but untrusted/ad-hoc signature is reported as `signed-unverified` rather than being mislabeled as an official release.

The project enables the Hardened Runtime build setting. A GitHub Actions build is not automatically a notarized Developer ID release merely because this setting is enabled; the release must actually be signed/notarized with the appropriate Apple credentials. Apple's code-signing and notarization system remains the authoritative protection for distributed macOS applications, while the runtime check is only an additional application-level signal.

## Security, privacy and account risk

Liquid WhatsApp is an independent, unofficial client. It uses an unofficial WhatsApp protocol implementation for its core messaging connection and also provides a separate WhatsApp Web window for supported calling flows.

WhatsApp can change its protocols, web application, or service requirements at any time. Use of unofficial clients may result in account restrictions or loss of functionality. **Use an account you are prepared to lose if you choose to experiment with unofficial software.**

Session credentials and local message data are stored locally by the application. AI API keys are stored through Electron's OS-backed `safeStorage` in the main process rather than exposed directly to the renderer. Treat the Mac user account and application data directory as sensitive. Do not share your Liquid WhatsApp data directory, authentication state, private messages, or exported application data publicly.

Liquid WhatsApp does not represent itself as an official WhatsApp application and does not guarantee continued compatibility with WhatsApp services.

## Official WhatsApp compatibility and authorization

This project is developed independently and is **not presented as authorized by WhatsApp or Meta**.

If WhatsApp or Meta provides technical, legal, security, branding, or distribution guidance for this project, the project will follow applicable requirements and update this documentation accordingly.

For official WhatsApp information, refer to Meta/WhatsApp's own documentation and contact channels rather than treating this repository as an official source.

## Install from source

```bash
npm install
npm run check
npm start
```

## Build for Intel Catalina

```bash
npm run build:catalina
```

This creates a local Intel DMG and ZIP without publishing them.

## Publish a GitHub Release

Update the version in `package.json`, commit it, then create and push a matching semantic version tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The GitHub Actions workflow runs for tags matching `v*.*.*`. It:

1. Checks that the Git tag matches `package.json`.
2. Installs dependencies.
3. Runs the project checks.
4. Builds the macOS Intel x64 DMG and ZIP.
5. Publishes both files to the matching GitHub Release.

For example:

```text
GitHub Releases
└── v1.0.0
    ├── Liquid-WhatsApp-1.0.0-Catalina-Intel.dmg
    └── Liquid-WhatsApp-1.0.0-x64.zip
```

GitHub Releases are the **only versioned download system** for the project. There is no separate release website.

### Automatic updates

Packaged Intel macOS builds quietly check GitHub Releases for new versions after startup and periodically while the app is running. When a new version is found, the app asks before downloading it. After the download finishes, it asks before restarting to install the update.

The updater uses electron-builder/electron-updater's differential-download support where available, using update metadata and block maps so unchanged portions do not have to be downloaded again. This can reduce data usage, but it is **not guaranteed to download only the exact source-code changes**; the amount downloaded depends on which packaged files changed between releases. GitHub Releases also need the generated macOS update metadata and artifacts from the release workflow.

You can also publish locally when `GH_TOKEN` is configured:

```bash
npm run release
```

electron-builder publishes to the GitHub repository configured in `package.json`.

## Release workflow

The release workflow is located at:

```text
.github/workflows/build-dmg.yml
```

Manual workflow runs build the Intel Catalina DMG/ZIP as GitHub Actions artifacts. Version tags publish the same builds to GitHub Releases.

## Contributing

Issues and pull requests are welcome. Please avoid posting personal WhatsApp session data, authentication credentials, private messages or exported application data in issues or pull requests.

## Credits

Made by **Gerald (Mateo devs)**.

Liquid WhatsApp is unofficial software and is not affiliated with Meta Platforms, Inc.

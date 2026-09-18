# @utils-code/front-end

This package contains the archive segments for Codex Windows 26.915.31029. It can assemble the original verified MSIX or extract a portable copy that starts without Microsoft Store/AppX registration. No install lifecycle script runs automatically.

## Portable installation on Windows

Fully exit any installed Microsoft Store/MSIX copy of Codex, then run from Command Prompt. A short path is recommended:

```cmd
npx utils-code-front-end install-portable C:\CodexOffline
C:\CodexOffline\Codex.cmd
```

The installer does not call `Add-AppxPackage`, does not require Developer Mode, and does not modify the official `ChatGPT.exe` or `app.asar`. Its launcher disables the package-only updater and points the desktop app at the bundled Codex CLI. The legacy `install-offline` command remains as an alias for `install-portable`.

Use `--force` only to replace the selected portable directory. “Offline” here means Store-independent installation and startup; Codex model requests still require network access.

Before publishing, the same checkout can be tested directly on Windows:

```cmd
node front-end\bin\assemble.mjs install-portable C:\CodexOffline --force --launch
```

If no Windows machine is available, run the repository's **Windows portable smoke test** workflow from GitHub Actions. It downloads the pinned official MSIX, verifies its exact size and SHA-256, extracts it with this installer, and requires Electron to create a renderer page and remain running. Startup diagnostics are uploaded as a workflow artifact even when the check fails.

## Assemble the original MSIX

```cmd
npx utils-code-front-end assemble .\OpenAI.Codex.msix
```

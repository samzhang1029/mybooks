# @utils-code/front-end

This package contains the archive segments for Codex Windows 26.1013.40934. It assembles the verified official MSIX and extracts a portable copy without Microsoft Store/AppX registration. No install lifecycle script runs automatically.

## Portable installation on Windows (CMD)

Exit existing Codex/ChatGPT processes. From an installer directory, run:

```cmd
npm install @utils-code/front-end@1.0.4 --ignore-scripts
node_modules\.bin\utils-code-front-end.cmd install-portable "%USERPROFILE%\CodexOffline"
call "%USERPROFILE%\CodexOffline\Codex.cmd"
```

Always launch through `Codex.cmd` (or the `launch` command). Directly opening `app\ChatGPT.exe` omits the required portable environment and can fail with a package-identity error. Point shortcuts at `Codex.cmd`.

The installer does not call `Add-AppxPackage`, require Developer Mode, or modify the official executable or ASAR. It disables the package-only updater and selects the bundled Codex CLI. `install-offline` remains an alias for `install-portable`.

To replace an existing portable directory, close Codex and add `--force`. Use a short, dedicated application directory. “Offline” means Store-independent installation and startup; sign-in and model requests still require network access.

## Assemble the original MSIX

```cmd
node_modules\.bin\utils-code-front-end.cmd assemble .\OpenAI.Codex.msix
```

## Pre-publication verification

The repository's **Windows portable smoke test** downloads the pinned MSIX, rebuilds the npm parts, packs and installs all packages locally, and runs the installed `install-portable` command at `C:\CodexOffline`. It verifies a renderer page is created and remains running. Diagnostics are uploaded even on failure. No account or model request is required.

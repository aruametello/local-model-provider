# (custom) Local Model Provider — Portable Installer

A self-contained installer for this fork of [krevas/local-model-provider](https://github.com/krevas/local-model-provider).
No Node.js, no internet access, and no VS Code Marketplace account required on the target machine.

## Contents

| File | Purpose |
|------|---------|
| `install.bat` | One-click installer (Windows) — finds your VS Code install and installs the bundled extension |
| `local-model-provider-custom-1.2.1.vsix` | The prebuilt extension package |

## How to use on another computer

1. Copy this entire `install_build` folder to the target machine (USB stick, network share, zip, …).
2. Double-click **`install.bat`** (or run it from a terminal).
3. In VS Code: `Ctrl+Shift+P` → **Developer: Reload Window**.
4. Configure your server via the command palette → *"(custom) Local Model Provider"* commands
   (Set API Key, Switch Server Preset, …).

## What the installer does

- Locates the VS Code CLI (`code`) on `PATH`, or in the standard install locations:
  `%LOCALAPPDATA%\Programs\Microsoft VS Code` (user install),
  `%ProgramFiles%\Microsoft VS Code` and `%ProgramFiles(x86)%\Microsoft VS Code` (machine installs).
- Runs `code --install-extension local-model-provider-custom-1.2.1.vsix`.
- Prints next steps on success, and a helpful fallback command if VS Code lives in a non-standard location.

## Rebuilding the .vsix (maintainers)

From the repository root:

```bat
npm run esbuild
npm run package
copy local-model-provider-custom-<version>.vsix install_build\
rem then update the VSIX name inside install.bat if the version changed
```

> Since 1.2.0 the fork uses its own extension id — `krevas.local-model-provider-custom`
> — so it installs **side by side** with the official `krevas.local-model-provider`
> from the marketplace. If you previously installed a 1.1.x build of this fork
> (which still used the official id), uninstall it first:
> `code --uninstall-extension krevas.local-model-provider`.

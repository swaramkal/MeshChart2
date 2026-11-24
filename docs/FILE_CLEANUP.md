# MeshChat File Cleanup and Preservation Guide

This guide is intentionally conservative. It does not authorize automatic deletion. Back up files before any cleanup.

## 1. Do not delete these project files

Preserve these unless a reviewed migration replaces them:

- `src/` — application and service source.
- `android/` — native Android project and BLE plugin.
- `tests/` — automated tests.
- `public/` — PWA assets and service worker.
- `.github/workflows/` — build/deployment automation.
- `package.json` and `package-lock.json` — dependency definitions and lockfile.
- `capacitor.config.json` — Capacitor application configuration.
- `docs/PROTOCOL.md` — protocol design notes.
- Existing backups, `.bak` files, and untracked files until inspected.

Do not remove `MeshBlePlugin.java`: it exists in the uploaded ZIP and contains the native BLE GATT implementation.

## 2. Documentation that should be updated, not deleted

| File | Issue | Action |
|---|---|---|
| `README.md` | Claims native Android BLE plugin is not implemented, although `MeshBlePlugin.java` exists in the ZIP | Update status and build instructions |
| `README.md` | Refers to `android-build.yml`, while uploaded ZIP contains `android-apk.yml` and `deploy.yml` | Correct workflow name |
| `BUILD-STATUS.md` | Its 2026-11-21 report says Vite build was not run; current working project passed Vite build and 11 tests on 2026-11-22 | Replace with a dated report tied to actual results |
| `docs/ROADMAP.md` | Does not include latest packet-framing work from the working project | Reconcile with `DEVELOPMENT_STAGES.md` |
| `docs/PROTOCOL.md` | Explicitly describes a design starting point, not a deployed protocol | Keep as design notes; update only after protocol decisions are implemented and tested |

## 3. Differences between uploaded ZIP and current working tree

The uploaded ZIP does not include the latest local working-tree additions described in the current development conversation, including:
- `src/services/packet-transport.js`
- `tests/packet-transport.test.js`
- the latest Base64 and notification-queue changes to `MeshBlePlugin.java`
- the corresponding latest `src/services/bluetooth.js` changes

Those files were reported in the Termux working project as untracked or modified. Do not assume the uploaded ZIP is a complete backup of the current working tree. Before replacing the GitHub repository contents, preserve the current Termux project and reconcile these differences.

## 4. Specific caution for the current Termux workspace

The working tree previously showed these untracked items:
- `.github/workflows/android-apk.yml.backup`
- `index.html.before-menu-removal`
- `src/services/packet-transport.js`
- `tests/packet-transport.test.js`

Untracked does not mean unnecessary. Inspect each file and keep a separate backup before deciding whether it belongs in Git. Do not delete backups or source files merely to make `git status` clean.

## 5. Cleanup rules

1. Never delete a file because its name looks old or unused.
2. Search for imports, references, workflow usage, and build configuration before proposing deletion.
3. Check whether a file is a backup, generated file, source file, or user-created artifact.
4. Back up before deleting or moving anything.
5. Remove only files confirmed to be obsolete and not required by builds, workflows, or recovery.
6. Keep cleanup separate from feature implementation so regressions are easy to identify.

## 6. Current deletion recommendation

**No source-code deletion is recommended from the uploaded ZIP based on this audit.**

The clearest cleanup task is documentation correction, not source removal. If a later code audit identifies a genuinely unused file, list its exact path, evidence, dependency search, and backup location before asking for approval.

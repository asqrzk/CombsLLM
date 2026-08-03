// ============================================================
// Vercel AI SDK — single import surface.
// Loaded as a pre-bundled ESM module from jsDelivr (same pattern as
// @litert-lm/core and @mediapipe/tasks-genai). Pin the exact version
// here; all app code imports from this file so upgrades are one-line
// changes.
//
// NOTE: do NOT switch this to esm.sh — its per-package chunking splits
// zod into multiple instances, which breaks the SDK's prompt schema
// validation (AI_InvalidPromptError on any prompt). jsDelivr's +esm
// bundle shares one zod instance and works.
// ============================================================
export * from 'https://cdn.jsdelivr.net/npm/ai@7.0.37/+esm';

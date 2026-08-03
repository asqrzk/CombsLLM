// ============================================================
// Configuration presets — known-good combinations loaded from
// presets.json. A preset only populates the console controls;
// the user initializes (and may deviate) afterwards.
// ============================================================

export async function loadPresets() {
  try {
    const res = await fetch('presets.json');
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

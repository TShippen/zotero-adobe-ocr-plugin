import { config } from "../../package.json";

type PluginPrefsMap = _ZoteroTypes.Prefs["PluginPrefsMap"];

const PREFS_PREFIX = config.prefsPrefix;

/**
 * Get a plugin preference value.
 *
 * @param key - The preference key to retrieve.
 * @returns The stored value for the given key.
 */
export function getPref<K extends keyof PluginPrefsMap>(key: K): PluginPrefsMap[K] {
  return Zotero.Prefs.get(`${PREFS_PREFIX}.${key}`, true) as PluginPrefsMap[K];
}

/**
 * Set a plugin preference value.
 *
 * @param key - The preference key to set.
 * @param value - The value to store.
 */
export function setPref<K extends keyof PluginPrefsMap>(
  key: K,
  value: PluginPrefsMap[K],
): void {
  Zotero.Prefs.set(`${PREFS_PREFIX}.${key}`, value, true);
}

/**
 * Clear a plugin preference value.
 *
 * @param key - The preference key to clear.
 */
export function clearPref(key: string): void {
  Zotero.Prefs.clear(`${PREFS_PREFIX}.${key}`, true);
}

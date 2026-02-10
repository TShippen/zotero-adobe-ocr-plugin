/**
 * Context menu module for the Adobe OCR plugin.
 *
 * Registers and removes the "OCR with Adobe PDF Services" menu item in
 * Zotero's item context menu.
 */

import { config } from "../../package.json";

import { getString } from "../utils/locale";
import { ocrSelectedItems } from "./ocrManager";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MENU_ITEM_ID = "zotero-adobe-ocr-menuitem";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register the OCR menu item in Zotero's item context menu.
 *
 * Adds "OCR with Adobe PDF Services" to the right-click menu on library items.
 * When clicked, it triggers the OCR workflow for selected items.
 *
 * @param window - The Zotero main window
 */
export function registerMenuItem(window: Window): void {
  const addonInstance =
    Zotero[config.addonInstance as keyof typeof Zotero] as
    | { data: { ztoolkit: ZToolkit } }
    | undefined;

  if (!addonInstance) {
    Zotero.logError(new Error("[Adobe OCR] Could not find addon instance for menu registration"));
    return;
  }

  const ztk = addonInstance.data.ztoolkit;

  ztk.Menu.register("item", {
    tag: "menuitem",
    id: MENU_ITEM_ID,
    label: getString("menuitem-ocr", "label"),
    commandListener: () => {
      ocrSelectedItems(window);
    },
    icon: `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
  });
}

/**
 * Remove the OCR menu item from Zotero's item context menu.
 *
 * @param window - The Zotero main window
 */
export function removeMenuItem(window: Window): void {
  window.document.getElementById(MENU_ITEM_ID)?.remove();
}

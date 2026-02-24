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
const ITEM_MENU_ID = "zotero-itemmenu";

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
  const doc = window.document;
  const menuPopup = doc.getElementById(ITEM_MENU_ID);

  if (!menuPopup) {
    Zotero.logError(
      new Error(
        "[Adobe OCR] Could not find item context menu for registration",
      ),
    );
    return;
  }

  // Avoid duplicate registration
  if (doc.getElementById(MENU_ITEM_ID)) {
    return;
  }

  const menuItem = doc.createXULElement("menuitem");
  menuItem.id = MENU_ITEM_ID;
  menuItem.setAttribute("label", getString("menuitem-ocr", "label"));
  menuItem.setAttribute(
    "image",
    `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
  );
  menuItem.classList.add("menuitem-iconic");
  menuItem.addEventListener("command", () => {
    ocrSelectedItems(window);
  });

  menuPopup.appendChild(menuItem);
}

/**
 * Remove the OCR menu item from Zotero's item context menu.
 *
 * @param window - The Zotero main window
 */
export function removeMenuItem(window: Window): void {
  window.document.getElementById(MENU_ITEM_ID)?.remove();
}

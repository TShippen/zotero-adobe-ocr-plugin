import { config } from "../package.json";

import { clearCachedToken, getAccessToken } from "./modules/adobeApi";
import { registerMenuItem, removeMenuItem } from "./modules/menu";
import { getString, initLocale } from "./utils/locale";
import { logInfo } from "./utils/log";
import { getPref, setPref } from "./utils/prefs";
import { createZToolkit } from "./utils/ztoolkit";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("pref-title"),
    image: rootURI + "content/icons/favicon.png",
  });

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
  logInfo("Plugin initialized");
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  registerMenuItem(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  removeMenuItem(win);
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  logInfo("Plugin shutting down");
  clearCachedToken();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify(
  _event: string,
  _type: string,
  _ids: Array<string | number>,
  _extraData: { [key: string]: unknown },
) {
  // Notification handling reserved for future use
}

async function onPrefsEvent(type: string, data: { [key: string]: unknown }) {
  if (type !== "load") {
    return;
  }

  const win = data.window as Window;
  const doc = win.document;
  const ref = config.addonRef;

  const clientIdInput = doc.getElementById(
    `zotero-prefpane-${ref}-client-id`,
  ) as HTMLInputElement | null;
  const clientSecretInput = doc.getElementById(
    `zotero-prefpane-${ref}-client-secret`,
  ) as HTMLInputElement | null;
  const validateBtn = doc.getElementById(
    `zotero-prefpane-${ref}-validate-btn`,
  ) as HTMLButtonElement | null;
  const statusEl = doc.getElementById(
    `zotero-prefpane-${ref}-validate-status`,
  ) as HTMLSpanElement | null;

  if (!clientIdInput || !clientSecretInput || !validateBtn || !statusEl) {
    return;
  }

  // Populate from saved prefs
  const savedId = getPref("clientId") as string;
  const savedSecret = getPref("clientSecret") as string;
  clientIdInput.value = savedId ?? "";
  clientSecretInput.value = savedSecret ?? "";

  // Show saved status if credentials already exist
  if (savedId && savedSecret) {
    statusEl.textContent = getString("pref-validate-saved");
    statusEl.style.color = "";
  }

  validateBtn.addEventListener("click", async () => {
    const clientId = clientIdInput.value.trim();
    const clientSecret = clientSecretInput.value.trim();

    if (!clientId || !clientSecret) {
      statusEl.textContent = getString("pref-validate-empty");
      statusEl.style.color = "#d32f2f";
      return;
    }

    statusEl.textContent = getString("pref-validate-in-progress");
    statusEl.style.color = "";
    validateBtn.setAttribute("disabled", "true");

    try {
      clearCachedToken();
      await getAccessToken(clientId, clientSecret);

      setPref("clientId", clientId);
      setPref("clientSecret", clientSecret);

      statusEl.textContent = getString("pref-validate-success");
      statusEl.style.color = "#2e7d32";
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      statusEl.textContent = getString("pref-validate-failed", {
        args: { message },
      });
      statusEl.style.color = "#d32f2f";
    } finally {
      validateBtn.removeAttribute("disabled");
    }
  });
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
};

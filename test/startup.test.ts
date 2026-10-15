import { assert } from "chai";
import { config } from "../package.json";

describe("startup", function () {
  it("should have plugin instance defined", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });

  it("should register a preference pane under the plugin ID", function () {
    const panes = Zotero.PreferencePanes.pluginPanes;
    assert.isTrue(
      panes.some((pane) => pane.pluginID === config.addonID),
      `no preference pane registered for ${config.addonID}`,
    );
  });

  it("should add the OCR item to the item context menu", function () {
    const win = Zotero.getMainWindow();
    const menuItem = win.document.getElementById("zotero-adobe-ocr-menuitem");
    assert.isNotNull(menuItem, "context menu item not found in main window");
    assert.equal(menuItem?.tagName.toLowerCase(), "menuitem");
  });
});

/**
 * OCR manager module -- the orchestrator that bridges Zotero and the Adobe API.
 *
 * Reads the selected items, filters for PDFs, gathers credentials and user
 * preferences, presents the pre-flight dialog, and runs the OCR pipeline
 * for each selected PDF.
 */

import { getAccessToken, ocrPdf } from "./adobeApi";
import { showOcrDialog } from "./ocrDialog";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";

// ---------------------------------------------------------------------------
// Progress window helpers
// ---------------------------------------------------------------------------

/**
 * Show an error in a Zotero progress window and auto-close after 4 seconds.
 *
 * @param message - The error message to display
 */
function showErrorProgress(message: string): void {
  const progressWin = new Zotero.ProgressWindow({ closeOnClick: true });
  progressWin.changeHeadline(getString("progress-title"));
  const progressItem = new progressWin.ItemProgress(
    "chrome://zotero/skin/cross.png",
    message,
  );
  progressItem.setIcon("chrome://zotero/skin/cross.png");
  progressWin.show();
  progressWin.startCloseTimer(4000);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * OCR the selected items in Zotero.
 *
 * Gathers selected PDF attachments, prompts the user with a pre-flight dialog
 * for OCR options, authenticates with Adobe, and processes each PDF through the
 * Adobe PDF Services OCR pipeline.
 *
 * @param window - The Zotero main window
 */
export async function ocrSelectedItems(window: Window): Promise<void> {
  try {
    // Step 1: Get selected items
    const zoteroPane = Zotero.getActiveZoteroPane();
    const selectedItems: Zotero.Item[] = zoteroPane.getSelectedItems();

    // Step 2: Sort into PDF and non-PDF items
    const pdfItems: Zotero.Item[] = [];
    const nonPdfItems: Zotero.Item[] = [];

    for (const item of selectedItems) {
      if (
        item.isAttachment() &&
        item.attachmentContentType === "application/pdf"
      ) {
        pdfItems.push(item);
      } else {
        nonPdfItems.push(item);
      }
    }

    // Step 3: If zero PDFs, show error and return
    if (pdfItems.length === 0) {
      showErrorProgress(getString("error-no-pdfs"));
      return;
    }

    // Step 4: Read credentials from prefs
    const clientId = getPref("clientId") as string;
    const clientSecret = getPref("clientSecret") as string;

    // Step 5: If credentials are empty, show error and return
    if (!clientId || !clientSecret) {
      showErrorProgress(getString("error-no-credentials"));
      return;
    }

    // Step 6: Read defaults
    const ocrLang = getPref("ocrLang") as string;
    const ocrType = getPref("ocrType") as string;

    // Step 7: Show pre-flight dialog
    const result = await showOcrDialog(window, pdfItems, nonPdfItems, {
      ocrLang,
      ocrType,
    });

    // Step 8: If cancelled, return
    if (result === null) {
      return;
    }

    // Step 9: Get access token
    const accessToken = await getAccessToken(clientId, clientSecret);

    // Step 10: Process each PDF
    for (const item of pdfItems) {
      const itemTitle = item.getDisplayTitle();

      try {
        // Step 10a: Get file path
        const path = await item.getFilePathAsync();

        // Step 10b: If no path, show error and skip
        if (!path) {
          showErrorProgress(getString("error-no-file"));
          continue;
        }

        // Step 10c: Read file
        const data = await IOUtils.read(path);

        // Step 10d: Show progress window
        const progressWin = new Zotero.ProgressWindow({ closeOnClick: true });
        progressWin.changeHeadline(getString("progress-title"));
        const progressItem = new progressWin.ItemProgress(
          "chrome://zotero/skin/default/zotero/treeitem-attachment-pdf.png",
          itemTitle,
        );
        progressWin.show();

        // Step 10e: Call OCR pipeline
        const onProgress = (status: string): void => {
          switch (status) {
            case "uploading":
              progressItem.setText(getString("progress-uploading"));
              break;
            case "processing":
              progressItem.setText(getString("progress-processing"));
              break;
            case "downloading":
              progressItem.setText(getString("progress-downloading"));
              break;
          }
        };

        const ocrResult = await ocrPdf(
          data,
          clientId,
          accessToken,
          { ocrLang: result.ocrLang, ocrType: result.ocrType },
          onProgress,
        );

        // Step 10f: Save result
        progressItem.setText(getString("progress-saving"));

        if (result.overwrite) {
          await IOUtils.write(path, ocrResult);
        } else {
          const dir = PathUtils.parent(path);
          const basename = PathUtils.filename(path).replace(
            /\.pdf$/i,
            ".ocr.pdf",
          );
          const newPath = dir ? PathUtils.join(dir, basename) : basename;
          await IOUtils.write(newPath, ocrResult);

          const parentItem = item.parentItem || item;
          await Zotero.Attachments.importFromFile({
            file: newPath,
            parentItemID: parentItem.id,
          });

          // Clean up the temp file after import
          await IOUtils.remove(newPath);
        }

        // Step 10g: Show success
        progressItem.setText(getString("progress-done"));
        progressItem.setIcon("chrome://zotero/skin/tick.png");
        progressWin.startCloseTimer(4000);
      } catch (error: unknown) {
        // Step 11: Show failure for this item
        const message =
          error instanceof Error ? error.message : String(error);
        Zotero.logError(
          new Error(`[Adobe OCR] Failed to OCR "${itemTitle}": ${message}`),
        );
        showErrorProgress(
          getString("error-ocr-failed", { args: { message } }),
        );
      }
    }
  } catch (error: unknown) {
    // Step 12: Catch-all for unexpected errors
    const message = error instanceof Error ? error.message : String(error);
    Zotero.logError(new Error(`[Adobe OCR] Unexpected error: ${message}`));
    showErrorProgress(message);
  }
}

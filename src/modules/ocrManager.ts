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
// File-write helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a byte array looks like a PDF (non-empty with %PDF header).
 *
 * @param data - The bytes to validate.
 * @returns True if data starts with the %PDF magic bytes.
 */
function isValidPdf(data: Uint8Array): boolean {
  return (
    data.byteLength > 0 &&
    data[0] === 0x25 &&
    data[1] === 0x50 &&
    data[2] === 0x44 &&
    data[3] === 0x46
  );
}

/**
 * Safely overwrite a file by writing to a temp path, validating, then moving.
 *
 * The original file is only replaced after the OCR result is validated as a
 * non-empty PDF. If validation or the move fails, the original remains intact.
 *
 * @param path - The original file path to overwrite.
 * @param ocrResult - The OCR-processed PDF bytes.
 * @throws {Error} When the OCR result fails PDF validation.
 */
async function safeOverwrite(
  path: string,
  ocrResult: Uint8Array,
): Promise<void> {
  const tempPath = `${path}.ocr-tmp`;
  await IOUtils.write(tempPath, ocrResult);

  if (!isValidPdf(ocrResult)) {
    await IOUtils.remove(tempPath, { ignoreAbsent: true });
    throw new Error("OCR result failed validation: not a valid PDF");
  }

  try {
    await IOUtils.move(tempPath, path);
  } catch (moveError: unknown) {
    await IOUtils.remove(tempPath, { ignoreAbsent: true });
    throw moveError;
  }
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
      if (item.isAttachment()) {
        if (item.attachmentContentType === "application/pdf") {
          pdfItems.push(item);
        } else {
          nonPdfItems.push(item);
        }
      } else {
        // Parent/regular item -- look up child attachments for PDFs
        const childIds: number[] = item.getAttachments();
        let foundPdf = false;
        for (const childId of childIds) {
          const child = Zotero.Items.get(childId) as Zotero.Item;
          if (
            child.isAttachment() &&
            child.attachmentContentType === "application/pdf"
          ) {
            pdfItems.push(child);
            foundPdf = true;
          }
        }
        if (!foundPdf) {
          nonPdfItems.push(item);
        }
      }
    }

    // Deduplicate in case user selected both a parent and its PDF child
    const seenIds = new Set<number>();
    const uniquePdfItems: Zotero.Item[] = [];
    for (const item of pdfItems) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        uniquePdfItems.push(item);
      }
    }
    pdfItems.length = 0;
    pdfItems.push(...uniquePdfItems);

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

      let progressWin: any = null;
      let progressItem: any = null;

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
        progressWin = new Zotero.ProgressWindow({ closeOnClick: true });
        progressWin.changeHeadline(getString("progress-title"));
        progressItem = new progressWin.ItemProgress(
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
          await safeOverwrite(path, ocrResult);
        } else {
          const dir = PathUtils.parent(path);
          const filename = PathUtils.filename(path);
          const isPdf = /\.pdf$/i.test(filename);
          const basename = isPdf
            ? filename.replace(/\.pdf$/i, ".ocr.pdf")
            : `${filename}.ocr.pdf`;
          const newPath = dir ? PathUtils.join(dir, basename) : basename;
          await IOUtils.write(newPath, ocrResult);

          const importOptions: { file: string; parentItemID?: number } = {
            file: newPath,
          };
          if (item.parentItem) {
            importOptions.parentItemID = item.parentItem.id;
          }
          await Zotero.Attachments.importFromFile(importOptions);

          // Clean up the temp file after import
          await IOUtils.remove(newPath);
        }

        // Step 10g: Show success
        progressItem.setText(getString("progress-done"));
        progressItem.setIcon("chrome://zotero/skin/tick.png");
        progressWin.startCloseTimer(4000);
      } catch (error: unknown) {
        // Step 11: Show failure for this item
        const message = error instanceof Error ? error.message : String(error);
        Zotero.logError(
          new Error(`[Adobe OCR] Failed to OCR "${itemTitle}": ${message}`),
        );

        const errorText = getString("error-ocr-failed", { args: { message } });
        if (progressWin !== null && progressItem !== null) {
          progressItem.setIcon("chrome://zotero/skin/cross.png");
          progressItem.setText(errorText);
          progressWin.startCloseTimer(4000);
        } else {
          showErrorProgress(errorText);
        }
      }
    }
  } catch (error: unknown) {
    // Step 12: Catch-all for unexpected errors
    const message = error instanceof Error ? error.message : String(error);
    Zotero.logError(new Error(`[Adobe OCR] Unexpected error: ${message}`));
    showErrorProgress(message);
  }
}

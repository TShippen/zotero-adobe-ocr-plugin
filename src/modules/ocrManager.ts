/**
 * OCR manager module -- the orchestrator that bridges Zotero and the Adobe API.
 *
 * Reads the selected items, filters for PDFs, gathers credentials and user
 * preferences, presents the unified OCR dialog, and runs the OCR pipeline
 * for each selected PDF with cancellation support.
 */

import { AdobeApiError, getAccessToken, ocrPdf } from "./adobeApi";
import { openUnifiedDialog } from "./ocrDialog";

import { getString } from "../utils/locale";
import { logDebug, logError, logInfo } from "../utils/log";
import { getPref } from "../utils/prefs";

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

/**
 * Show a simple error alert for pre-processing errors.
 *
 * @param message - The error message to display
 */
function showError(message: string): void {
  const win = Zotero.getMainWindow();
  if (win) {
    Zotero.alert(win, getString("progress-title"), message);
  }
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
// Cancel confirmation prompt
// ---------------------------------------------------------------------------

/**
 * Show a cancel confirmation prompt during OCR processing.
 *
 * Displays a three-button prompt asking the user whether to complete
 * the current file, abandon immediately, or resume processing. The
 * default button is determined by the cancelBehavior preference.
 *
 * @returns The user's choice: "complete", "abandon", or "resume"
 */
async function showCancelPrompt(): Promise<"complete" | "abandon" | "resume"> {
  const defaultBehavior = getPref("cancelBehavior") as string;

  const ps = Services.prompt;
   
  const flags =
    ps.BUTTON_POS_0! * ps.BUTTON_TITLE_IS_STRING! +
    ps.BUTTON_POS_1! * ps.BUTTON_TITLE_IS_STRING! +
    ps.BUTTON_POS_2! * ps.BUTTON_TITLE_IS_STRING!;

  // Set the default button based on the preference
  const defaultButton =
    defaultBehavior === "abandon"
      ? ps.BUTTON_POS_1_DEFAULT!
      : ps.BUTTON_POS_0_DEFAULT!;
   

  const result = ps.confirmEx(
    Zotero.getMainWindow() as unknown as mozIDOMWindowProxy,
    getString("cancel-prompt-title"),
    getString("cancel-prompt-message"),
    flags + defaultButton,
    getString("cancel-btn-complete"),
    getString("cancel-btn-abandon"),
    getString("cancel-btn-resume"),
    "",
    { value: false },
  );

  switch (result) {
    case 0:
      return "complete";
    case 1:
      return "abandon";
    default:
      return "resume";
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * OCR the selected items in Zotero.
 *
 * Gathers selected PDF attachments, prompts the user with the unified OCR
 * dialog for options and progress, authenticates with Adobe, and processes
 * each PDF through the Adobe PDF Services OCR pipeline. Supports cancellation
 * with three behaviors: complete current file, abandon immediately, or resume.
 *
 * @param _window - The Zotero main window (reserved for future use)
 */
export async function ocrSelectedItems(_window: Window): Promise<void> {
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
      showError(getString("error-no-pdfs"));
      return;
    }

    // Step 4: Read credentials from prefs
    const clientId = getPref("clientId") as string;
    const clientSecret = getPref("clientSecret") as string;

    // Step 5: If credentials are empty, show error and return
    if (!clientId || !clientSecret) {
      showError(getString("error-no-credentials"));
      return;
    }

    // Step 6: Read defaults
    const ocrLang = getPref("ocrLang") as string;
    const ocrType = getPref("ocrType") as string;

    // Step 7: Open unified dialog
    const dialog = await openUnifiedDialog(pdfItems, nonPdfItems, {
      ocrLang,
      ocrType,
    });

    // Step 8: Wait for user to click Start OCR
    const result = await dialog.waitForStart();
    if (result === null) {
      dialog.destroy();
      return;
    }

    logInfo(
      `Starting OCR: ${pdfItems.length} PDF(s), mode=${result.overwrite ? "overwrite" : "new"}, lang=${result.ocrLang}, type=${result.ocrType}`,
    );

    // Step 9: Transition to processing phase
    dialog.beginProcessing();
    dialog.startOverallTimer();

    // Step 10: Get access token
    let accessToken: string;
    try {
      accessToken = await getAccessToken(clientId, clientSecret);
      logDebug("Access token acquired");
    } catch (error: unknown) {
      // Auth failure -- show error in footer, mark all as error
      const msg =
        error instanceof AdobeApiError
          ? error.userMessage
          : error instanceof Error
            ? error.message
            : String(error);
      logError(
        `Authentication failed: ${msg}`,
        error instanceof Error ? error : undefined,
      );
      for (let i = 0; i < pdfItems.length; i++) {
        dialog.setFileStatus(i, "error", msg);
      }
      dialog.showSummary(
        getString("footer-complete-some", {
          args: {
            completed: "0",
            total: String(pdfItems.length),
            elapsed: dialog.getOverallElapsed(),
          },
        }),
      );
      dialog.showCloseButton();
      await dialog.waitForClose();
      dialog.destroy();
      return;
    }

    // Step 11: Set up cancellation state
    // Use an object so TypeScript does not narrow the mutable fields.
    const cancel: {
      requested: boolean;
      behavior: "complete" | "abandon" | "resume";
      promiseResolve: (() => void) | null;
      promise: Promise<void> | null;
    } = {
      requested: false,
      behavior: "resume",
      promiseResolve: null,
      promise: null,
    };

    dialog.onCancel(async () => {
      // Pause everything immediately
      dialog.pauseTimers();
      cancel.requested = true;

      // Create a promise that resolves when the user makes their choice
      cancel.promise = new Promise<void>((resolve) => {
        cancel.promiseResolve = resolve;
      });

      // Show the cancel confirmation prompt
      const choice = await showCancelPrompt();
      cancel.behavior = choice;
      if (choice === "resume") {
        cancel.requested = false;
        dialog.resumeTimers();
      }
      cancel.promiseResolve?.();
    });

    // Step 12: Process each PDF sequentially
    let completedCount = 0;
    let cancelledEarly = false;

    for (let i = 0; i < pdfItems.length; i++) {
      // Check if cancel was requested between files
      if (cancel.requested) {
        // Wait for the user to make their cancel choice
        if (cancel.promise) {
          await cancel.promise;
        }

        if (cancel.behavior !== "resume") {
          // Mark remaining files as cancelled
          for (let j = i; j < pdfItems.length; j++) {
            dialog.setFileStatus(j, "cancelled");
          }
          cancelledEarly = true;
          break;
        }
      }

      const item = pdfItems[i];
      const itemTitle = item.getDisplayTitle();
      logDebug(`Processing "${itemTitle}"`);

      // Get file path
      const path = await item.getFilePathAsync();
      if (!path) {
        logError(`No file path for "${itemTitle}"`);
        dialog.setFileStatus(i, "error", getString("error-no-file"));
        continue;
      }

      try {
        // Read file
        const data = await IOUtils.read(path);

        // Update status and start timer
        dialog.setFileStatus(i, "uploading");
        dialog.startFileTimer(i);
        // Build progress callback
        const onProgress = (status: string): void => {
          switch (status) {
            case "uploading":
              dialog.setFileStatus(i, "uploading");
              break;
            case "processing":
              dialog.setFileStatus(i, "processing");
              break;
            case "downloading":
              dialog.setFileStatus(i, "downloading");
              break;
          }
        };

        // Build cancel check callback
        const shouldCancel = (): boolean =>
          cancel.requested && cancel.behavior === "abandon";

        const ocrResult = await ocrPdf(
          data,
          clientId,
          accessToken,
          { ocrLang: result.ocrLang, ocrType: result.ocrType },
          onProgress,
          shouldCancel,
        );

        // Check if abandoned during processing
        if (cancel.requested && cancel.behavior === "abandon") {
          dialog.setFileStatus(i, "cancelled");
          dialog.freezeFileTimer(i);
          // Mark remaining
          for (let j = i + 1; j < pdfItems.length; j++) {
            dialog.setFileStatus(j, "cancelled");
          }
          cancelledEarly = true;
          break;
        }

        // Save result
        dialog.setFileStatus(i, "saving");

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
          await IOUtils.remove(newPath);
        }

        dialog.setFileStatus(i, "complete");
        dialog.freezeFileTimer(i);
        completedCount++;
        logInfo(`OCR complete: "${itemTitle}"`);

        // If cancel was requested with "complete" behavior, we finished this file, now stop
        if (cancel.requested && cancel.behavior === "complete") {
          for (let j = i + 1; j < pdfItems.length; j++) {
            dialog.setFileStatus(j, "cancelled");
          }
          cancelledEarly = true;
          break;
        }
      } catch (error: unknown) {
        // Check if this was a cancellation error
        const isApiError = error instanceof AdobeApiError;
        if (isApiError && error.step === "ocr-cancelled") {
          dialog.setFileStatus(i, "cancelled");
          dialog.freezeFileTimer(i);
          for (let j = i + 1; j < pdfItems.length; j++) {
            dialog.setFileStatus(j, "cancelled");
          }
          cancelledEarly = true;
          logInfo(`OCR cancelled by user at "${itemTitle}"`);
          break;
        }

        const technicalMsg =
          error instanceof Error ? error.message : String(error);
        const userMsg = isApiError ? error.userMessage : technicalMsg;

        logError(
          `Failed to OCR "${itemTitle}": ${technicalMsg}`,
          error instanceof Error ? error : undefined,
        );

        dialog.setFileStatus(i, "error", userMsg);
        dialog.freezeFileTimer(i);
      }
    }

    // Step 13: Show summary
    const elapsed = dialog.getOverallElapsed();
    if (cancelledEarly) {
      dialog.showSummary(
        getString("footer-cancelled", {
          args: {
            completed: String(completedCount),
            total: String(pdfItems.length),
            elapsed,
          },
        }),
      );
    } else if (completedCount === pdfItems.length) {
      dialog.showSummary(
        getString("footer-complete-all", {
          args: {
            completed: String(completedCount),
            total: String(pdfItems.length),
            elapsed,
          },
        }),
      );
    } else {
      dialog.showSummary(
        getString("footer-complete-some", {
          args: {
            completed: String(completedCount),
            total: String(pdfItems.length),
            elapsed,
          },
        }),
      );
    }

    dialog.showCloseButton();

    // Step 14: Wait for user to close
    await dialog.waitForClose();
    dialog.destroy();
  } catch (error: unknown) {
    // Catch-all for unexpected errors
    const message = error instanceof Error ? error.message : String(error);
    logError(
      `Unexpected error: ${message}`,
      error instanceof Error ? error : undefined,
    );
    showError(message);
  }
}

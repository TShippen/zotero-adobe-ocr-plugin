/**
 * OCR pre-flight dialog module.
 *
 * Shows a modal dialog before OCR processing begins, allowing the user to
 * review the files to be processed, choose output mode, language, and OCR type.
 */

import { DialogHelper } from "zotero-plugin-toolkit";

import { OCR_LANGUAGES, OCR_TYPES } from "./adobeApi";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Result returned when the user confirms the OCR dialog. */
export interface OcrDialogResult {
  /** Whether to overwrite the original PDF (true) or create a new attachment (false). */
  readonly overwrite: boolean;
  /** OCR language locale code (e.g. "en-US"). */
  readonly ocrLang: string;
  /** OCR output type (e.g. "searchable_image" or "searchable_image_exact"). */
  readonly ocrType: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIALOG_TITLE = "OCR with Adobe PDF Services";
const OUTPUT_MODE_REPLACE = "replace";
const OUTPUT_MODE_NEW = "new";

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Show the OCR pre-flight dialog.
 *
 * Displays a modal dialog listing the PDF items to process, any skipped non-PDF
 * items, and controls for output mode, language, and OCR type. Blocks until the
 * user confirms or cancels.
 *
 * @param _window - The Zotero main window (reserved for future use)
 * @param pdfItems - PDF attachment items that will be processed
 * @param nonPdfItems - Non-PDF items that will be skipped
 * @param defaults - Default values from preferences
 * @param defaults.ocrLang - Default OCR language locale code
 * @param defaults.ocrType - Default OCR output type
 * @returns The user's choices, or null if canceled
 */
export async function showOcrDialog(
  _window: Window,
  pdfItems: Zotero.Item[],
  nonPdfItems: Zotero.Item[],
  defaults: { ocrLang: string; ocrType: string },
): Promise<OcrDialogResult | null> {
  const dialogData: Record<string, unknown> = {
    outputMode: OUTPUT_MODE_NEW,
    ocrLang: defaults.ocrLang,
    ocrType: defaults.ocrType,
  };

  const hasSkipped = nonPdfItems.length > 0;
  // Row count: files label, files list, [skipped label, skipped list,]
  //            separator, output label, output radios, lang row, type row
  const totalRows = hasSkipped ? 9 : 7;
  const dialog = new DialogHelper(totalRows, 1);

  let row = 0;

  // --- Files to process section ---
  dialog.addCell(row++, 0, {
    tag: "label",
    namespace: "html",
    properties: {
      innerHTML: `<strong>Files to process (${pdfItems.length}):</strong>`,
    },
    styles: { marginBottom: "4px", fontSize: "13px" },
  });

  dialog.addCell(row++, 0, {
    tag: "div",
    namespace: "html",
    properties: { innerHTML: buildFileListHtml(pdfItems) },
    styles: {
      maxHeight: "120px",
      overflowY: "auto",
      padding: "4px 8px",
      marginBottom: "8px",
      border: "1px solid #ccc",
      borderRadius: "4px",
      fontSize: "12px",
      lineHeight: "1.4",
    },
  });

  // --- Skipped items section (conditional) ---
  if (hasSkipped) {
    dialog.addCell(row++, 0, {
      tag: "label",
      namespace: "html",
      properties: {
        innerHTML: `<strong>Will be skipped - not PDF (${nonPdfItems.length}):</strong>`,
      },
      styles: { marginBottom: "4px", fontSize: "13px", color: "#888" },
    });

    dialog.addCell(row++, 0, {
      tag: "div",
      namespace: "html",
      properties: { innerHTML: buildSkippedListHtml(nonPdfItems) },
      styles: {
        maxHeight: "80px",
        overflowY: "auto",
        padding: "4px 8px",
        marginBottom: "8px",
        border: "1px solid #ddd",
        borderRadius: "4px",
        fontSize: "12px",
        lineHeight: "1.4",
        color: "#888",
        fontStyle: "italic",
      },
    });
  }

  // --- Separator ---
  dialog.addCell(row++, 0, {
    tag: "hr",
    namespace: "html",
    styles: {
      width: "100%",
      border: "none",
      borderTop: "1px solid #ddd",
      marginTop: "4px",
      marginBottom: "8px",
    },
  });

  // --- Output mode ---
  dialog.addCell(row++, 0, {
    tag: "label",
    namespace: "html",
    properties: { innerHTML: "<strong>Output mode:</strong>" },
    styles: { marginBottom: "4px", fontSize: "13px" },
  });

  dialog.addCell(row++, 0, {
    tag: "div",
    namespace: "html",
    id: "ocr-dialog-output-mode",
    styles: {
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      marginBottom: "8px",
      paddingLeft: "8px",
    },
    children: [
      {
        tag: "label",
        namespace: "html",
        styles: { fontSize: "12px", cursor: "pointer" },
        children: [
          {
            tag: "input",
            namespace: "html",
            id: "ocr-radio-new",
            attributes: {
              type: "radio",
              name: "outputMode",
              value: OUTPUT_MODE_NEW,
              checked: true,
            },
            styles: { marginRight: "6px" },
          },
          {
            tag: "span",
            namespace: "html",
            properties: {
              textContent: "Create new attachment (.ocr.pdf)",
            },
          },
        ],
      },
      {
        tag: "label",
        namespace: "html",
        styles: { fontSize: "12px", cursor: "pointer" },
        children: [
          {
            tag: "input",
            namespace: "html",
            id: "ocr-radio-replace",
            attributes: {
              type: "radio",
              name: "outputMode",
              value: OUTPUT_MODE_REPLACE,
            },
            styles: { marginRight: "6px" },
          },
          {
            tag: "span",
            namespace: "html",
            properties: { textContent: "Replace original PDF" },
          },
        ],
      },
    ],
  });

  // --- Language dropdown ---
  dialog.addCell(row++, 0, {
    tag: "div",
    namespace: "html",
    styles: {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      marginBottom: "8px",
    },
    children: [
      {
        tag: "label",
        namespace: "html",
        properties: { innerHTML: "<strong>Language:</strong>" },
        styles: { fontSize: "13px", minWidth: "80px" },
      },
      {
        tag: "select",
        namespace: "html",
        id: "ocr-dialog-lang",
        attributes: {
          "data-bind": "ocrLang",
          "data-prop": "value",
        },
        children: OCR_LANGUAGES.map((lang) => ({
          tag: "option",
          namespace: "html",
          properties: { value: lang.code, textContent: lang.label },
        })),
        styles: { flex: "1", fontSize: "12px" },
      },
    ],
  });

  // --- OCR type dropdown ---
  dialog.addCell(row++, 0, {
    tag: "div",
    namespace: "html",
    styles: {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      marginBottom: "4px",
    },
    children: [
      {
        tag: "label",
        namespace: "html",
        properties: { innerHTML: "<strong>OCR type:</strong>" },
        styles: { fontSize: "13px", minWidth: "80px" },
      },
      {
        tag: "select",
        namespace: "html",
        id: "ocr-dialog-type",
        attributes: {
          "data-bind": "ocrType",
          "data-prop": "value",
        },
        children: OCR_TYPES.map((type) => ({
          tag: "option",
          namespace: "html",
          properties: {
            value: type.value,
            textContent: `${type.label} - ${type.description}`,
          },
        })),
        styles: { flex: "1", fontSize: "12px" },
      },
    ],
  });

  // --- Buttons ---
  dialog.addButton("OK", "ok");
  dialog.addButton("Cancel", "cancel");

  // --- Dialog data with lifecycle hooks ---
  dialogData.beforeUnloadCallback = () => {
    const dialogWin = dialog.window;
    if (!dialogWin) {
      return;
    }
    const checkedRadio = dialogWin.document.querySelector(
      'input[name="outputMode"]:checked',
    ) as HTMLInputElement | null;
    if (checkedRadio) {
      dialogData.outputMode = checkedRadio.value;
    }
  };

  dialog.setDialogData(dialogData);
  dialog.open(DIALOG_TITLE, {
    centerscreen: true,
    fitContent: true,
    resizable: false,
  });

  // Wait for the dialog window to close
  const unloadLock = dialogData.unloadLock as
    | { promise: Promise<void> }
    | undefined;
  await unloadLock?.promise;

  // Read result from dialog
  if (dialogData._lastButtonId !== "ok") {
    return null;
  }

  return {
    overwrite: dialogData.outputMode === OUTPUT_MODE_REPLACE,
    ocrLang: dialogData.ocrLang as string,
    ocrType: dialogData.ocrType as string,
  };
}

// ---------------------------------------------------------------------------
// HTML builders
// ---------------------------------------------------------------------------

/**
 * Build an HTML list of PDF item titles for display in the dialog.
 *
 * @param items - PDF attachment items
 * @returns HTML string with the file list
 */
function buildFileListHtml(items: Zotero.Item[]): string {
  if (items.length === 0) {
    return "<em>No PDF files selected.</em>";
  }
  return items
    .map((item) => `<div>${escapeHtml(item.getDisplayTitle())}</div>`)
    .join("");
}

/**
 * Build an HTML list of skipped (non-PDF) item titles for display in the dialog.
 *
 * @param items - Non-PDF items that will be skipped
 * @returns HTML string with the skipped file list
 */
function buildSkippedListHtml(items: Zotero.Item[]): string {
  return items
    .map((item) => `<div>${escapeHtml(item.getDisplayTitle())}</div>`)
    .join("");
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe inclusion in HTML content.
 *
 * @param text - The raw text to escape
 * @returns The HTML-escaped string
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

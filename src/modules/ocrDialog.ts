/**
 * Unified OCR dialog module.
 *
 * Presents a single modal dialog that handles both OCR configuration (output
 * mode, language, OCR type) and real-time progress tracking (per-file status,
 * per-file timers, overall timer, and summary footer). Returns a
 * {@link UnifiedDialogHandle} that the orchestrator uses to drive each phase
 * of the OCR pipeline.
 */

import { DialogHelper } from "zotero-plugin-toolkit";

import { OCR_LANGUAGES, OCR_TYPES } from "./adobeApi";

import { getString } from "../utils/locale";
import { logDebug } from "../utils/log";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-file status values. */
export type FileStatus =
  | "not-started"
  | "waiting"
  | "uploading"
  | "processing"
  | "downloading"
  | "saving"
  | "complete"
  | "error"
  | "cancelled";

/** Result returned after the options phase (user clicks Start OCR). */
export interface OcrDialogStartResult {
  /** Whether to overwrite the original PDF (true) or create a new attachment (false). */
  readonly overwrite: boolean;
  /** OCR language locale code (e.g. "en-US"). */
  readonly ocrLang: string;
  /** OCR output type (e.g. "searchable_image" or "searchable_image_exact"). */
  readonly ocrType: string;
}

/** Handle for controlling the unified dialog during processing. */
export interface UnifiedDialogHandle {
  /** Wait for user to click Start OCR. Returns config or null if cancelled. */
  waitForStart: () => Promise<OcrDialogStartResult | null>;
  /** Transition all files from "not-started" to "waiting" and disable options. */
  beginProcessing: () => void;
  /** Update a file's status indicator and text. */
  setFileStatus: (
    index: number,
    status: FileStatus,
    errorTooltip?: string,
  ) => void;
  /** Start the per-file timer for the given index. */
  startFileTimer: (index: number) => void;
  /** Freeze the per-file timer for the given index, keeping its final value. */
  freezeFileTimer: (index: number) => void;
  /** Start the overall footer timer. */
  startOverallTimer: () => void;
  /** Pause all running timers (freeze display, remember elapsed). */
  pauseTimers: () => void;
  /** Resume all paused timers from where they left off. */
  resumeTimers: () => void;
  /** Replace the footer with summary text and freeze the overall timer. */
  showSummary: (text: string) => void;
  /** Change the Cancel button text to "Close". */
  showCloseButton: () => void;
  /** Register a callback invoked when Cancel is clicked during processing. */
  onCancel: (handler: () => void) => void;
  /** Wait for the dialog window to be closed by the user. */
  waitForClose: () => Promise<void>;
  /** Get the overall elapsed time formatted as M:SS. */
  getOverallElapsed: () => string;
  /** Clear all setInterval handles to prevent memory leaks. */
  destroy: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DIALOG_TITLE = "OCR with Adobe PDF Services";
const OUTPUT_MODE_REPLACE = "replace";
const OUTPUT_MODE_NEW = "new";

/** Unicode checkmark indicator for completed files. */
const CHECKMARK = "\u2713";

/** Unicode ballot X indicator for failed files. */
const BALLOT_X = "\u2717";

// ---------------------------------------------------------------------------
// Status display mapping
// ---------------------------------------------------------------------------

/** Configuration for rendering each file status. */
interface StatusDisplay {
  /** Localized display text. */
  readonly text: string;
  /** CSS color value. */
  readonly color: string;
  /** Optional prefix character (checkmark or X). */
  readonly prefix?: string;
}

/**
 * Build the display configuration for a given file status.
 *
 * @param status - The file status value
 * @returns Display text, color, and optional prefix for the status
 */
function getStatusDisplay(status: FileStatus): StatusDisplay {
  switch (status) {
    case "not-started":
      return { text: getString("status-not-started"), color: "#888" };
    case "waiting":
      return { text: getString("status-waiting"), color: "#888" };
    case "uploading":
      return { text: getString("progress-uploading"), color: "" };
    case "processing":
      return { text: getString("progress-processing"), color: "" };
    case "downloading":
      return { text: getString("progress-downloading"), color: "" };
    case "saving":
      return { text: getString("progress-saving"), color: "" };
    case "complete":
      return {
        text: getString("status-complete"),
        color: "#2e7d32",
        prefix: CHECKMARK,
      };
    case "error":
      return {
        text: getString("status-error"),
        color: "#d32f2f",
        prefix: BALLOT_X,
      };
    case "cancelled":
      return { text: getString("status-cancelled"), color: "#888" };
  }
}

// ---------------------------------------------------------------------------
// Timer utilities
// ---------------------------------------------------------------------------

/**
 * Format a millisecond duration as M:SS.
 *
 * @param ms - Elapsed time in milliseconds
 * @returns Formatted string like "0:05" or "1:23"
 */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

/** Mutable state for a single timer (per-file or overall). */
interface TimerState {
  /** Timestamp (ms) when the timer was started or last resumed. */
  startTime: number;
  /** Accumulated elapsed ms from previous pause/resume cycles. */
  accumulatedMs: number;
  /** Active setInterval handle, or null if not running. */
  intervalId: ReturnType<typeof setInterval> | null;
  /** Whether the timer has been frozen (terminal state reached). */
  frozen: boolean;
}

/**
 * Create a fresh timer state with no accumulated time.
 *
 * @returns A new TimerState in the initial (not yet started) state
 */
function createTimerState(): TimerState {
  return { startTime: 0, accumulatedMs: 0, intervalId: null, frozen: false };
}

/**
 * Get the total elapsed milliseconds for a timer, including accumulated time.
 *
 * @param timer - The timer state to measure
 * @returns Total elapsed milliseconds
 */
function getTimerElapsedMs(timer: TimerState): number {
  if (timer.intervalId !== null) {
    return timer.accumulatedMs + (Date.now() - timer.startTime);
  }
  return timer.accumulatedMs;
}

// ---------------------------------------------------------------------------
// HTML builders
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Open the unified OCR dialog.
 *
 * Builds a single DialogHelper window containing the options panel (output mode,
 * language, OCR type), a file list table with status and timer columns, and a
 * footer for overall progress. Returns a handle used by the orchestrator to
 * drive the dialog through its lifecycle phases.
 *
 * @param pdfItems - PDF attachment items that will be processed
 * @param nonPdfItems - Non-PDF items that will be skipped
 * @param defaults - Default values from preferences
 * @param defaults.ocrLang - Default OCR language locale code
 * @param defaults.ocrType - Default OCR output type
 * @returns A handle for controlling the dialog during processing
 */
export async function openUnifiedDialog(
  pdfItems: Zotero.Item[],
  nonPdfItems: Zotero.Item[],
  defaults: { ocrLang: string; ocrType: string },
): Promise<UnifiedDialogHandle> {
  const dialogData: Record<string, unknown> = {};

  const hasSkipped = nonPdfItems.length > 0;

  // Row plan (single column):
  //   [0]    Skipped items label (conditional)
  //   [1]    Skipped items list  (conditional)
  //   [2]    Separator
  //   [3]    Output mode label + radios
  //   [4]    Language dropdown row
  //   [5]    OCR type dropdown row
  //   [6]    Separator
  //   [7]    File list table (scrollable)
  //   [8]    Footer label
  //   [9]    Button row (Start OCR + Cancel)
  const baseRows = 8; // separator, output, lang, type, separator, table, footer, buttons
  const totalRows = hasSkipped ? baseRows + 2 : baseRows;
  const dialog = new DialogHelper(totalRows, 1);

  let row = 0;

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

  // --- Output mode radios ---
  dialog.addCell(row++, 0, {
    tag: "div",
    namespace: "html",
    id: "ocr-dialog-output-mode",
    styles: {
      marginBottom: "8px",
    },
    children: [
      {
        tag: "label",
        namespace: "html",
        properties: { textContent: "Output mode:" },
        styles: {
          fontSize: "13px",
          fontWeight: "bold",
          display: "block",
          marginBottom: "4px",
        },
      },
      {
        tag: "div",
        namespace: "html",
        styles: {
          display: "flex",
          flexDirection: "column",
          gap: "4px",
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
        id: "ocr-dialog-lang-label",
        properties: { textContent: "Language:" },
        attributes: { for: "ocr-dialog-lang" },
        styles: { fontSize: "13px", fontWeight: "bold", minWidth: "80px" },
      },
      {
        tag: "select",
        namespace: "html",
        id: "ocr-dialog-lang",
        attributes: { "aria-labelledby": "ocr-dialog-lang-label" },
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
        id: "ocr-dialog-type-label",
        properties: { textContent: "OCR type:" },
        attributes: { for: "ocr-dialog-type" },
        styles: { fontSize: "13px", fontWeight: "bold", minWidth: "80px" },
      },
      {
        tag: "select",
        namespace: "html",
        id: "ocr-dialog-type",
        attributes: { "aria-labelledby": "ocr-dialog-type-label" },
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

  // --- File list table ---
  const tableRows = pdfItems.map((item, index) => ({
    tag: "tr",
    namespace: "html",
    children: [
      {
        tag: "td",
        namespace: "html",
        properties: { textContent: item.getDisplayTitle() },
        styles: {
          padding: "3px 8px 3px 0",
          fontSize: "12px",
          wordBreak: "break-word",
          maxWidth: "280px",
        },
      },
      {
        tag: "td",
        namespace: "html",
        id: `ocr-file-${index}-status`,
        properties: { textContent: getString("status-not-started") },
        styles: {
          padding: "3px 8px",
          fontSize: "12px",
          color: "#888",
          whiteSpace: "nowrap",
        },
      },
      {
        tag: "td",
        namespace: "html",
        id: `ocr-file-${index}-timer`,
        properties: { textContent: "--" },
        styles: {
          padding: "3px 0 3px 8px",
          fontSize: "12px",
          color: "#888",
          whiteSpace: "nowrap",
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
        },
      },
    ],
  }));

  dialog.addCell(row++, 0, {
    tag: "div",
    namespace: "html",
    styles: {
      maxHeight: "200px",
      overflowY: "auto",
      border: "1px solid #ccc",
      borderRadius: "4px",
      padding: "4px 8px",
      marginBottom: "8px",
    },
    children: [
      {
        tag: "table",
        namespace: "html",
        attributes: { "aria-label": "OCR file processing status" },
        styles: { width: "100%", borderCollapse: "collapse" },
        children: [
          {
            tag: "thead",
            namespace: "html",
            children: [
              {
                tag: "tr",
                namespace: "html",
                children: [
                  {
                    tag: "th",
                    namespace: "html",
                    properties: { textContent: "File Name" },
                    styles: {
                      textAlign: "left",
                      padding: "3px 8px 3px 0",
                      fontSize: "11px",
                      fontWeight: "bold",
                      borderBottom: "1px solid #ddd",
                      color: "#666",
                    },
                  },
                  {
                    tag: "th",
                    namespace: "html",
                    properties: { textContent: "Status" },
                    styles: {
                      textAlign: "left",
                      padding: "3px 8px",
                      fontSize: "11px",
                      fontWeight: "bold",
                      borderBottom: "1px solid #ddd",
                      color: "#666",
                    },
                  },
                  {
                    tag: "th",
                    namespace: "html",
                    properties: { textContent: "Timer" },
                    styles: {
                      textAlign: "right",
                      padding: "3px 0 3px 8px",
                      fontSize: "11px",
                      fontWeight: "bold",
                      borderBottom: "1px solid #ddd",
                      color: "#666",
                    },
                  },
                ],
              },
            ],
          },
          {
            tag: "tbody",
            namespace: "html",
            children: tableRows,
          },
        ],
      },
    ],
  });

  // --- Footer ---
  dialog.addCell(row++, 0, {
    tag: "label",
    namespace: "html",
    id: "ocr-footer",
    properties: { textContent: "" },
    styles: {
      fontSize: "12px",
      color: "#555",
      marginBottom: "8px",
      display: "block",
      minHeight: "16px",
    },
  });

  // --- Button row (custom HTML buttons, not DialogHelper buttons) ---
  dialog.addCell(row++, 0, {
    tag: "div",
    namespace: "html",
    styles: {
      display: "flex",
      justifyContent: "flex-end",
      gap: "8px",
      marginTop: "4px",
    },
    children: [
      {
        tag: "button",
        namespace: "html",
        id: "ocr-btn-start",
        properties: { textContent: getString("btn-start-ocr") },
        styles: {
          padding: "4px 16px",
          fontSize: "13px",
          cursor: "pointer",
        },
      },
      {
        tag: "button",
        namespace: "html",
        id: "ocr-btn-cancel",
        properties: { textContent: getString("btn-cancel") },
        styles: {
          padding: "4px 16px",
          fontSize: "13px",
          cursor: "pointer",
        },
      },
    ],
  });

  // --- Open dialog ---
  dialog.setDialogData(dialogData);
  dialog.open(DIALOG_TITLE, {
    centerscreen: true,
    fitContent: true,
    resizable: true,
  });

  // Wait for the dialog DOM to be ready
  const loadLock = dialogData.loadLock as
    | { promise: Promise<void> }
    | undefined;
  await loadLock?.promise;

  const win = dialog.window;
  if (!win) {
    throw new Error("Dialog window failed to open");
  }
  const doc = win.document;
  logDebug(
    `Dialog opened with ${pdfItems.length} PDF(s), ${nonPdfItems.length} skipped`,
  );

  // --- Set default dropdown values from preferences ---
  const langSelect = doc.getElementById(
    "ocr-dialog-lang",
  ) as HTMLSelectElement | null;
  if (langSelect) {
    langSelect.value = defaults.ocrLang;
  }

  const typeSelect = doc.getElementById(
    "ocr-dialog-type",
  ) as HTMLSelectElement | null;
  if (typeSelect) {
    typeSelect.value = defaults.ocrType;
  }

  // --- Timer state ---
  const fileTimers: TimerState[] = pdfItems.map(() => createTimerState());
  const overallTimer: TimerState = createTimerState();

  // --- Cancel handler state ---
  let cancelHandler: (() => void) | null = null;
  let isProcessingPhase = false;
  let isPostProcessing = false;

  // --- Close promise (resolves when the dialog window unloads) ---
  const closePromise = new Promise<void>((resolve) => {
    win.addEventListener("unload", () => {
      resolve();
    });
  });

  // ---------------------------------------------------------------------------
  // Helper: update a timer cell in the DOM
  // ---------------------------------------------------------------------------

  /**
   * Write a formatted elapsed time into a file's timer cell.
   *
   * @param index - File index in the list
   * @param timer - The timer state to read elapsed from
   */
  function updateTimerCell(index: number, timer: TimerState): void {
    const cell = doc.getElementById(
      `ocr-file-${index}-timer`,
    ) as HTMLElement | null;
    if (cell) {
      cell.textContent = formatElapsed(getTimerElapsedMs(timer));
      cell.style.color = "";
    }
  }

  /**
   * Write a formatted elapsed time into the footer label.
   */
  function updateFooterTimer(): void {
    const footer = doc.getElementById("ocr-footer");
    if (footer) {
      const elapsed = formatElapsed(getTimerElapsedMs(overallTimer));
      footer.textContent = getString("footer-processing", {
        args: { elapsed },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Build the handle
  // ---------------------------------------------------------------------------

  const handle: UnifiedDialogHandle = {
    waitForStart(): Promise<OcrDialogStartResult | null> {
      return new Promise<OcrDialogStartResult | null>((resolve) => {
        const startBtn = doc.getElementById(
          "ocr-btn-start",
        ) as HTMLButtonElement | null;
        const cancelBtn = doc.getElementById(
          "ocr-btn-cancel",
        ) as HTMLButtonElement | null;

        if (startBtn) {
          startBtn.addEventListener("click", (event: Event) => {
            event.preventDefault();
            event.stopPropagation();

            // Read form values from the DOM
            const checkedRadio = doc.querySelector(
              'input[name="outputMode"]:checked',
            ) as HTMLInputElement | null;
            const overwrite = checkedRadio?.value === OUTPUT_MODE_REPLACE;

            const langEl = doc.getElementById(
              "ocr-dialog-lang",
            ) as HTMLSelectElement | null;
            const ocrLang = langEl?.value ?? defaults.ocrLang;

            const typeEl = doc.getElementById(
              "ocr-dialog-type",
            ) as HTMLSelectElement | null;
            const ocrType = typeEl?.value ?? defaults.ocrType;

            logDebug(
              `Start OCR clicked: lang=${ocrLang}, type=${ocrType}, overwrite=${overwrite}`,
            );
            resolve({ overwrite, ocrLang, ocrType });
          });
        }

        if (cancelBtn) {
          cancelBtn.addEventListener("click", (event: Event) => {
            event.preventDefault();
            event.stopPropagation();

            if (!isProcessingPhase || isPostProcessing) {
              // Options phase or post-processing: close the dialog
              logDebug("Dialog cancelled by user");
              resolve(null);
              win.close();
            } else {
              // Processing phase: invoke the registered cancel handler
              cancelHandler?.();
            }
          });
        }

        // Also handle window close via window manager (X button)
        win.addEventListener("unload", () => {
          resolve(null);
        });
      });
    },

    beginProcessing(): void {
      logDebug("Transitioning dialog to processing phase");
      isProcessingPhase = true;

      // Disable the Start OCR button
      const startBtn = doc.getElementById(
        "ocr-btn-start",
      ) as HTMLButtonElement | null;
      if (startBtn) {
        startBtn.disabled = true;
        startBtn.style.opacity = "0.5";
        startBtn.style.cursor = "default";
      }

      // Disable output mode radios
      const radios = doc.querySelectorAll(
        'input[name="outputMode"]',
      ) as NodeListOf<HTMLInputElement>;
      for (const radio of radios) {
        radio.disabled = true;
      }

      // Grey out the output mode container
      const outputModeDiv = doc.getElementById(
        "ocr-dialog-output-mode",
      ) as HTMLElement | null;
      if (outputModeDiv) {
        outputModeDiv.style.opacity = "0.5";
      }

      // Disable language dropdown
      const langEl = doc.getElementById(
        "ocr-dialog-lang",
      ) as HTMLSelectElement | null;
      if (langEl) {
        langEl.disabled = true;
        const langParent = langEl.parentElement as HTMLElement | null;
        if (langParent) {
          langParent.style.opacity = "0.5";
        }
      }

      // Disable OCR type dropdown
      const typeEl = doc.getElementById(
        "ocr-dialog-type",
      ) as HTMLSelectElement | null;
      if (typeEl) {
        typeEl.disabled = true;
        const typeParent = typeEl.parentElement as HTMLElement | null;
        if (typeParent) {
          typeParent.style.opacity = "0.5";
        }
      }

      // Change all file statuses from "not-started" to "waiting"
      for (let i = 0; i < pdfItems.length; i++) {
        handle.setFileStatus(i, "waiting");
      }
    },

    setFileStatus(
      index: number,
      status: FileStatus,
      errorTooltip?: string,
    ): void {
      const cell = doc.getElementById(
        `ocr-file-${index}-status`,
      ) as HTMLElement | null;
      if (!cell) {
        return;
      }

      const display = getStatusDisplay(status);
      const prefix = display.prefix ? `${display.prefix} ` : "";
      cell.textContent = `${prefix}${display.text}`;
      cell.style.color = display.color;

      if (status === "error" && errorTooltip) {
        cell.title = errorTooltip;
        cell.setAttribute("aria-label", `${display.text}: ${errorTooltip}`);
      } else {
        cell.title = "";
        cell.removeAttribute("aria-label");
      }
    },

    startFileTimer(index: number): void {
      const timer = fileTimers[index];
      if (!timer || timer.frozen) {
        return;
      }

      timer.startTime = Date.now();
      timer.intervalId = setInterval(() => {
        updateTimerCell(index, timer);
      }, 1000);

      // Immediate first update
      updateTimerCell(index, timer);
    },

    freezeFileTimer(index: number): void {
      const timer = fileTimers[index];
      if (!timer) {
        return;
      }

      if (timer.intervalId !== null) {
        timer.accumulatedMs += Date.now() - timer.startTime;
        clearInterval(timer.intervalId);
        timer.intervalId = null;
      }
      timer.frozen = true;

      // Write final value
      updateTimerCell(index, timer);
    },

    startOverallTimer(): void {
      overallTimer.startTime = Date.now();
      overallTimer.intervalId = setInterval(() => {
        updateFooterTimer();
      }, 1000);

      // Immediate first update
      updateFooterTimer();
    },

    pauseTimers(): void {
      // Pause per-file timers
      for (const timer of fileTimers) {
        if (timer.intervalId !== null && !timer.frozen) {
          timer.accumulatedMs += Date.now() - timer.startTime;
          clearInterval(timer.intervalId);
          timer.intervalId = null;
        }
      }

      // Pause overall timer
      if (overallTimer.intervalId !== null && !overallTimer.frozen) {
        overallTimer.accumulatedMs += Date.now() - overallTimer.startTime;
        clearInterval(overallTimer.intervalId);
        overallTimer.intervalId = null;
      }
    },

    resumeTimers(): void {
      // Resume per-file timers
      for (let i = 0; i < fileTimers.length; i++) {
        const timer = fileTimers[i];
        if (
          !timer.frozen &&
          timer.intervalId === null &&
          timer.accumulatedMs > 0
        ) {
          timer.startTime = Date.now();
          const idx = i;
          timer.intervalId = setInterval(() => {
            updateTimerCell(idx, timer);
          }, 1000);
        }
      }

      // Resume overall timer
      if (
        !overallTimer.frozen &&
        overallTimer.intervalId === null &&
        overallTimer.accumulatedMs > 0
      ) {
        overallTimer.startTime = Date.now();
        overallTimer.intervalId = setInterval(() => {
          updateFooterTimer();
        }, 1000);
      }
    },

    showSummary(text: string): void {
      logDebug(`Showing summary: ${text}`);
      // Freeze overall timer
      if (overallTimer.intervalId !== null) {
        overallTimer.accumulatedMs += Date.now() - overallTimer.startTime;
        clearInterval(overallTimer.intervalId);
        overallTimer.intervalId = null;
      }
      overallTimer.frozen = true;

      const footer = doc.getElementById("ocr-footer");
      if (footer) {
        footer.textContent = text;
      }
    },

    showCloseButton(): void {
      isPostProcessing = true;
      const cancelBtn = doc.getElementById(
        "ocr-btn-cancel",
      ) as HTMLButtonElement | null;
      if (cancelBtn) {
        cancelBtn.textContent = getString("btn-close");
      }
    },

    onCancel(handler: () => void): void {
      cancelHandler = handler;
    },

    waitForClose(): Promise<void> {
      return closePromise;
    },

    getOverallElapsed(): string {
      return formatElapsed(getTimerElapsedMs(overallTimer));
    },

    destroy(): void {
      logDebug("Dialog destroyed, clearing timers");
      // Clear all per-file timer intervals
      for (const timer of fileTimers) {
        if (timer.intervalId !== null) {
          clearInterval(timer.intervalId);
          timer.intervalId = null;
        }
      }

      // Clear overall timer interval
      if (overallTimer.intervalId !== null) {
        clearInterval(overallTimer.intervalId);
        overallTimer.intervalId = null;
      }
    },
  };

  return handle;
}

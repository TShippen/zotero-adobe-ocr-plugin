/**
 * Adobe PDF Services REST API client module.
 *
 * Handles authentication, file upload, OCR job submission, polling,
 * and result download using fetch(). Logs diagnostics through the
 * plugin logger utility.
 */

import { logDebug, logTrace } from "../utils/log";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Supported OCR language locales for Adobe PDF Services. */
export const OCR_LANGUAGES: ReadonlyArray<{
  readonly code: string;
  readonly label: string;
}> = [
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (GB)" },
  { code: "de-DE", label: "German" },
  { code: "fr-FR", label: "French" },
  { code: "es-ES", label: "Spanish" },
  { code: "it-IT", label: "Italian" },
  { code: "ja-JP", label: "Japanese" },
  { code: "ko-KR", label: "Korean" },
  { code: "pt-BR", label: "Portuguese (BR)" },
  { code: "zh-Hans", label: "Chinese (Simplified)" },
  { code: "zh-Hant", label: "Chinese (Traditional)" },
  { code: "nl-NL", label: "Dutch" },
  { code: "sv-SE", label: "Swedish" },
  { code: "nb-NO", label: "Norwegian" },
  { code: "pl-PL", label: "Polish" },
  { code: "ru-RU", label: "Russian" },
  { code: "tr-TR", label: "Turkish" },
  { code: "cs-CZ", label: "Czech" },
  { code: "da-DK", label: "Danish" },
  { code: "fi-FI", label: "Finnish" },
  { code: "hu-HU", label: "Hungarian" },
  { code: "ro-RO", label: "Romanian" },
  { code: "uk-UA", label: "Ukrainian" },
  { code: "el-GR", label: "Greek" },
  { code: "iw-IL", label: "Hebrew" },
  { code: "sk-SK", label: "Slovak" },
  { code: "sl-SI", label: "Slovenian" },
  { code: "bg-BG", label: "Bulgarian" },
  { code: "ca-CA", label: "Catalan" },
  { code: "hr-HR", label: "Croatian" },
  { code: "sr-SR", label: "Serbian" },
];

/** Supported OCR output types for Adobe PDF Services. */
export const OCR_TYPES: ReadonlyArray<{
  readonly value: string;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "SEARCHABLE_IMAGE_EXACT",
    label: "Exact",
    description: "Preserve original image untouched",
  },
  {
    value: "SEARCHABLE_IMAGE",
    label: "Searchable Image",
    description: "May deskew and clean the image",
  },
];

/** Base URL for the Adobe PDF Services REST API. */
export const API_BASE = "https://pdf-services-ue1.adobe.io";

/** URL for obtaining an access token via Adobe IMS (OAuth Server-to-Server). */
export const TOKEN_URL = "https://ims-na1.adobelogin.com/ims/token/v3";

/** Milliseconds to wait between polling attempts for job completion. */
export const POLL_INTERVAL_MS = 3000;

/** Maximum number of polling attempts before timing out. */
export const MAX_POLL_ATTEMPTS = 200;

// ---------------------------------------------------------------------------
// Custom error class
// ---------------------------------------------------------------------------

/** Parameters for constructing an AdobeApiError. */
interface AdobeApiErrorParams {
  /** Technical error message for logging. */
  readonly message: string;
  /** HTTP status code from the failed request, if available. */
  readonly statusCode?: number;
  /** Pipeline step where the error occurred. */
  readonly step: string;
  /** Human-readable message suitable for display to the user. */
  readonly userMessage: string;
}

/**
 * Error class for failures during Adobe PDF Services API communication.
 *
 * Carries structured context about where in the pipeline the failure occurred,
 * the HTTP status code (when available), and a user-friendly message.
 */
export class AdobeApiError extends Error {
  /** HTTP status code from the failed request, if available. */
  readonly statusCode: number | undefined;

  /** Pipeline step where the error occurred (e.g. "authentication", "upload"). */
  readonly step: string;

  /** Human-readable message suitable for display to the user. */
  readonly userMessage: string;

  /**
   * Create an AdobeApiError.
   *
   * @param params - Error construction parameters.
   * @param params.message - Technical error message for logging.
   * @param params.statusCode - HTTP status code, if available.
   * @param params.step - Pipeline step identifier.
   * @param params.userMessage - User-facing error message.
   */
  constructor({ message, statusCode, step, userMessage }: AdobeApiErrorParams) {
    super(message);
    this.name = "AdobeApiError";
    this.statusCode = statusCode;
    this.step = step;
    this.userMessage = userMessage;
  }
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

/** Cached access token, or null if no token is cached. */
let cachedToken: string | null = null;

/** Timestamp (ms since epoch) when the cached token expires. */
let tokenExpiry = 0;

/** Shape of the Adobe token endpoint response. */
interface TokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
}

/**
 * Obtain an access token from the Adobe PDF Services token endpoint.
 *
 * Returns a cached token when one exists and has not expired. Otherwise
 * performs a fresh token request using the provided credentials.
 *
 * @param clientId - Adobe PDF Services client ID.
 * @param clientSecret - Adobe PDF Services client secret.
 * @returns A valid access token string.
 * @throws {AdobeApiError} When authentication fails.
 */
export async function getAccessToken(
  clientId: string,
  clientSecret: string,
): Promise<string> {
  if (cachedToken !== null && tokenExpiry > Date.now()) {
    logDebug("Using cached access token");
    return cachedToken;
  }

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials&scope=openid,AdobeID,DCAPI`,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AdobeApiError({
      message: `Token request failed: ${message}`,
      step: "authentication",
      userMessage:
        "Unable to connect to Adobe authentication service. Check your network connection.",
    });
  }

  if (!response.ok) {
    throw new AdobeApiError({
      message: `Token request returned HTTP ${response.status}: ${response.statusText}`,
      statusCode: response.status,
      step: "authentication",
      userMessage:
        "Authentication failed. Verify your Adobe API credentials in the preferences.",
    });
  }

  let tokenData: TokenResponse;
  try {
    tokenData = (await response.json()) as unknown as TokenResponse;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AdobeApiError({
      message: `Failed to parse token response: ${message}`,
      step: "authentication",
      userMessage:
        "Received an unexpected response from Adobe authentication service.",
    });
  }

  cachedToken = tokenData.access_token;
  tokenExpiry = Date.now() + (tokenData.expires_in - 60) * 1000;
  logDebug("Fresh access token acquired");

  return cachedToken;
}

/**
 * Clear the cached access token, forcing the next call to getAccessToken
 * to request a fresh token.
 */
export function clearCachedToken(): void {
  logDebug("Cached token cleared");
  cachedToken = null;
  tokenExpiry = 0;
}

// ---------------------------------------------------------------------------
// OCR pipeline types
// ---------------------------------------------------------------------------

/** Options controlling the OCR operation. */
export interface OcrOptions {
  /** OCR language locale code (e.g. "en-US"). */
  readonly ocrLang: string;
  /** OCR output type (e.g. "SEARCHABLE_IMAGE" or "SEARCHABLE_IMAGE_EXACT"). */
  readonly ocrType: string;
}

/** Shape of the Adobe asset creation response. */
interface AssetUploadResponse {
  readonly uploadUri: string;
  readonly assetID: string;
}

/** Shape of the Adobe OCR job polling response. */
interface PollResponse {
  readonly status: string;
  readonly asset?: {
    readonly downloadUri: string;
  };
  readonly error?: {
    readonly message?: string;
  };
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Build the standard authorization headers for Adobe PDF Services API calls.
 *
 * @param accessToken - A valid access token.
 * @param clientId - The Adobe API client ID.
 * @returns Headers object with Authorization, x-api-key, and Content-Type.
 */
function authHeaders(
  accessToken: string,
  clientId: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "x-api-key": clientId,
    "Content-Type": "application/json",
  };
}

// ---------------------------------------------------------------------------
// Core pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full OCR pipeline against the Adobe PDF Services REST API.
 *
 * Performs a 6-step flow: request upload URI, upload the PDF, submit the OCR
 * job, poll for completion, download the result, and return it as a Uint8Array.
 *
 * @param pdfData - Raw PDF file contents as a Uint8Array.
 * @param clientId - Adobe PDF Services client ID.
 * @param accessToken - A valid access token obtained from getAccessToken.
 * @param options - OCR language and type options.
 * @param onProgress - Optional callback invoked with status strings at key stages.
 * @returns The OCR-processed PDF as a Uint8Array.
 * @throws {AdobeApiError} When any step of the pipeline fails.
 */
export async function ocrPdf(
  pdfData: Uint8Array,
  clientId: string,
  accessToken: string,
  options: OcrOptions,
  onProgress?: (status: string, elapsedSec?: number) => void,
): Promise<Uint8Array> {
  // Step 1: Request upload URI
  onProgress?.("uploading");
  const { uploadUri, assetID } = await requestUploadUri(clientId, accessToken);
  logDebug("Upload URI obtained");

  // Step 2: Upload PDF
  await uploadPdf(uploadUri, pdfData);
  logDebug(`PDF uploaded (${pdfData.byteLength} bytes)`);

  // Step 3: Submit OCR job
  onProgress?.("processing");
  const pollUrl = await submitOcrJob(clientId, accessToken, assetID, options);
  logDebug("OCR job submitted, polling for completion");

  // Step 4: Poll for completion
  const downloadUri = await pollForCompletion(
    clientId,
    accessToken,
    pollUrl,
    onProgress,
  );
  logDebug("OCR job complete, downloading result");

  // Step 5: Download result
  onProgress?.("downloading");
  return downloadResult(downloadUri);
}

// ---------------------------------------------------------------------------
// Pipeline steps
// ---------------------------------------------------------------------------

/**
 * Step 1: Request an upload URI from Adobe PDF Services.
 *
 * @param clientId - Adobe PDF Services client ID.
 * @param accessToken - A valid access token.
 * @returns The upload URI and asset ID.
 * @throws {AdobeApiError} When the request fails or returns a non-OK status.
 */
async function requestUploadUri(
  clientId: string,
  accessToken: string,
): Promise<AssetUploadResponse> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/assets`, {
      method: "POST",
      headers: authHeaders(accessToken, clientId),
      body: JSON.stringify({ mediaType: "application/pdf" }),
    });
  } catch (error: unknown) {
    throw wrapNetworkError(
      error,
      "upload-request",
      "Unable to request upload URI from Adobe.",
    );
  }

  if (response.status === 401) {
    throw new AdobeApiError({
      message: `Upload URI request returned 401 Unauthorized`,
      statusCode: 401,
      step: "upload-request",
      userMessage:
        "Authentication has expired. Please try again to re-authenticate.",
    });
  }

  if (!response.ok) {
    throw new AdobeApiError({
      message: `Upload URI request returned HTTP ${response.status}: ${response.statusText}`,
      statusCode: response.status,
      step: "upload-request",
      userMessage: `Adobe rejected the upload request (HTTP ${response.status}).`,
    });
  }

  try {
    return (await response.json()) as unknown as AssetUploadResponse;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AdobeApiError({
      message: `Failed to parse upload URI response: ${message}`,
      step: "upload-request",
      userMessage:
        "Received an unexpected response when requesting upload URI.",
    });
  }
}

/**
 * Step 2: Upload the raw PDF bytes to the provided upload URI.
 *
 * @param uploadUri - The pre-signed upload URI from step 1.
 * @param pdfData - Raw PDF file contents.
 * @throws {AdobeApiError} When the upload fails or returns a non-OK status.
 */
async function uploadPdf(
  uploadUri: string,
  pdfData: Uint8Array,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(uploadUri, {
      method: "PUT",
      headers: {
        "Content-Type": "application/pdf",
      },
      body: pdfData,
    });
  } catch (error: unknown) {
    throw wrapNetworkError(error, "upload", "Unable to upload PDF to Adobe.");
  }

  if (!response.ok) {
    throw new AdobeApiError({
      message: `PDF upload returned HTTP ${response.status}: ${response.statusText}`,
      statusCode: response.status,
      step: "upload",
      userMessage: `PDF upload failed (HTTP ${response.status}).`,
    });
  }
}

/**
 * Step 3: Submit an OCR job for the uploaded asset.
 *
 * @param clientId - Adobe PDF Services client ID.
 * @param accessToken - A valid access token.
 * @param assetID - The asset ID from step 1.
 * @param options - OCR language and type options.
 * @returns The polling URL from the Location response header.
 * @throws {AdobeApiError} When job submission fails.
 */
async function submitOcrJob(
  clientId: string,
  accessToken: string,
  assetID: string,
  options: OcrOptions,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/operation/ocr`, {
      method: "POST",
      headers: authHeaders(accessToken, clientId),
      body: JSON.stringify({
        assetID,
        ocrLang: options.ocrLang,
      }),
    });
  } catch (error: unknown) {
    throw wrapNetworkError(
      error,
      "ocr-submit",
      "Unable to submit OCR job to Adobe.",
    );
  }

  if (response.status === 401) {
    throw new AdobeApiError({
      message: `OCR submit returned 401 Unauthorized`,
      statusCode: 401,
      step: "ocr-submit",
      userMessage:
        "Authentication has expired. Please try again to re-authenticate.",
    });
  }

  if (response.status !== 201) {
    let responseBody = "";
    try {
      responseBody = await response.text();
    } catch {
      // ignore
    }
    logDebug(
      `OCR submit failed (${response.status}): ${responseBody}`,
    );
    throw new AdobeApiError({
      message: `OCR submit returned HTTP ${response.status}: ${response.statusText}`,
      statusCode: response.status,
      step: "ocr-submit",
      userMessage: `Adobe rejected the OCR request (HTTP ${response.status}).`,
    });
  }

  const location = response.headers.get("Location");
  if (location === null) {
    throw new AdobeApiError({
      message: "OCR submit response missing Location header",
      statusCode: response.status,
      step: "ocr-submit",
      userMessage:
        "Adobe returned an unexpected response after submitting the OCR job.",
    });
  }

  return location;
}

/**
 * Step 4: Poll the job status URL until the OCR job completes or fails.
 *
 * @param clientId - Adobe PDF Services client ID.
 * @param accessToken - A valid access token.
 * @param pollUrl - The polling URL from the Location header in step 3.
 * @param onProgress - Optional callback invoked each poll with status and elapsed seconds.
 * @returns The download URI for the processed PDF.
 * @throws {AdobeApiError} When polling fails, the job fails, or polling times out.
 */
async function pollForCompletion(
  clientId: string,
  accessToken: string,
  pollUrl: string,
  onProgress?: (status: string, elapsedSec?: number) => void,
): Promise<string> {
  const startTime = Date.now();
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    onProgress?.("processing", elapsedSec);
    logTrace(`Poll attempt ${attempt + 1}/${MAX_POLL_ATTEMPTS}`);
    let response: Response;
    try {
      response = await fetch(pollUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "x-api-key": clientId,
        },
      });
    } catch (error: unknown) {
      throw wrapNetworkError(
        error,
        "ocr-processing",
        "Lost connection while waiting for OCR results.",
      );
    }

    if (response.status === 401) {
      throw new AdobeApiError({
        message: `Poll request returned 401 Unauthorized`,
        statusCode: 401,
        step: "ocr-processing",
        userMessage:
          "Authentication has expired. Please try again to re-authenticate.",
      });
    }

    if (!response.ok) {
      throw new AdobeApiError({
        message: `Poll request returned HTTP ${response.status}: ${response.statusText}`,
        statusCode: response.status,
        step: "ocr-processing",
        userMessage: `Adobe returned an error while checking OCR status (HTTP ${response.status}).`,
      });
    }

    let pollData: PollResponse;
    try {
      pollData = (await response.json()) as unknown as PollResponse;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AdobeApiError({
        message: `Failed to parse poll response: ${message}`,
        step: "ocr-processing",
        userMessage:
          "Received an unexpected response while checking OCR status.",
      });
    }

    if (pollData.status === "done") {
      const downloadUri = pollData.asset?.downloadUri;
      if (downloadUri === undefined) {
        throw new AdobeApiError({
          message: "Poll response status is 'done' but no downloadUri found",
          step: "ocr-processing",
          userMessage:
            "OCR completed but the download link was missing from the response.",
        });
      }
      logDebug(`OCR job finished after ${attempt + 1} poll(s)`);
      return downloadUri;
    }

    if (pollData.status === "failed") {
      const errorDetail = pollData.error?.message ?? "unknown error";
      throw new AdobeApiError({
        message: `OCR job failed: ${errorDetail}`,
        step: "ocr-processing",
        userMessage: `OCR processing failed: ${errorDetail}`,
      });
    }

    // Job still in progress -- wait before polling again
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new AdobeApiError({
    message: `OCR job did not complete within ${MAX_POLL_ATTEMPTS} polling attempts`,
    step: "ocr-timeout",
    userMessage:
      "OCR processing timed out. The PDF may be too large or Adobe services may be busy.",
  });
}

/**
 * Step 5: Download the OCR-processed PDF from the given URI.
 *
 * @param downloadUri - The download URI from the completed job response.
 * @returns The processed PDF as a Uint8Array.
 * @throws {AdobeApiError} When the download fails.
 */
async function downloadResult(downloadUri: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(downloadUri, {
      method: "GET",
    });
  } catch (error: unknown) {
    throw wrapNetworkError(
      error,
      "download",
      "Unable to download the processed PDF.",
    );
  }

  if (!response.ok) {
    throw new AdobeApiError({
      message: `Download returned HTTP ${response.status}: ${response.statusText}`,
      statusCode: response.status,
      step: "download",
      userMessage: `Failed to download the processed PDF (HTTP ${response.status}).`,
    });
  }

  try {
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AdobeApiError({
      message: `Failed to read download response: ${message}`,
      step: "download",
      userMessage: "Failed to read the downloaded PDF data.",
    });
  }
}

// ---------------------------------------------------------------------------
// Error wrapping utility
// ---------------------------------------------------------------------------

/**
 * Wrap a network-level error (e.g. fetch failure) into an AdobeApiError.
 * If the error is already an AdobeApiError, re-throws it as-is.
 *
 * @param error - The caught error value.
 * @param step - Pipeline step identifier for the new AdobeApiError.
 * @param userMessage - User-facing message for the new AdobeApiError.
 * @returns Never returns -- always throws.
 * @throws {AdobeApiError} Always.
 */
function wrapNetworkError(
  error: unknown,
  step: string,
  userMessage: string,
): never {
  if (error instanceof AdobeApiError) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new AdobeApiError({
    message: `Network error at ${step}: ${message}`,
    step,
    userMessage,
  });
}

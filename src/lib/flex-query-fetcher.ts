/**
 * IBKR Flex Query Web Service API Client
 */

import { FLEX_QUERY_INITIAL_DELAY_MS, FLEX_QUERY_MAX_DELAY_MS, FLEX_QUERY_ABSOLUTE_TIMEOUT_MS, MIN_TOKEN_LENGTH, MAX_TOKEN_LENGTH, MAX_QUERY_ID_LENGTH } from "./constants";

export interface FlexQueryConfig {
  token: string;
  queryId: string;
}

export function validateFlexToken(token: string): { valid: boolean; error?: string } {
  if (!token || typeof token !== "string") {
    return { valid: false, error: "Token is required" };
  }
  const trimmed = token.trim();
  if (trimmed.length < MIN_TOKEN_LENGTH) {
    return { valid: false, error: `Token appears too short (minimum ${MIN_TOKEN_LENGTH} characters)` };
  }
  if (trimmed.length > MAX_TOKEN_LENGTH) {
    return { valid: false, error: `Token appears too long (maximum ${MAX_TOKEN_LENGTH} characters)` };
  }
  if (!/^[a-zA-Z0-9]+$/.test(trimmed)) {
    return { valid: false, error: "Token should contain only alphanumeric characters" };
  }
  return { valid: true };
}

export function validateQueryId(queryId: string): { valid: boolean; error?: string } {
  if (!queryId || typeof queryId !== "string") {
    return { valid: false, error: "Query ID is required" };
  }
  const trimmed = queryId.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { valid: false, error: "Query ID should be numeric" };
  }
  if (trimmed.length > MAX_QUERY_ID_LENGTH) {
    return { valid: false, error: `Query ID appears too long (maximum ${MAX_QUERY_ID_LENGTH} characters)` };
  }
  return { valid: true };
}

export interface FlexQueryRequestResult {
  success: boolean;
  referenceCode?: string;
  url?: string;
  error?: string;
  errorCode?: number;
}

export interface FlexQueryStatementResult {
  success: boolean;
  csv?: string;
  error?: string;
  errorCode?: number;
}

export interface FlexQueryResult {
  success: boolean;
  csv?: string;
  error?: string;
  errorCode?: number;
}

/**
 * SDK 3.x network API interface
 */
export interface NetworkClient {
  request(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{
    status: number;
    statusText?: string;
    status_text?: string;
    headers: Record<string, string>;
    body: string;
    ok: boolean;
  }>;
}

export const FLEX_ERROR_CODES: Record<number, string> = {
  1001: "Statement generation unavailable; retry shortly",
  1003: "Statement generation in progress; wait and try again",
  1004: "Statement ready for download",
  1005: "Statement failed to generate; try again",
  1006: "Statement is too large; try with a smaller date range",
  1007: "Statement request invalid",
  1010: "Server error; retry later",
  1011: "Statement ID not found",
  1012: "Token has expired",
  1013: "IP address restriction violated",
  1014: "Query is invalid",
  1015: "Token is invalid",
  1016: "Token missing permissions",
  1017: "Statement date range invalid",
  1018: "Rate limit exceeded",
  1019: "Statement pending generation",
};

const FLEX_API_BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";
const USER_AGENT = "Wealthfolio/1.0";

let networkClient: NetworkClient | null = null;

export function setHttpClient(client: NetworkClient): void {
  networkClient = client;
}

function getHttpClient(): NetworkClient {
  if (!networkClient) {
    throw new Error(
      "Network client not set. Call setHttpClient(ctx.api.network) before using Flex Query functions."
    );
  }
  return networkClient;
}

function sanitizeXmlString(value: string | undefined, maxLength: number = 500): string | undefined {
  if (!value) return undefined;
  let sanitized = value.replace(/<[^>]*>/g, "");
  sanitized = sanitized
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength) + "...";
  }
  return sanitized.trim();
}

function isValidIBKRUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname.endsWith(".interactivebrokers.com") ||
        parsed.hostname.endsWith(".ibkr.com"))
    );
  } catch {
    return false;
  }
}

function parseFlexResponse(xml: string): {
  status: string;
  referenceCode?: string;
  url?: string;
  errorCode?: number;
  errorMessage?: string;
} {
  const statusMatch = /<Status>([^<]+)<\/Status>/i.exec(xml);
  const status = sanitizeXmlString(statusMatch?.[1]) || "";
  const refMatch = /<ReferenceCode>([^<]+)<\/ReferenceCode>/i.exec(xml);
  const referenceCode = refMatch?.[1]?.replace(/[^a-zA-Z0-9]/g, "") || undefined;
  const urlMatch = /<Url>([^<]+)<\/Url>/i.exec(xml);
  const extractedUrl = urlMatch?.[1];
  const url = isValidIBKRUrl(extractedUrl) ? extractedUrl : undefined;
  const errorCodeMatch = /<ErrorCode>(\d+)<\/ErrorCode>/i.exec(xml);
  const errorCode = errorCodeMatch ? parseInt(errorCodeMatch[1], 10) : undefined;
  const errorMsgMatch = /<ErrorMessage>([^<]+)<\/ErrorMessage>/i.exec(xml);
  const errorMessage = sanitizeXmlString(errorMsgMatch?.[1], 200);
  return { status, referenceCode, url, errorCode, errorMessage };
}

export async function sendFlexRequest(config: FlexQueryConfig): Promise<FlexQueryRequestResult> {
  const url = `${FLEX_API_BASE}/SendRequest?t=${encodeURIComponent(config.token)}&q=${encodeURIComponent(config.queryId)}&v=3`;

  try {
    const client = getHttpClient();
    const response = await client.request({
      url,
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
    });

    if (response.status < 200 || response.status >= 300) {
      return {
        success: false,
        error: `HTTP error: ${response.status} ${response.statusText ?? response.status_text ?? ""}`,
      };
    }

    const xml = response.body;
    const parsed = parseFlexResponse(xml);

    if (parsed.status === "Success" && parsed.referenceCode) {
      return { success: true, referenceCode: parsed.referenceCode, url: parsed.url };
    }

    const errorMessage =
      parsed.errorMessage ||
      (parsed.errorCode && FLEX_ERROR_CODES[parsed.errorCode]) ||
      "Unknown error from IBKR";

    return { success: false, error: errorMessage, errorCode: parsed.errorCode };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { success: false, error: `Network error: ${message}` };
  }
}

export async function getFlexStatement(
  config: FlexQueryConfig,
  referenceCode: string
): Promise<FlexQueryStatementResult> {
  const url = `${FLEX_API_BASE}/GetStatement?t=${encodeURIComponent(config.token)}&q=${encodeURIComponent(referenceCode)}&v=3`;

  try {
    const client = getHttpClient();
    const response = await client.request({
      url,
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
    });

    if (response.status < 200 || response.status >= 300) {
      return {
        success: false,
        error: `HTTP error: ${response.status} ${response.statusText ?? response.status_text ?? ""}`,
      };
    }

    const responseBody = response.body;

    if (responseBody.includes("<Status>") && !responseBody.includes("<FlexQueryResponse>")) {
      const parsed = parseFlexResponse(responseBody);
      if (parsed.errorCode === 1003 || parsed.errorCode === 1019) {
        return { success: false, error: "Statement generation in progress", errorCode: parsed.errorCode };
      }
      const errorMessage =
        parsed.errorMessage ||
        (parsed.errorCode && FLEX_ERROR_CODES[parsed.errorCode]) ||
        "Unknown error from IBKR";
      return { success: false, error: errorMessage, errorCode: parsed.errorCode };
    }

    return { success: true, csv: responseBody };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { success: false, error: `Network error: ${message}` };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchFlexQuery(
  config: FlexQueryConfig,
  options: {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    absoluteTimeoutMs?: number;
    onProgress?: (message: string) => void;
  } = {}
): Promise<FlexQueryResult> {
  const {
    maxRetries = 10,
    initialDelayMs = FLEX_QUERY_INITIAL_DELAY_MS,
    maxDelayMs = FLEX_QUERY_MAX_DELAY_MS,
    absoluteTimeoutMs = FLEX_QUERY_ABSOLUTE_TIMEOUT_MS,
    onProgress,
  } = options;

  const startTime = Date.now();

  onProgress?.("Sending Flex Query request...");
  const requestResult = await sendFlexRequest(config);

  if (!requestResult.success || !requestResult.referenceCode) {
    return { success: false, error: requestResult.error || "Failed to get reference code", errorCode: requestResult.errorCode };
  }

  onProgress?.(`Request accepted. Reference: ${requestResult.referenceCode}`);

  let currentDelay = initialDelayMs;
  let retries = 0;

  while (retries < maxRetries) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= absoluteTimeoutMs) {
      onProgress?.("Operation timed out");
      return { success: false, error: `Absolute timeout exceeded (${Math.round(absoluteTimeoutMs / 1000)}s). IBKR may be experiencing delays.` };
    }

    const remainingTime = absoluteTimeoutMs - elapsed;
    onProgress?.(`Waiting for statement (attempt ${retries + 1}/${maxRetries}, ${Math.round(remainingTime / 1000)}s remaining)...`);
    await delay(currentDelay);

    const statementResult = await getFlexStatement(config, requestResult.referenceCode);

    if (statementResult.success && statementResult.csv) {
      onProgress?.("Statement retrieved successfully");
      return { success: true, csv: statementResult.csv };
    }

    if (
      statementResult.errorCode === 1003 ||
      statementResult.errorCode === 1019 ||
      statementResult.errorCode === 1018 ||
      statementResult.error === "Statement generation in progress"
    ) {
      retries++;
      currentDelay = Math.min(currentDelay * 1.5, maxDelayMs);
      continue;
    }

    return { success: false, error: statementResult.error, errorCode: statementResult.errorCode };
  }

  return { success: false, error: "Max retries exceeded waiting for statement generation" };
}

export async function testFlexConnection(
  config: FlexQueryConfig
): Promise<{ success: boolean; message: string }> {
  const result = await sendFlexRequest(config);

  if (result.success) {
    return { success: true, message: "Connection successful. Credentials are valid." };
  }

  if (result.errorCode === 1015) return { success: false, message: "Invalid token. Please check your Flex token." };
  if (result.errorCode === 1012) return { success: false, message: "Token has expired. Please generate a new token in IBKR Client Portal." };
  if (result.errorCode === 1014) return { success: false, message: "Invalid Query ID. Please check your Flex Query ID." };
  if (result.errorCode === 1013) return { success: false, message: "IP address not allowed. Please update IP restrictions in IBKR Client Portal." };

  return { success: false, message: result.error || "Connection failed" };
}
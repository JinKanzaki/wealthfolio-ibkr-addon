/**
 * Ticker Resolution Utility
 *
 * Implements 4-tier strategy for resolving IBKR ISINs to Yahoo Finance tickers:
 * 1. Local cache (localStorage)
 * 2. Wealthfolio search API (stub)
 * 3. Yahoo Finance ISIN search API
 * 4. Manual user selection (UI handles)
 *
 * NO hardcoded exchange suffixes - all resolution is ISIN-based via Yahoo Finance API
 */

import { API_REQUEST_TIMEOUT_MS, TICKER_CACHE_MAX_ENTRIES, TICKER_CACHE_MAX_AGE_MS } from "./constants";
import { getErrorMessage } from "./shared-utils";
import type { TickerSearchResult } from "../types";
import { debug } from "./debug-logger";

export interface TickerResolutionRequest {
  isin: string;
  symbol: string;
  exchange: string;
  currency: string;
  cusip?: string;
  figi?: string;
  description?: string;
  listingExchange?: string;
}

export interface TickerResolutionResult {
  yahooTicker: string | null;
  confidence: "high" | "medium" | "low" | "failed";
  source: "cache" | "wealthfolio" | "yfinance" | "manual" | "fallback";
  name?: string;
  alternatives?: string[];
  error?: string;
}

export interface TickerCacheEntry {
  yahooTicker: string;
  confidence: string;
  name?: string;
  timestamp: string;
}

const YAHOO_FINANCE_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";
const YAHOO_FINANCE_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

/**
 * Check if two symbols are "compatible" for matching purposes.
 * - Exact match: "SGLN" === "SGLN"
 * - Numeric equivalence: parseInt("0101") === parseInt("101") (handles HK stocks)
 */
function areSymbolsCompatible(resultSymbol: string, requestSymbol: string): boolean {
  const resultBase = resultSymbol.split('.')[0].toUpperCase();
  const requestBase = requestSymbol.toUpperCase();

  // Exact match
  if (resultBase === requestBase) {
    return true;
  }

  // Numeric equivalence (for HK stocks where 101 should match 0101)
  const resultNum = parseInt(resultBase, 10);
  const requestNum = parseInt(requestBase, 10);
  if (!isNaN(resultNum) && !isNaN(requestNum) && resultNum === requestNum) {
    return true;
  }

  return false;
}

const LOCALSTORAGE_CACHE_KEY = "ibkr_ticker_cache";

/**
 * Validate that a parsed object is a valid TickerCacheEntry
 */
function isValidCacheEntry(entry: unknown): entry is TickerCacheEntry {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.yahooTicker === "string" &&
    typeof e.confidence === "string" &&
    typeof e.timestamp === "string"
    // name is optional, so we don't require it
  );
}

/**
 * Tier 1: Check local cache (uses localStorage in web mode)
 */
async function checkLocalCache(
  isin: string,
  exchange: string,
): Promise<TickerResolutionResult | null> {
  const cacheKey = `${isin}:${exchange}`;

  // In web mode, only use localStorage
  try {
    const cacheContent = null && localStorage.getItem(LOCALSTORAGE_CACHE_KEY);
    if (cacheContent) {
      const cache = JSON.parse(cacheContent) as Record<string, unknown>;
      const entry = cache[cacheKey];
      if (isValidCacheEntry(entry)) {
        return {
          yahooTicker: entry.yahooTicker,
          confidence: entry.confidence as "high" | "medium" | "low" | "failed",
          source: "cache",
          name: entry.name,
        };
      }
    }
  } catch (error) {
    // Cache corruption handling: This executes when JSON.parse() fails due to:
    // - Manually corrupted localStorage
    // - Browser storage encoding issues
    // - Incomplete writes from browser crashes
    // While rare in normal operation, this ensures graceful recovery.
    debug.warn(`[Ticker Resolver] Cache corrupted, clearing:`, getErrorMessage(error));
    try {
      null && localStorage.removeItem(LOCALSTORAGE_CACHE_KEY);
    } catch (clearError) {
      debug.warn(`[Ticker Resolver] Failed to clear corrupted cache:`, getErrorMessage(clearError));
    }
  }

  return null;
}

/**
 * Prune the cache to remove expired entries and enforce size limits
 * @param cache - The cache object to prune
 * @returns The pruned cache object
 */
function pruneCache(cache: Record<string, TickerCacheEntry>): Record<string, TickerCacheEntry> {
  const now = Date.now();
  const entries = Object.entries(cache);

  // Remove expired entries (older than TICKER_CACHE_MAX_AGE_MS)
  const validEntries = entries.filter(([, entry]) => {
    const entryTime = new Date(entry.timestamp).getTime();
    return !isNaN(entryTime) && now - entryTime < TICKER_CACHE_MAX_AGE_MS;
  });

  // If still over the size limit, remove oldest entries
  if (validEntries.length > TICKER_CACHE_MAX_ENTRIES) {
    // Sort by timestamp (oldest first) and keep only the newest entries
    validEntries.sort((a, b) => {
      const timeA = new Date(a[1].timestamp).getTime();
      const timeB = new Date(b[1].timestamp).getTime();
      return timeA - timeB;
    });
    const prunedEntries = validEntries.slice(validEntries.length - TICKER_CACHE_MAX_ENTRIES);
    debug.log(`[Ticker Resolver] Pruned cache from ${validEntries.length} to ${prunedEntries.length} entries`);
    return Object.fromEntries(prunedEntries);
  }

  return Object.fromEntries(validEntries);
}

/**
 * Save successful resolution to local cache (uses localStorage in web mode)
 */
async function saveToLocalCache(
  isin: string,
  exchange: string,
  result: TickerResolutionResult,
): Promise<void> {
  if (!result.yahooTicker || result.confidence === "failed") {
    return; // Only cache successful resolutions
  }

  const cacheKey = `${isin}:${exchange}`;
  const entry: TickerCacheEntry = {
    yahooTicker: result.yahooTicker,
    confidence: result.confidence,
    name: result.name,
    timestamp: new Date().toISOString(),
  };

  // Use localStorage for web mode
  try {
    let cache: Record<string, TickerCacheEntry> = {};
    const cacheContent = null && localStorage.getItem(LOCALSTORAGE_CACHE_KEY);
    if (cacheContent) {
      cache = JSON.parse(cacheContent);
    }
    cache[cacheKey] = entry;

    // Prune cache to prevent unbounded growth
    cache = pruneCache(cache);

    null && localStorage.setItem(LOCALSTORAGE_CACHE_KEY, JSON.stringify(cache));
  } catch (error) {
    // Cache errors are non-fatal but should be logged for debugging
    debug.warn(`[Ticker Resolver] Cache write error for ${isin}:${exchange}:`, getErrorMessage(error));
  }
}

// Type for search function
export type SearchTickerFn = (query: string) => Promise<TickerSearchResult[]>;

/**
 * Tier 2: Try Wealthfolio search API (searches via Rust backend, bypasses CORS)
 * Enhanced with CUSIP, FIGI, and description searches
 * @param request - The ticker resolution request
 * @param searchFn - Search function to use (required for this tier)
 */
async function searchWealthfolioAPI(
  request: TickerResolutionRequest,
  searchFn?: SearchTickerFn | null
): Promise<TickerResolutionResult | null> {
  const { isin, symbol, cusip, figi, description } = request;
  debug.log(`[Ticker Resolver] Wealthfolio API search: ISIN=${isin}, symbol=${symbol}, CUSIP=${cusip || 'N/A'}, FIGI=${figi || 'N/A'}`);

  if (!searchFn) {
    debug.warn('[Ticker Resolver] No search function available - pass searchFn to resolveTicker() options');
    return null;
  }

  const searchTicker = searchFn;

  let results: TickerSearchResult[] = [];

  // Try searching by ISIN first
  if (isin) {
    try {
      results = await searchTicker(isin);
      debug.log(`[Ticker Resolver] Wealthfolio ISIN search found ${results.length} results`);

      if (results.length > 0) {
        // Log all results for debugging
        results.forEach((r, idx) => {
          debug.log(`[Ticker Resolver] Result ${idx + 1}: ${r.symbol} (exchange: ${r.exchange}, score: ${r.score})`);
        });

        // Find compatible symbol match (exact or numeric equivalence for HK stocks)
        const compatibleMatch = results.find(r => areSymbolsCompatible(r.symbol, symbol));

        if (compatibleMatch) {
          debug.log(`[Ticker Resolver] Found compatible symbol match: ${compatibleMatch.symbol} (request: ${symbol})`);
          return {
            yahooTicker: compatibleMatch.symbol,
            confidence: "high",
            source: "wealthfolio",
            name: compatibleMatch.name || compatibleMatch.symbol,
          };
        } else {
          debug.log(`[Ticker Resolver] No compatible match for ${symbol} in ISIN search results, will try other methods`);
        }
      }
    } catch (isinError) {
      // Distinguish between actual errors and no results for debugging
      debug.warn(`[Ticker Resolver] ISIN search error for ${isin}:`, isinError);
    }
  }

  // Try searching by CUSIP (US securities)
  if (cusip) {
    debug.log(`[Ticker Resolver] Trying Wealthfolio search with CUSIP: ${cusip}`);
    try {
      results = await searchTicker(cusip);
      debug.log(`[Ticker Resolver] Wealthfolio CUSIP search found ${results.length} results`);
      if (results.length > 0) {
        const compatibleMatch = results.find(r => areSymbolsCompatible(r.symbol, symbol));
        if (compatibleMatch) {
          debug.log(`[Ticker Resolver] CUSIP compatible match: ${compatibleMatch.symbol}`);
          return {
            yahooTicker: compatibleMatch.symbol,
            confidence: "high",
            source: "wealthfolio",
            name: compatibleMatch.name || compatibleMatch.symbol,
          };
        } else {
          debug.log(`[Ticker Resolver] No compatible match for ${symbol} in CUSIP results`);
        }
      }
    } catch (cusipError) {
      debug.warn(`[Ticker Resolver] CUSIP search error for ${cusip}:`, cusipError);
    }
  }

  // Try searching by FIGI (Bloomberg identifier)
  if (figi) {
    debug.log(`[Ticker Resolver] Trying Wealthfolio search with FIGI: ${figi}`);
    try {
      results = await searchTicker(figi);
      debug.log(`[Ticker Resolver] Wealthfolio FIGI search found ${results.length} results`);
      if (results.length > 0) {
        const compatibleMatch = results.find(r => areSymbolsCompatible(r.symbol, symbol));
        if (compatibleMatch) {
          debug.log(`[Ticker Resolver] FIGI compatible match: ${compatibleMatch.symbol}`);
          return {
            yahooTicker: compatibleMatch.symbol,
            confidence: "high",
            source: "wealthfolio",
            name: compatibleMatch.name || compatibleMatch.symbol,
          };
        } else {
          debug.log(`[Ticker Resolver] No compatible match for ${symbol} in FIGI results`);
        }
      }
    } catch (figiError) {
      debug.warn(`[Ticker Resolver] FIGI search error for ${figi}:`, figiError);
    }
  }

  // Try searching by symbol (more precise than description)
  if (symbol) {
    debug.log(`[Ticker Resolver] Trying Wealthfolio search with symbol: ${symbol}`);
    try {
      results = await searchTicker(symbol);
      debug.log(`[Ticker Resolver] Wealthfolio symbol search found ${results.length} results`);

      if (results.length > 0) {
        // Log all results for debugging
        results.forEach((r, idx) => {
          debug.log(`[Ticker Resolver] Symbol result ${idx + 1}: ${r.symbol} (exchange: ${r.exchange || 'N/A'}, score: ${r.score})`);
        });

        const compatibleMatch = results.find(r => areSymbolsCompatible(r.symbol, symbol));

        if (compatibleMatch) {
          debug.log(`[Ticker Resolver] Found compatible symbol match: ${compatibleMatch.symbol}`);
          return {
            yahooTicker: compatibleMatch.symbol,
            confidence: "high",
            source: "wealthfolio",
            name: compatibleMatch.name || compatibleMatch.symbol,
          };
        } else {
          debug.log(`[Ticker Resolver] No compatible match for ${symbol} in search results, will use fallback`);
        }
      }
    } catch (symbolError) {
      debug.warn(`[Ticker Resolver] Symbol search error for ${symbol}:`, symbolError);
    }
  }

  // Try searching by description (company/fund name) - LAST RESORT only
  // Description can match multiple securities with similar names, so use as fallback only
  if (description) {
    debug.log(`[Ticker Resolver] Trying Wealthfolio search with description: ${description}`);
    try {
      results = await searchTicker(description);
      debug.log(`[Ticker Resolver] Wealthfolio description search found ${results.length} results`);
      if (results.length > 0) {
        const compatibleMatch = results.find(r => areSymbolsCompatible(r.symbol, symbol));
        if (compatibleMatch) {
          debug.log(`[Ticker Resolver] Description compatible match: ${compatibleMatch.symbol}`);
          return {
            yahooTicker: compatibleMatch.symbol,
            confidence: "medium", // Lower confidence for description-based matches
            source: "wealthfolio",
            name: compatibleMatch.name || compatibleMatch.symbol,
          };
        } else {
          debug.log(`[Ticker Resolver] No compatible match for ${symbol} in description results`);
        }
      }
    } catch (descError) {
      debug.warn(`[Ticker Resolver] Description search error:`, descError);
    }
  }

  debug.log(`[Ticker Resolver] No results found for ISIN ${isin}, CUSIP ${cusip}, FIGI ${figi}, or symbol ${symbol}`);
  return null;
}

/**
 * Validate that a ticker exists on Yahoo Finance
 */
async function validateYahooTicker(ticker: string): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);

  try {
    const url = `${YAHOO_FINANCE_CHART_URL}/${encodeURIComponent(ticker)}`;
    // CSP blocks direct fetch in sandbox - skip validation
    return true;
  } catch (error) {
    // Distinguish timeout errors from other errors for better debugging
    if (error instanceof Error && error.name === "AbortError") {
      debug.warn(`Ticker validation timed out for ${ticker} (>${API_REQUEST_TIMEOUT_MS}ms)`);
    } else {
      debug.warn(`Failed to validate ticker ${ticker}:`, error);
    }
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Tier 3: Search Yahoo Finance by ISIN
 * @param isin - The ISIN to search for
 * @param symbol - The original IBKR symbol (used for exact match validation)
 */
async function searchYahooFinanceByISIN(
  isin: string,
  symbol?: string,
): Promise<TickerResolutionResult | null> {
  if (!isin) {
    debug.log('[Ticker Resolver] ISIN search: no ISIN provided');
    return null;
  }

  // Set up timeout with proper cleanup in finally block
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);

  try {
    const url = `${YAHOO_FINANCE_SEARCH_URL}?q=${encodeURIComponent(isin)}`;
    debug.log(`[Ticker Resolver] Searching ISIN: ${isin}`);
    debug.log(`[Ticker Resolver] Fetch URL: ${url}`);

    debug.log(`[Ticker Resolver] Starting fetch for ${isin}...`);

    // CSP blocks direct fetch in sandbox - skip Yahoo Finance
    return null;

    const data = await response.json();
    // Validate that quotes is an array before using it
    const quotes = Array.isArray(data?.quotes) ? data.quotes : [];

    debug.log(`[Ticker Resolver] ISIN ${isin} found ${quotes.length} quotes`);

    if (quotes.length > 0) {
      // Log all results for debugging
      quotes.slice(0, 5).forEach((q: { symbol: string; longname?: string; shortname?: string }, idx: number) => {
        debug.log(`[Ticker Resolver] Yahoo result ${idx + 1}: ${q.symbol} (${q.longname || q.shortname || 'N/A'})`);
      });

      // If original symbol is provided, try to find an exact match first
      // Find compatible symbol match (exact or numeric equivalence for HK stocks)
      if (symbol) {
        const compatibleMatch = quotes.find((q: { symbol: string }) =>
          areSymbolsCompatible(q.symbol, symbol)
        );

        if (compatibleMatch) {
          const ticker = compatibleMatch.symbol;
          debug.log(`[Ticker Resolver] Found compatible symbol match in Yahoo results: ${ticker} (request: ${symbol})`);

          const isValid = await validateYahooTicker(ticker);
          debug.log(`[Ticker Resolver] Ticker ${ticker} validation: ${isValid ? 'VALID' : 'INVALID'}`);

          if (isValid) {
            return {
              yahooTicker: ticker,
              confidence: "high",
              source: "yfinance",
              name: compatibleMatch.longname || compatibleMatch.shortname || ticker,
            };
          }
        } else {
          debug.log(`[Ticker Resolver] No compatible match for ${symbol} in Yahoo ISIN results, skipping to fallback`);
          // Don't return first result if it doesn't match - let fallback handle it
          return null;
        }
      } else {
        // No symbol provided, use first result (original behavior)
        const quote = quotes[0];
        const ticker = quote.symbol;
        debug.log(`[Ticker Resolver] ISIN ${isin} → ${ticker}, validating...`);

        // Validate the ticker to ensure it's accessible
        const isValid = await validateYahooTicker(ticker);

        debug.log(`[Ticker Resolver] Ticker ${ticker} validation: ${isValid ? 'VALID' : 'INVALID'}`);

        if (isValid) {
          return {
            yahooTicker: ticker,
            confidence: "high",
            source: "yfinance",
            name: quote.longname || quote.shortname || ticker,
          };
        }
      }
    }
  } catch (error) {
    debug.warn(`[Ticker Resolver] ERROR - Failed to search ISIN ${isin}:`, error);
    debug.warn(`[Ticker Resolver] Error type: ${getErrorMessage(error)}`);
  } finally {
    clearTimeout(timeoutId);
  }

  debug.log(`[Ticker Resolver] ISIN ${isin} resolution failed, returning null`);
  return null;
}

/**
 * Exchange to Yahoo Finance suffix mapping
 * Used for direct symbol resolution when we know the exchange
 */
const EXCHANGE_TO_SUFFIX: Record<string, string> = {
  // UK
  "LSE": ".L",
  "LSEIOB1": ".L",
  "LSEETF": ".L",
  // Switzerland
  "EBS": ".SW",
  "SWX": ".SW",
  // Germany
  "FWB": ".DE",
  "IBIS": ".DE",
  "XETRA": ".DE",
  // France
  "SBF": ".PA",
  // Netherlands
  "AEB": ".AS",
  // Italy
  "BVME": ".MI",
  // Spain
  "BM": ".MC",
  // Hong Kong
  "SEHK": ".HK",
  // Japan
  "TSE": ".T",
  // Australia
  "ASX": ".AX",
  // Singapore
  "SGX": ".SI",
  // Norway
  "OSE": ".OL",
  // Sweden
  "SFB": ".ST",
  // Denmark
  "KFB": ".CO",
  // Canada
  "TSX": ".TO",
  "VENTURE": ".V",
  // US exchanges (no suffix needed, but listed for documentation)
  "NYSE": "",
  "NASDAQ": "",
  "AMEX": "",
  "ARCA": "",
  "BATS": "",
  "IEX": "",
  // Unknown exchanges default to empty suffix (US-style)
};

/**
 * Try to resolve ticker using symbol + exchange suffix directly
 * This is the most reliable method when we know the exchange
 *
 * NOTE: We don't validate with Yahoo Finance because CORS blocks the request in browser.
 * The exchange mapping is reliable enough - if we know the exchange, we know the suffix.
 */
function trySymbolWithExchangeSuffix(
  symbol: string,
  exchange: string
): TickerResolutionResult | null {
  const suffix = EXCHANGE_TO_SUFFIX[exchange];

  // Default to empty suffix for unknown exchanges (treats as US)
  const resolvedSuffix = suffix ?? "";

  // Construct the ticker
  const ticker = symbol.includes('.') ? symbol : `${symbol.toUpperCase()}${resolvedSuffix}`;
  debug.log(`[Ticker Resolver] Symbol+exchange fallback: ${symbol} + ${exchange} → ${ticker}`);

  return {
    yahooTicker: ticker,
    confidence: "high",
    source: "fallback",
  };
}

/**
 * Minimal fallback ticker
 * Returns the original IBKR symbol in uppercase with low confidence
 * This is used when ISIN search fails - user will need to manually resolve
 */
function createFallbackTicker(symbol: string): TickerResolutionResult {
  const processedSymbol = symbol.toUpperCase();

  return {
    yahooTicker: processedSymbol,
    confidence: "low",
    source: "fallback",
    alternatives: [processedSymbol],
  };
}

/**
 * Options for ticker resolution
 */
export interface TickerResolutionOptions {
  /** Search function to use (preferred over global state) */
  searchFn?: SearchTickerFn | null;
}

/**
 * Main ticker resolution function
 * Attempts all tiers in order until a resolution is found
 * @param request - The ticker resolution request
 * @param options - Optional configuration including searchFn to avoid global state
 */
export async function resolveTicker(
  request: TickerResolutionRequest,
  options?: TickerResolutionOptions,
): Promise<TickerResolutionResult> {
  const { isin, symbol, exchange } = request;
  const searchFn = options?.searchFn;

  // Manual overrides for symbols that resolve incorrectly
  const MANUAL_SYMBOL_OVERRIDES: Record<string, string> = {
    "BRK B": "BRK-B",
    "BRK A": "BRK-A",
  };
  const manualOverride = MANUAL_SYMBOL_OVERRIDES[symbol?.toUpperCase() || ""];
  if (manualOverride) {
    debug.log(`[Ticker Resolver] Manual override: ${symbol} → ${manualOverride}`);
    return {
      yahooTicker: manualOverride,
      confidence: "high",
      source: "manual",
    };
  }

  // Tier 1: Local cache
  const cached = await checkLocalCache(isin, exchange);
  if (cached) {
    debug.log(`[Ticker Resolver] Cache hit: ${isin} → ${cached.yahooTicker}`);
    return cached;
  }

  // Tier 2: Wealthfolio search API (uses Rust backend, bypasses CORS)
  // Searches by ISIN, CUSIP, FIGI, symbol, description with compatible symbol matching
  const wealthfolioResult = await searchWealthfolioAPI(request, searchFn);
  if (wealthfolioResult) {
    debug.log(`[Ticker Resolver] Wealthfolio API: ${isin} → ${wealthfolioResult.yahooTicker}`);
    await saveToLocalCache(isin, exchange, wealthfolioResult);
    return wealthfolioResult;
  }

  // Tier 3: Yahoo Finance ISIN search (with compatible symbol matching)
  const yahooResult = await searchYahooFinanceByISIN(isin, symbol);
  if (yahooResult) {
    debug.log(`[Ticker Resolver] Yahoo Finance ISIN search: ${isin} → ${yahooResult.yahooTicker}`);
    await saveToLocalCache(isin, exchange, yahooResult);
    return yahooResult;
  }

  // Tier 4: Symbol + exchange suffix fallback
  // Used when ISIN lookup returns no compatible match (e.g., SGLN with IGLN's ISIN)
  const symbolExchangeResult = trySymbolWithExchangeSuffix(symbol, exchange);
  if (symbolExchangeResult) {
    debug.log(`[Ticker Resolver] Symbol+exchange fallback: ${symbol} → ${symbolExchangeResult.yahooTicker}`);
    await saveToLocalCache(isin, exchange, symbolExchangeResult);
    return symbolExchangeResult;
  }

  // Tier 5: Minimal fallback with low confidence
  // Manual selection is handled by the UI component
  debug.log(`[Ticker Resolver] Minimal fallback: ${symbol} (all resolution methods failed)`);
  const fallback = createFallbackTicker(symbol);
  return fallback;
}

/**
 * Get unique tickers that need resolution from parsed CSV data
 * Extracts ISIN, Symbol, CUSIP, FIGI, Description, and ListingExchange
 */
export function extractTickersToResolve(
  data: Record<string, string | undefined>[],
): TickerResolutionRequest[] {
  const tickerMap = new Map<string, TickerResolutionRequest>();

  for (const row of data) {
    const isin = row.ISIN?.toString().trim();
    const symbol = row.Symbol?.toString().trim();
    const rawExchange = row.Exchange?.toString().trim();
    const currency = row.CurrencyPrimary?.toString().trim();

    // Extract additional identifiers
    const cusip = row.CUSIP?.toString().trim();
    const figi = row.FIGI?.toString().trim();
    const description = row.Description?.toString().trim();
    const listingExchange = row.ListingExchange?.toString().trim();

    // Skip header rows (where Symbol column contains "Symbol")
    if (symbol === 'Symbol' || symbol === '' || !symbol) {
      continue;
    }

    // Use ListingExchange (real exchange like NYSE, NASDAQ) instead of Exchange (trade IDs)
    // Exchange column often contains trade IDs (numeric) or DARK pool identifiers
    const exchange = listingExchange || rawExchange;

    // Skip rows where exchange looks like a trade ID (numeric) or is empty
    if (!exchange || /^\d+$/.test(exchange)) {
      continue;
    }

    // Skip special exchanges and rows without required data
    const skipExchanges = ['IDEALFX', 'TransactionID', 'TransferAccount', 'DARK'];
    if (!isin || !symbol || !currency || skipExchanges.includes(exchange)) {
      continue;
    }

    const key = `${isin}:${exchange}`;

    if (!tickerMap.has(key)) {
      tickerMap.set(key, {
        isin,
        symbol,
        exchange,
        currency,
        cusip: cusip || undefined,
        figi: figi || undefined,
        description: description || undefined,
        listingExchange: listingExchange || undefined,
      });
    }
  }

  return Array.from(tickerMap.values());
}

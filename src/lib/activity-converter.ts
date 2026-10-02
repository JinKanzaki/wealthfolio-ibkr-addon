import type { ActivityImport, ActivityType } from "@wealthfolio/addon-sdk";
import { debug } from "./debug-logger";
import { EXCHANGE_TO_CURRENCY } from "./exchange-utils";
import type { AccountPreview, ProcessedIBKRRow, ConversionError, ConversionResult } from "../types";
import { parseDividendInfo } from "./dividend-utils";
import { getErrorMessage } from "./shared-utils";
import { MAX_FX_RATE } from "./constants";

/**
 * Valid activity types that can be imported to Wealthfolio
 */
const VALID_ACTIVITY_TYPES = new Set<ActivityType>([
  "BUY", "SELL", "DIVIDEND", "INTEREST", "DEPOSIT", "WITHDRAWAL",
  "ADD_HOLDING", "REMOVE_HOLDING", "TRANSFER_IN", "TRANSFER_OUT",
  "FEE", "TAX", "SPLIT"
]);

/**
 * Activity Converter Service
 *
 * Converts processed IBKR CSV data to ActivityImport format
 * for import into Wealthfolio
 */

// parseDividendInfo is now imported from dividend-utils.ts

/**
 * Map IBKR activity types to Wealthfolio activity types
 * Returns null if the IBKR type is not recognized (should be skipped)
 */
function mapActivityType(ibkrType: string): ActivityType | null {
  const mapping: Record<string, ActivityType> = {
    "IBKR_BUY": "BUY",
    "IBKR_SELL": "SELL",
    "IBKR_DIVIDEND": "DIVIDEND",
    "IBKR_TAX": "TAX",
    "IBKR_FEE": "FEE",
    "IBKR_DEPOSIT": "DEPOSIT",
    "IBKR_WITHDRAWAL": "WITHDRAWAL",
    "IBKR_TRANSFER_IN": "TRANSFER_IN",
    "IBKR_TRANSFER_OUT": "TRANSFER_OUT",
    "IBKR_INTEREST": "INTEREST",
  };

  const mapped = mapping[ibkrType];
  if (mapped && VALID_ACTIVITY_TYPES.has(mapped)) {
    return mapped;
  }
  return null;
}

/**
 * Parse numeric value from CSV string
 * Returns 0 for empty/null/undefined values, and the parsed number otherwise.
 * Non-empty values that cannot be parsed are logged as warnings.
 */
function parseNumeric(value: string | number | undefined | null, fieldName?: string): number {
  if (typeof value === "number") return value;
  if (!value || String(value).trim() === "") return 0;

  const str = String(value).replace(/[^0-9.-]/g, "");
  const parsed = parseFloat(str);

  if (isNaN(parsed)) {
    // Log warning for non-empty values that can't be parsed
    debug.warn(`[Activity Converter] Could not parse numeric value${fieldName ? ` for ${fieldName}` : ""}: "${value}"`);
    return 0;
  }

  return parsed;
}

/**
 * Position entry with date for historical position lookup
 */
interface PositionEntry {
  date: string;
  quantity: number;
}

/**
 * Build position history from BUY/SELL transactions.
 * Used to look up position quantity at dividend date for accurate dividend calculation.
 *
 * Returns a map: symbol -> PositionEntry[] sorted by date
 * Each entry represents the cumulative position after a trade on that date.
 */
function buildPositionHistory(processedData: ProcessedIBKRRow[]): Map<string, PositionEntry[]> {
  const history = new Map<string, PositionEntry[]>();

  // Sort transactions by date first
  const trades = processedData
    .filter((row) => row._IBKR_TYPE === "IBKR_BUY" || row._IBKR_TYPE === "IBKR_SELL")
    .sort((a, b) => {
      const dateA = a.Date || a.TradeDate || "";
      const dateB = b.Date || b.TradeDate || "";
      return dateA.localeCompare(dateB);
    });

  // Track running position for each symbol
  const currentPosition = new Map<string, number>();

  for (const row of trades) {
    const symbol = (row.Symbol || "").toUpperCase();
    if (!symbol) continue;

    const quantity = parseNumeric(row.Quantity);
    const isBuy = row._IBKR_TYPE === "IBKR_BUY";
    const date = row.Date || row.TradeDate || "";

    // Update running position
    const prevPosition = currentPosition.get(symbol) || 0;
    const newPosition = isBuy ? prevPosition + quantity : prevPosition - quantity;
    currentPosition.set(symbol, newPosition);

    // Record position entry
    let entries = history.get(symbol);
    if (!entries) {
      entries = [];
      history.set(symbol, entries);
    }
    entries.push({ date, quantity: newPosition });
  }

  return history;
}

/**
 * Get position quantity for a symbol at a specific date.
 * Returns the position as of the most recent trade on or before the given date.
 */
function getPositionAtDate(
  positionHistory: Map<string, PositionEntry[]>,
  symbol: string,
  date: string
): number {
  const entries = positionHistory.get(symbol.toUpperCase());
  if (!entries || entries.length === 0) return 0;

  // Find the most recent entry on or before the date
  let position = 0;
  for (const entry of entries) {
    if (entry.date <= date) {
      position = entry.quantity;
    } else {
      break;
    }
  }

  return position;
}

/**
 * FX Rate entry with date for closest-date lookup
 */
interface FXRateEntry {
  date: string;
  rate: number; // e.g., 1.33 means 1 GBP = 1.33 USD
}

/**
 * Build FX rate lookup from FX trades in the raw data.
 *
 * Must be called with RAW CSV data (before preprocessing) because
 * preprocessing converts FX trades to TRANSFER_IN/TRANSFER_OUT pairs,
 * losing the exchange rate information.
 *
 * FX trades have:
 * - Symbol like "GBP.USD" (base.quote)
 * - TradePrice containing the exchange rate
 * - TradeDate or ReportDate for the trade date
 * - LevelOfDetail = "EXECUTION" for the actual trade rows
 *
 * Returns a map: "BASE/QUOTE" -> FXRateEntry[] sorted by date
 * e.g., "GBP/USD" -> [{date: "2025-05-07", rate: 1.33}, ...]
 */
export function buildFXRateLookup(rawData: ProcessedIBKRRow[]): Map<string, FXRateEntry[]> {
  const lookup = new Map<string, FXRateEntry[]>();

  for (const row of rawData) {
    // FX trades have Symbol like "GBP.USD" and LevelOfDetail = "EXECUTION"
    if (!row.Symbol || !row.Symbol.includes(".")) continue;
    if (row.LevelOfDetail !== "EXECUTION") continue;

    const parts = row.Symbol.split(".");
    if (parts.length !== 2) continue;

    const [base, quote] = parts;
    const tradePrice = parseNumeric(row.TradePrice);

    // Skip invalid prices (sanity check for FX rates)
    if (tradePrice <= 0 || tradePrice > MAX_FX_RATE) continue;

    const date = row.TradeDate || row.ReportDate || row.Date || "";
    if (!date) continue;

    // Normalize date format (remove time portion if present)
    const normalizedDate = date.split(" ")[0];

    const key = `${base}/${quote}`;
    let keyEntries = lookup.get(key);
    if (!keyEntries) {
      keyEntries = [];
      lookup.set(key, keyEntries);
    }
    keyEntries.push({ date: normalizedDate, rate: tradePrice });

    // Also store inverse for reverse lookup
    const inverseKey = `${quote}/${base}`;
    let inverseEntries = lookup.get(inverseKey);
    if (!inverseEntries) {
      inverseEntries = [];
      lookup.set(inverseKey, inverseEntries);
    }
    inverseEntries.push({ date: normalizedDate, rate: 1 / tradePrice });
  }

  // Sort each array by date
  for (const [, entries] of lookup) {
    entries.sort((a, b) => a.date.localeCompare(b.date));
  }

  return lookup;
}

/**
 * Get the FX rate for converting from base currency to target currency.
 * Uses the closest rate by date (prefers earlier or same date).
 *
 * @returns The rate to multiply base amount by to get target amount, or null if not found
 */
function getFXRate(
  lookup: Map<string, FXRateEntry[]>,
  baseCurrency: string,
  targetCurrency: string,
  date: string
): number | null {
  const key = `${baseCurrency}/${targetCurrency}`;
  const entries = lookup.get(key);

  if (!entries || entries.length === 0) return null;

  const normalizedDate = date.split(" ")[0];

  // Find the closest rate by date (prefer same date or earlier)
  let closest: FXRateEntry | null = null;
  for (const entry of entries) {
    if (entry.date <= normalizedDate) {
      closest = entry;
    } else if (!closest) {
      // Use first future rate if no earlier rates exist
      closest = entry;
      break;
    } else {
      break;
    }
  }

  return closest?.rate ?? null;
}

/**
 * Parse transaction tax amount from TTAX description
 *
 * TTAX descriptions have format: "French Daily Trade Charge Tax HESAY 6"
 * where "6" is the actual tax amount in the original currency (USD).
 * The Amount column contains the base currency equivalent.
 *
 * @returns The original currency amount or null if not parseable
 */
function parseTTAXAmount(description: string): number | null {
  // Match the last number in the description
  // e.g., "French Daily Trade Charge Tax HESAY 6" -> 6
  // e.g., "French Daily Trade Charge Tax HESAY 1.5" -> 1.5
  const match = /\s([\d.]+)$/.exec(description);
  if (match) {
    const amount = parseFloat(match[1]);
    if (!isNaN(amount)) {
      return amount;
    }
  }
  return null;
}

/**
 * Determine the actual transaction currency
 *
 * IBKR exports show CurrencyPrimary as the base currency for ALL transactions,
 * so we need to determine the actual currency from other fields.
 *
 * Logic:
 * 1. For FX conversions (Symbol contains "."): Parse the currency pair
 * 2. For stock trades: Map the ListingExchange to currency
 * 3. For transaction taxes (TTAX): Use ListingExchange (tax is in security's trading currency)
 * 4. For other cash transactions: Use the base currency (CurrencyPrimary)
 */
function determineTransactionCurrency(row: ProcessedIBKRRow, baseCurrency: string): string {
  const ibkrType = row._IBKR_TYPE || "";
  const activityCode = row.ActivityCode || "";

  // For transaction taxes (TTAX), use the security's trading currency
  // TTAX rows have Amount in the original currency (e.g., USD for HESAY French FTT)
  // even though CurrencyPrimary is the account's base currency
  if (activityCode === "TTAX" && row.ListingExchange && EXCHANGE_TO_CURRENCY[row.ListingExchange]) {
    return EXCHANGE_TO_CURRENCY[row.ListingExchange];
  }

  // For OFEE (Other Fees) with ListingExchange, these are dividend-related ADR fees
  // The fee is in the security's trading currency, not the base currency
  if (activityCode === "OFEE" && row.ListingExchange && EXCHANGE_TO_CURRENCY[row.ListingExchange]) {
    return EXCHANGE_TO_CURRENCY[row.ListingExchange];
  }

  // For most cash transactions (transfers, deposits, withdrawals, fees, interest, dividends, taxes),
  // use CurrencyPrimary directly - the preprocessor sets this correctly
  if (
    ibkrType.includes("TRANSFER") ||
    ibkrType.includes("DEPOSIT") ||
    ibkrType.includes("WITHDRAWAL") ||
    ibkrType.includes("FEE") ||
    ibkrType.includes("INTEREST") ||
    ibkrType.includes("DIVIDEND") ||
    ibkrType.includes("TAX")
  ) {
    return baseCurrency;
  }

  // FX conversions: Symbol is like "GBP.USD", "EUR.USD", etc.
  if (row.Symbol && row.Symbol.includes('.')) {
    const parts = row.Symbol.split('.');
    if (parts.length === 2) {
      // For FX, we'll handle this specially in the FX splitter
      // For now, return base currency (will be overridden by splitter)
      return baseCurrency;
    }
  }

  // Stock trades: Use exchange-to-currency mapping
  if (row.ListingExchange && EXCHANGE_TO_CURRENCY[row.ListingExchange]) {
    return EXCHANGE_TO_CURRENCY[row.ListingExchange];
  }

  // Fallback: Use base currency from CurrencyPrimary
  return baseCurrency;
}

/**
 * Convert IBKR CSV rows to ActivityImport format
 *
 * Returns a result object with:
 * - activities: Successfully converted activities
 * - errors: Conversion errors with details for user visibility
 * - skipped: Count of rows skipped due to unrecognized types
 */
export async function convertToActivityImports(
  processedData: ProcessedIBKRRow[],
  accountPreviews: AccountPreview[]
): Promise<ConversionResult> {
  // Input validation - early return for empty inputs
  if (!processedData || processedData.length === 0) {
    return { activities: [], errors: [], skipped: 0 };
  }

  if (!accountPreviews || accountPreviews.length === 0) {
    return {
      activities: [],
      errors: [{
        rowIndex: 0,
        identifier: "Account Setup",
        message: "No account previews provided - cannot convert activities without target accounts",
        rowData: {},
      }],
      skipped: processedData.length,
    };
  }

  const activities: ActivityImport[] = [];
  const errors: ConversionError[] = [];
  let skipped = 0;

  // Build FX rate lookup from FX trades for currency conversion
  const fxLookup = buildFXRateLookup(processedData);

  // Build position history from BUY/SELL trades for dividend calculation
  const positionHistory = buildPositionHistory(processedData);

  for (let rowIndex = 0; rowIndex < processedData.length; rowIndex++) {
    const row = processedData[rowIndex];
    const identifier = row.Symbol || row.ActivityDescription || `Row ${rowIndex + 1}`;

    try {
      const baseCurrency = row.CurrencyPrimary || "USD";
      const ibkrType = row._IBKR_TYPE || "";
      const activityType = mapActivityType(ibkrType);

      // Skip unrecognized activity types
      if (activityType === null) {
        if (ibkrType && ibkrType !== "") {
          debug.log(`Skipping unrecognized IBKR activity type: ${ibkrType} for ${identifier}`);
          skipped++;
        }
        continue;
      }

      // Field names from ibkr-preprocessor.ts:
      // - Quantity (for trade shares)
      // - TradePrice (for unit price)
      // - TradeMoney (for cash amounts in deposits/withdrawals/dividends)
      // - IBCommission (for fees)
      const quantity = parseNumeric(row.Quantity) || 0;
      const unitPrice = parseNumeric(row.TradePrice) || 0;

      // Calculate amount based on transaction type
      let amount = 0;
      let fee = 0;
      let currency = determineTransactionCurrency(row, baseCurrency);

      if (ibkrType === "IBKR_BUY" || ibkrType === "IBKR_SELL") {
        // For trades: calculate from quantity * unit_price
        amount = Math.abs(quantity * unitPrice);
        // Fee includes both commission (IBCommission) and any transaction taxes (Taxes field)
        // Transaction taxes include things like HK stamp duty, which is in the trade's Taxes column
        fee = Math.abs(parseNumeric(row.IBCommission)) + Math.abs(parseNumeric(row.Taxes));
      } else if (ibkrType === "IBKR_DIVIDEND") {
        // For dividends: Calculate amount from per-share × position quantity
        //
        // At BaseCurrency level, TradeMoney is in the base currency (e.g., GBP),
        // but the dividend was actually paid in the original currency (e.g., USD).
        // Using FX rates to convert is unreliable (rates often not available).
        //
        // Better approach: Calculate from per-share amount × position quantity
        // - Parse per-share from description (e.g., "Cash Dividend USD 0.264 per Share")
        // - Look up position quantity at dividend date from position history
        // - amount = perShare × position
        //
        const activityDesc = row.ActivityDescription || "";
        const dividendInfo = parseDividendInfo(activityDesc);
        const txDate = row.Date || row.ReportDate || row.TradeDate || "";
        const symbol = (row.Symbol || "").toUpperCase();

        if (dividendInfo) {
          currency = dividendInfo.currency;

          // If dividend currency matches base currency, TradeMoney is already correct
          if (currency === baseCurrency) {
            amount = Math.abs(parseNumeric(row.TradeMoney));
          } else {
            // Dividend is in a different currency than base (e.g., USD dividend, GBP base)
            // TradeMoney is in base currency, so we need to convert to original currency
            //
            // Preferred method: Calculate from per-share × position quantity
            const position = getPositionAtDate(positionHistory, symbol, txDate);

            if (position > 0 && dividendInfo.perShare > 0) {
              // Calculate: amount = position × perShare
              amount = position * dividendInfo.perShare;
            } else {
              // Fallback to FX conversion if position unknown
              const fxRate = getFXRate(fxLookup, baseCurrency, currency, txDate);
              if (fxRate && fxRate > 0) {
                amount = Math.abs(parseNumeric(row.TradeMoney)) * fxRate;
              } else {
                // Last resort: use TradeMoney as-is and fall back to base currency
                // This is better than having incorrect currency on the amount
                amount = Math.abs(parseNumeric(row.TradeMoney));
                const originalCurrency = currency;
                currency = baseCurrency;
                const warningMsg = `Dividend currency mismatch: ${symbol} on ${txDate} - no FX rate or position for ${baseCurrency}/${dividendInfo.currency}, using base currency (${baseCurrency}) instead of ${originalCurrency}`;
                debug.warn(warningMsg);
                // Surface this as a non-fatal error so user is aware of currency change
                errors.push({
                  rowIndex,
                  identifier,
                  message: warningMsg,
                  rowData: row as Record<string, unknown>,
                });
              }
            }
          }
        } else {
          // Couldn't parse currency from description, use base currency
          amount = Math.abs(parseNumeric(row.TradeMoney));
        }
        fee = 0;
      } else if (ibkrType === "IBKR_TAX") {
        // For taxes: Calculate amount from per-share × position × tax_rate
        // Similar to dividends, TradeMoney is in base currency for BaseCurrency level rows.
        //
        // Tax descriptions have format: "SYMBOL(ISIN) CASH DIVIDEND XXX N.NN PER SHARE - CC TAX"
        // The tax is typically a percentage of the dividend (e.g., 15% US WHT).
        // We calculate the tax by first calculating the dividend, then applying the tax ratio.
        //
        const activityDesc = row.ActivityDescription || row.Description || "";
        const dividendInfo = parseDividendInfo(activityDesc);
        const txDate = row.Date || row.ReportDate || row.TradeDate || "";
        const symbol = (row.Symbol || "").toUpperCase();

        if (dividendInfo) {
          currency = dividendInfo.currency;
          const tradeMoneyBase = Math.abs(parseNumeric(row.TradeMoney));

          // If tax currency matches base currency, TradeMoney is already correct
          if (currency === baseCurrency) {
            amount = tradeMoneyBase;
          } else {
            // Tax is in a different currency than base (e.g., USD tax, GBP base)
            // Try to calculate using position × perShare × tax_rate
            const position = getPositionAtDate(positionHistory, symbol, txDate);

            if (position > 0 && dividendInfo.perShare > 0) {
              // Calculate gross dividend, then derive tax amount
              const grossDividend = position * dividendInfo.perShare;

              // Use the ratio of TradeMoney to estimated base currency dividend to get tax rate
              const fxRate = getFXRate(fxLookup, baseCurrency, currency, txDate);

              if (fxRate && fxRate > 0 && grossDividend > 0) {
                // Estimate what the base currency dividend would have been
                const estimatedBaseDividend = grossDividend / fxRate;
                // Calculate tax rate from ratio
                let taxRate: number;
                if (estimatedBaseDividend > 0) {
                  taxRate = tradeMoneyBase / estimatedBaseDividend;
                } else {
                  taxRate = 0;
                  debug.warn(`Zero estimated dividend for tax calculation: ${symbol} on ${txDate}, tax rate defaulted to 0`);
                }
                // Apply tax rate to actual dividend amount
                amount = grossDividend * taxRate;
              } else {
                // Fallback: use FX conversion on TradeMoney
                if (fxRate && fxRate > 0) {
                  amount = tradeMoneyBase * fxRate;
                } else {
                  // Fall back to base currency when no FX rate available
                  amount = tradeMoneyBase;
                  currency = baseCurrency;
                  debug.warn(`No FX rate or position for ${baseCurrency}/${dividendInfo.currency} tax: ${symbol} on ${txDate}, using base currency amount`);
                }
              }
            } else {
              // No position history - fallback to FX conversion
              const fxRate = getFXRate(fxLookup, baseCurrency, currency, txDate);
              if (fxRate && fxRate > 0) {
                amount = tradeMoneyBase * fxRate;
              } else {
                // Fall back to base currency when no FX rate available
                amount = tradeMoneyBase;
                currency = baseCurrency;
              }
            }
          }
        } else {
          amount = Math.abs(parseNumeric(row.TradeMoney));
        }
        fee = 0;
      } else {
        // For other transactions (deposits, withdrawals, fees, interest)
        // TradeMoney contains the cash amount

        // Special handling for TTAX (Transaction Tax) rows at BaseCurrency level
        // The TradeMoney contains the base currency equivalent, but we need the original currency amount
        // which is embedded in the description (e.g., "French Daily Trade Charge Tax HESAY 6")
        const activityCode = row.ActivityCode || "";
        if (activityCode === "TTAX") {
          const description = row.ActivityDescription || row.Description || "";
          const ttaxAmount = parseTTAXAmount(description);
          if (ttaxAmount !== null) {
            amount = ttaxAmount;
          } else {
            // Fallback to TradeMoney if parsing fails
            amount = Math.abs(parseNumeric(row.TradeMoney));
          }
        } else if (activityCode === "OFEE" && row.ListingExchange && EXCHANGE_TO_CURRENCY[row.ListingExchange]) {
          // OFEE dividend fees at BaseCurrency level need FX conversion
          // TradeMoney is in base currency, but the fee should be in the security's trading currency
          const targetCurrency = EXCHANGE_TO_CURRENCY[row.ListingExchange];
          const tradeMoneyBase = Math.abs(parseNumeric(row.TradeMoney));
          const txDate = row.Date || row.ReportDate || row.TradeDate || "";

          // Try to convert using FX rate
          const fxRate = getFXRate(fxLookup, baseCurrency, targetCurrency, txDate);
          if (fxRate && fxRate > 0) {
            amount = tradeMoneyBase * fxRate;
          } else {
            // Fallback: use TradeMoney as-is in base currency
            amount = tradeMoneyBase;
            currency = baseCurrency;
            debug.warn(`No FX rate for ${baseCurrency}/${targetCurrency} OFEE fee on ${txDate}, using base currency amount`);
          }
        } else {
          amount = Math.abs(parseNumeric(row.TradeMoney));
        }
        fee = Math.abs(parseNumeric(row.IBCommission));
      }

      const accountPreview = accountPreviews.find(p => p.currency === currency);

      if (!accountPreview) {
        errors.push({
          rowIndex,
          identifier,
          message: `No account found for currency ${currency}`,
        });
        continue;
      }

      // For cash transactions (not trades), quantity should be the cash amount
      // and unitPrice should be 1
      const isCashTransaction = ibkrType !== "IBKR_BUY" && ibkrType !== "IBKR_SELL";
      const finalQuantity = isCashTransaction ? amount : quantity;
      const finalUnitPrice = isCashTransaction ? 1 : unitPrice;

      // Validate date - missing date should be an error, not silently defaulted
      const rawDate = row.Date || row.ReportDate;
      // Format date from YYYYMMDD to YYYY-MM-DD if needed
      const activityDate = rawDate && rawDate.length === 8 && !rawDate.includes('-')
        ? `${rawDate.substring(0, 4)}-${rawDate.substring(4, 6)}-${rawDate.substring(6, 8)}`
        : rawDate;
      if (!activityDate) {
        errors.push({
          rowIndex,
          identifier,
          message: "Missing date field - transaction cannot be imported without a valid date",
          rowData: row as Record<string, unknown>,
        });
        continue;
      }

      const activity: ActivityImport = {
        accountId: "", // Will be set later when grouping by currency
        date: activityDate,
        symbol: row._resolvedTicker || row.Symbol || row.SecurityID || `$CASH-${currency}`,
        activityType: activityType,
        quantity: finalQuantity,
        unitPrice: finalUnitPrice,
        currency: currency,
        fee: fee,
        amount: amount,
        comment: row.ActivityDescription || row.Description || "",
        isDraft: false,
        isValid: true,
        quoteCcy: currency,
        instrumentType: "EQUITY",
      };

      activities.push(activity);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      debug.error(`Error converting activity at row ${rowIndex}:`, errorMessage);
      errors.push({
        rowIndex,
        identifier,
        message: errorMessage,
        rowData: { ...row },
      });
    }
  }

  // Log summary for debugging
  if (errors.length > 0) {
    debug.warn(`Activity conversion completed with ${errors.length} error(s), ${skipped} skipped, ${activities.length} successful`);
  }

  return { activities, errors, skipped };
}

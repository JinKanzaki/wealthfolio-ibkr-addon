import { IBKRTransactionRow, IBKRClassification, CsvRowData } from "../presets/types";
import { debug } from "./debug-logger";
import { normalizeNumericValue } from "./validation-utils";
import { EXCHANGE_TO_CURRENCY } from "./exchange-utils";

/**
 * Convert CsvRowData to IBKRTransactionRow type.
 *
 * This is a safe type assertion because:
 * - CsvRowData is Record<string, string | undefined>
 * - IBKRTransactionRow has all optional string properties
 * - Missing IBKR fields will be undefined (which is allowed)
 *
 * The CSV parser produces generic rows, but this preprocessor
 * specifically handles IBKR data where the field names match.
 */
function asIBKRRow(row: CsvRowData): IBKRTransactionRow {
  return row as IBKRTransactionRow;
}

/**
 * IBKR Transaction Preprocessor
 *
 * Handles IBKR-specific CSV preprocessing before validation:
 * 1. Filters out IDEALFX currency conversion transactions
 * 2. Classifies transactions based on IBKR's multi-field structure
 * 3. Adds computed _IBKR_TYPE column for activity mapping
 * 4. Extracts proper values for fees, amounts, etc.
 *
 * User decisions implemented:
 * - Ignore FX conversion transactions (IDEALFX exchange)
 * - Use IBCommission field only for fees
 * - Import dividends and taxes as separate transactions
 */

/**
 * Classify a single IBKR transaction row
 *
 * NOTE: IBKR CSV uses DIFFERENT column mappings for different transaction types!
 * - For stock trades: data is in standard columns (Exchange, Quantity, TradePrice, etc.)
 * - For dividends: data is SHIFTED to different columns (see getDividendFields below)
 */
function classifyIBKRTransaction(row: IBKRTransactionRow): IBKRClassification {
  const exchange = row.Exchange?.trim();
  const transactionType = row.TransactionType?.trim();
  const buySell = row["Buy/Sell"]?.trim();
  const notesCodes = row["Notes/Codes"]?.trim();
  const description = row.Description?.trim() ?? "";
  const transferDirection = row._TRANSFER_DIRECTION?.trim();

  // For dividends, IBKR shifts data to different columns
  // Check PrincipalAdjustFactor which contains Notes/Codes for dividend rows
  const principalAdjustFactor = row.PrincipalAdjustFactor?.trim();

  // Rule 0: Cash transfers (from Section 3)
  // Must check BEFORE Rule 1, as transfers also have AssetClass="CASH"
  if (transactionType === "INTERNAL" && transferDirection && row.AssetClass === "CASH") {
    const amount = normalizeNumericValue(row.TradeMoney);

    debug.log(`[IBKR Classifier] Found INTERNAL transfer: Direction="${transferDirection}", TradeMoney="${row.TradeMoney}", parsed amount=${amount}`);

    if (transferDirection === "IN" && amount !== undefined && amount !== 0) {
      debug.log(`[IBKR Classifier] Classified as TRANSFER_IN`);
      return {
        classification: "TRANSFER_IN",
        shouldImport: true,
        warningMessages: [],
        originalRow: row,
      };
    } else if (transferDirection === "OUT" && amount !== undefined && amount !== 0) {
      debug.log(`[IBKR Classifier] Classified as TRANSFER_OUT`);
      return {
        classification: "TRANSFER_OUT",
        shouldImport: true,
        warningMessages: [],
        originalRow: row,
      };
    }
  }

  // Rule 0.5: Skip summary/aggregation rows
  // IBKR CSV includes various summary rows that are NOT actual transactions:
  // - "Currency" level: Cash balance summaries per currency
  // - "SUMMARY" level: Position summaries
  // - "BaseCurrency" level: Base currency equivalents (except DIV/TTAX which only exist here)
  // - Empty LevelOfDetail with no activity: Header/footer rows
  const levelOfDetail = row.LevelOfDetail?.trim();
  const activityCode = row.ActivityCode?.trim();

  // Skip "Currency" level rows - these are cash balance summaries, not transactions
  if (levelOfDetail === "Currency" && !activityCode) {
    return {
      classification: "SUMMARY_ROW",
      shouldImport: false,
      warningMessages: ["Currency balance summary row skipped"],
      originalRow: row,
    };
  }

  // Skip "SUMMARY" level rows - these are position summaries, not transactions
  if (levelOfDetail === "SUMMARY") {
    return {
      classification: "SUMMARY_ROW",
      shouldImport: false,
      warningMessages: ["Position summary row skipped"],
      originalRow: row,
    };
  }

  // Skip empty rows (no LevelOfDetail and no transaction identifiers)
  if (!levelOfDetail && !activityCode && !transactionType && !exchange && !notesCodes && !description) {
    return {
      classification: "EMPTY_ROW",
      shouldImport: false,
      warningMessages: ["Empty row skipped"],
      originalRow: row,
    };
  }

  if (levelOfDetail === "BaseCurrency") {
    // Allow certain activity codes through - they only exist at BaseCurrency level:
    // - DIV: Dividend payments
    // - TTAX: Transaction taxes (e.g., French FTT for HESAY)
    // - STAX: Sales Tax / VAT - only at BaseCurrency level
    // - OFEE: Other fees - but with special handling (see below)
    // NOTE: DINT (Debit Interest) exists at BOTH BaseCurrency AND Currency levels.
    //       Skip BaseCurrency level (has base currency amounts) - use Currency level (has real currency amounts).
    if (activityCode === "DIV" || activityCode === "TTAX" || activityCode === "STAX") {
      // Don't return here - let it fall through to proper classification
    } else if (activityCode === "OFEE") {
      // OFEE (Other Fees) handling at BaseCurrency level:
      // - Dividend-related fees (WITH ListingExchange): ADR fees for dividend payments
      //   These only exist at BaseCurrency level - import them!
      // - Broker fees (WITHOUT ListingExchange): Snapshot fees, etc.
      //   These also only exist at BaseCurrency level - import them!
      // - POSITIVE Amount = refunds/credits - skip these
      const amount = normalizeNumericValue(row.Amount);

      if (amount !== undefined && amount > 0) {
        // Positive amount = refund/credit - skip
        return {
          classification: "SECTION2_DUPLICATE",
          shouldImport: false,
          warningMessages: ["OFEE credit/refund skipped"],
          originalRow: row,
        };
      }

      // All other OFEE rows - let them fall through to FEE classification
    } else {
      return {
        classification: "SECTION2_DUPLICATE",
        shouldImport: false,
        warningMessages: ["BaseCurrency level row skipped (using Currency level instead)"],
        originalRow: row,
      };
    }
  }

  // Rule 1: Handle currency conversions (IDEALFX transactions)
  // IBKR CSV has TWO rows per FX conversion:
  //   1. FOREX row (ActivityCode="FOREX"): Summary row in base currency - SKIP this
  //   2. IDEALFX row (ActivityDescription="IDEALFX"): Actual trade details - USE this
  // We only process IDEALFX rows to avoid duplicates
  // Note: activityCode already declared above in Rule 0.5
  const activityDescription = row.ActivityDescription?.trim();

  if (activityCode === "FOREX") {
    // Skip FOREX summary rows - they duplicate the IDEALFX rows
    return {
      classification: "FX_CONVERSION",
      shouldImport: false,
      warningMessages: ["FX summary row (skipped - using IDEALFX row instead)"],
      originalRow: row,
    };
  }

  if (activityDescription === "IDEALFX" || exchange === "IDEALFX") {
    // FX conversions have Symbol like "GBP.NOK" - source.target currency pair
    // IDEALFX rows in IBKR trades section have:
    //   - TradeMoney: target currency amount (e.g., -507 AUD when selling GBP to get AUD)
    //   - TradePrice: exchange rate
    //   - Buy/Sell: "SELL" or "BUY" indicating direction
    //   - TradeQuantity is often EMPTY (use TradeMoney/TradePrice to calculate source amount)
    //
    // For SELL (e.g., selling GBP to get AUD): TradeMoney is negative in target currency
    //   -> We're selling source currency (GBP), receiving target currency (AUD)
    //   -> Need TRANSFER_OUT from GBP account, TRANSFER_IN to AUD account
    //   -> Classification: FX_DEPOSIT (depositing into target currency account)
    //
    // For BUY (e.g., buying GBP with AUD): TradeMoney is positive in target currency
    //   -> We're buying source currency (GBP), giving target currency (AUD)
    //   -> Need TRANSFER_IN to GBP account, TRANSFER_OUT from AUD account
    //   -> Classification: FX_WITHDRAWAL (withdrawing from target currency account)
    const tradeMoney = normalizeNumericValue(row.TradeMoney);
    const tradePrice = normalizeNumericValue(row.TradePrice);

    if (tradeMoney !== undefined && tradePrice !== undefined && tradePrice !== 0) {
      if (buySell === "SELL" || tradeMoney < 0) {
        // SELL: selling source currency, receiving target currency
        return {
          classification: "FX_DEPOSIT",
          shouldImport: true,
          warningMessages: [],
          originalRow: row,
        };
      } else if (buySell === "BUY" || tradeMoney > 0) {
        // BUY: buying source currency, giving target currency
        return {
          classification: "FX_WITHDRAWAL",
          shouldImport: true,
          warningMessages: [],
          originalRow: row,
        };
      }
    }

    // If no valid amount/price, skip
    return {
      classification: "FX_CONVERSION",
      shouldImport: false,
      warningMessages: ["Currency conversion transaction (skipped - no valid amount/price)"],
      originalRow: row,
    };
  }

  // Rule 2: Stock trades (ExchTrade)
  if (transactionType === "ExchTrade") {
    if (buySell === "BUY") {
      return {
        classification: "STOCK_BUY",
        shouldImport: true,
        warningMessages: [],
        originalRow: row,
      };
    }
    if (buySell === "SELL") {
      return {
        classification: "STOCK_SELL",
        shouldImport: true,
        warningMessages: [],
        originalRow: row,
      };
    }
  }

  // Rule 3: Dividends
  // IBKR has different formats depending on CSV section:
  // - Section 1 (Trades): Description contains "CASH DIVIDEND", tax indicator in Notes/Codes or Description
  // - Section 2 (Dividends): ActivityCode="DIV" for dividend, "FRTAX" for foreign tax
  // Check both formats
  const isDividendByDescription = description.toUpperCase().includes("CASH DIVIDEND");
  const isDividendByActivityCode = activityCode === "DIV";
  const isTaxByActivityCode = activityCode === "FRTAX";

  // Withholding Tax rows (Notes/Codes = "Withholding Tax")
  // These are tax deductions in the dividend currency. Import them.
  // Note: FRTAX rows (base currency equivalent) are skipped separately to avoid double-counting.
  if (notesCodes === "Withholding Tax") {
    return {
      classification: "DIVIDEND_TAX",
      shouldImport: true,
      warningMessages: [],
      originalRow: row,
    };
  }

  if (isDividendByDescription || isDividendByActivityCode) {
    // First check for FEE indicators - some dividend-related rows are actually fees
    // e.g., "BTI(US1104481072) CASH DIVIDEND USD 0.802221 PER SHARE - FEE"
    const isFeeRow =
      notesCodes === "Other Fees" ||
      description.includes("- FEE");

    if (isFeeRow) {
      return {
        classification: "FEE",
        shouldImport: true,
        warningMessages: [],
        originalRow: row,
      };
    }

    // Check for withholding tax indicators in description (e.g., "- US TAX", "- FO TAX")
    // Use regex to match any "- XX TAX" pattern where XX is a 2-letter country code
    // This covers all countries including: US, GB, CH, DE, FR, IT, NL, BE, AT, ES, PT,
    // IE, DK, SE, NO, FI, AU, NZ, CA, JP, HK, SG, KR, CN, BR, MX, ZA, IN, TW, FO, etc.
    const taxCountryPattern = /- [A-Z]{2} TAX/i;
    const isWithholdingTax =
      principalAdjustFactor === "Withholding Tax" ||
      taxCountryPattern.test(description);

    if (isWithholdingTax) {
      // Rule 4: Dividend withholding tax
      return {
        classification: "DIVIDEND_TAX",
        shouldImport: true,
        warningMessages: [],
        originalRow: row,
      };
    } else {
      // Rule 3: Regular dividend payment
      return {
        classification: "DIVIDEND_PAYMENT",
        shouldImport: true,
        warningMessages: [],
        originalRow: row,
      };
    }
  }

  // Foreign tax (FRTAX) - withholding tax from dividends section
  // SKIP: This is the base currency equivalent of the actual withholding tax.
  // The actual tax deduction appears separately in the original currency (e.g., NOK)
  // with Notes/Codes="Withholding Tax". Importing both would double-count the tax.
  if (isTaxByActivityCode) {
    return {
      classification: "DIVIDEND_TAX",
      shouldImport: false,
      warningMessages: ["FRTAX skipped - actual tax recorded in original currency"],
      originalRow: row,
    };
  }

  // Rule 5: Fees
  // IBKR uses different fields depending on CSV section:
  // - trades section: ActivityCode = "OFEE" or "STAX" (VAT)
  // - dividends section: Notes/Codes = "Other Fees"
  // Note: activityCode already declared above for FOREX check
  if (
    notesCodes === "Other Fees" ||
    activityCode === "OFEE" ||
    activityCode === "STAX" ||
    description.toUpperCase().includes("FEE") ||
    description.toUpperCase().includes("CHARGE") ||
    description.toUpperCase().includes("VAT ")
  ) {
    return {
      classification: "FEE",
      shouldImport: true,
      warningMessages: [],
      originalRow: row,
    };
  }

  // Rule 6: Deposits/Withdrawals
  // NOTE: CSV parser maps data correctly based on headers, so we check the parsed values
  if (notesCodes === "Deposits/Withdrawals" || principalAdjustFactor === "Deposits/Withdrawals") {
    // After CSV parsing, TradeMoney contains the amount
    const amount = normalizeNumericValue(row.TradeMoney);

    debug.log(`[IBKR Classifier] Found Deposits/Withdrawals: TradeMoney="${row.TradeMoney}", parsed amount=${amount}`);

    if (amount !== undefined) {
      if (amount > 0) {
        debug.log(`[IBKR Classifier] Classified as DEPOSIT (amount > 0)`);
        return {
          classification: "DEPOSIT",
          shouldImport: true,
          warningMessages: [],
          originalRow: row,
        };
      } else if (amount < 0) {
        debug.log(`[IBKR Classifier] Classified as WITHDRAWAL (amount < 0)`);
        return {
          classification: "WITHDRAWAL",
          shouldImport: true,
          warningMessages: [],
          originalRow: row,
        };
      }
    }
  }

  // Rule 7: Interest (credit interest = income, debit interest = expense)
  // IBKR has two types of interest:
  // - Credit Interest: Interest earned on cash balances (rare, positive amount)
  // - Debit Interest: Margin interest charged for borrowing (common, negative amount)
  //
  // Check Description for "INTEREST" or "INT FOR" (short form used by IBKR)
  // Also check Notes/Codes for "Broker Interest"
  // Also check ActivityCode for "DINT" (debit interest in base currency)
  if (
    description.toUpperCase().includes("INTEREST") ||
    description.toUpperCase().includes("INT FOR") ||
    notesCodes?.toLowerCase().includes("interest") ||
    activityCode === "DINT"
  ) {
    // Check if this is DEBIT interest (expense) vs CREDIT interest (income)
    // DEBIT INT = margin interest charges paid BY user TO IBKR (expense)
    // CREDIT INT = interest earned on cash (income)
    const isDebitInterest =
      description.toUpperCase().includes("DEBIT INT") ||
      description.toUpperCase().includes("DEBIT INTEREST") ||
      activityCode === "DINT";

    if (isDebitInterest) {
      // Debit interest is an expense (fee), not income
      return {
        classification: "FEE",
        shouldImport: true,
        warningMessages: [],
        originalRow: row,
      };
    }

    return {
      classification: "INTEREST",
      shouldImport: true,
      warningMessages: [],
      originalRow: row,
    };
  }

  // Rule 8: Transaction Tax (TTAX)
  // IBKR charges transaction taxes for certain markets (e.g., French FTT for HESAY)
  if (activityCode === "TTAX") {
    return {
      classification: "FEE",
      shouldImport: true,
      warningMessages: [],
      originalRow: row,
    };
  }

  // Rule 9: Skip Section 2 base currency equivalents
  // IBKR Section 2 (Activity) includes base currency equivalents of transactions
  // that were already imported from Section 1 (Trades). Skip these to avoid double-counting.
  //
  // DEP: Deposit (Section 2) - duplicates Section 1 deposits with Notes/Codes="Deposits/Withdrawals"
  // WITH: Withdrawal (Section 2) - duplicates Section 1 transfers/withdrawals
  // BUY: Buy (Section 2) - duplicates Section 1 ExchTrade buys in base currency equivalent
  //
  // Note: We identify Section 2 rows by having ActivityCode but NOT TransactionType="ExchTrade"
  // (Section 1 trades have TransactionType="ExchTrade", Section 2 has ActivityCode only)
  if (activityCode === "DEP" && notesCodes !== "Deposits/Withdrawals" && transactionType !== "ExchTrade") {
    return {
      classification: "SECTION2_DUPLICATE",
      shouldImport: false,
      warningMessages: ["Section 2 deposit duplicate skipped"],
      originalRow: row,
    };
  }

  if (activityCode === "WITH") {
    return {
      classification: "SECTION2_DUPLICATE",
      shouldImport: false,
      warningMessages: ["Section 2 withdrawal duplicate skipped"],
      originalRow: row,
    };
  }

  if (activityCode === "BUY" && transactionType !== "ExchTrade") {
    return {
      classification: "SECTION2_DUPLICATE",
      shouldImport: false,
      warningMessages: ["Section 2 buy duplicate skipped (base currency equivalent)"],
      originalRow: row,
    };
  }

  // Rule 10: FX Translation adjustments (ADJ)
  // These are accounting adjustments for FX translation P&L, not actual cash flows.
  // Skip to avoid affecting cash balance calculations.
  if (activityCode === "ADJ") {
    return {
      classification: "FX_ADJUSTMENT",
      shouldImport: false,
      warningMessages: ["FX translation adjustment skipped (accounting only)"],
      originalRow: row,
    };
  }

  // Unknown transaction type
  return {
    classification: "UNKNOWN",
    shouldImport: false,
    warningMessages: ["Unknown IBKR transaction type"],
    originalRow: row,
  };
}

/**
 * Convert classification to Wealthfolio activity type string
 */
function classificationToActivityType(
  classification: IBKRClassification["classification"],
): string {
  switch (classification) {
    case "STOCK_BUY":
      return "IBKR_BUY";
    case "STOCK_SELL":
      return "IBKR_SELL";
    case "DIVIDEND_PAYMENT":
      return "IBKR_DIVIDEND";
    case "DIVIDEND_TAX":
      return "IBKR_TAX";
    case "FEE":
      return "IBKR_FEE";
    case "DEPOSIT":
      return "IBKR_DEPOSIT";
    case "WITHDRAWAL":
      return "IBKR_WITHDRAWAL";
    case "FX_DEPOSIT":
      // Will be overridden to TRANSFER_IN in FX processing
      return "IBKR_TRANSFER_IN";
    case "FX_WITHDRAWAL":
      // Will be overridden to TRANSFER_OUT in FX processing
      return "IBKR_TRANSFER_OUT";
    case "TRANSFER_IN":
      return "IBKR_TRANSFER_IN";
    case "TRANSFER_OUT":
      return "IBKR_TRANSFER_OUT";
    case "INTEREST":
      return "IBKR_INTEREST";
    default:
      return "UNKNOWN";
  }
}

/**
 * Extract symbol from dividend description
 * e.g., "APLE(US03784Y2000) CASH DIVIDEND USD 0.05 PER SHARE - US TAX"
 * e.g., "BAKKAo(FO0000000179) CASH DIVIDEND NOK 13.37347 PER SHARE - FO TAX"
 * Returns: "APLE" or "BAKKA" (always uppercase)
 */
function extractSymbolFromDescription(description: string): string {
  const match = /^([A-Za-z0-9]+)\(/.exec(description);
  return match ? match[1].toUpperCase() : "";
}

/**
 * Extract dividend info for comment field
 * e.g., "USD 0.05 per share"
 */
function extractDividendInfo(description: string): string {
  const match = /CASH DIVIDEND (.+?)(?:\s*-|$)/i.exec(description);
  return match ? match[1].trim() : description;
}

/**
 * Get exchange name for a row, handling dividend vs trade column mapping
 *
 * For stock trades: Exchange column contains exchange name (e.g., "ASX", "LSE")
 * For dividends: Exchange column contains TransactionID, ListingExchange has the actual exchange
 */
function getExchangeField(row: IBKRTransactionRow): string | undefined {
  const listingExchange = row.ListingExchange?.trim();
  const exchange = row.Exchange?.trim();

  // If Exchange looks like a transaction ID (all digits), use ListingExchange instead
  if (exchange && /^\d+$/.test(exchange) && listingExchange) {
    return listingExchange;
  }

  // Otherwise use Exchange as normal
  return exchange || listingExchange;
}

/**
 * Get date field for a row, handling dividend vs trade column mapping
 *
 * For stock trades: TradeDate contains the date
 * For dividends: DateTime contains the date, Expiry contains the full datetime
 */
function getDateField(row: IBKRTransactionRow): string | undefined {
  const tradeDate = row.TradeDate?.trim();
  const dateTime = row.DateTime?.trim();

  // If TradeDate looks like a number (e.g., "-7.7"), it's a dividend row
  // In that case, use DateTime instead
  if (tradeDate && /^-?\d+\.?\d*$/.test(tradeDate)) {
    return dateTime;
  }

  // Otherwise use TradeDate as normal
  return tradeDate || dateTime;
}

/**
 * Get dividend amount from row
 *
 * IBKR puts dividend amounts in different columns depending on section:
 * - Section 1 (merged): TradeDate column contains amount (e.g., "-7.7" for withholding tax)
 * - Section 2 (Dividends): Amount column contains the value
 * Regular dividend amounts may also be in NetCash or TradeMoney fields
 */
function getDividendAmount(row: IBKRTransactionRow): string | undefined {
  const tradeDate = row.TradeDate?.trim();
  const netCash = row.NetCash?.trim();
  const amount = row.Amount?.trim();
  const tradeMoney = row.TradeMoney?.trim();

  // Check Amount field first (Section 2 dividends have amount here)
  if (amount && /^-?\d+\.?\d*$/.test(amount)) {
    return amount;
  }

  // Check TradeMoney (some rows have it here)
  if (tradeMoney && /^-?\d+\.?\d*$/.test(tradeMoney)) {
    return tradeMoney;
  }

  // If TradeDate contains a number (merged dividend row), use it as the amount
  if (tradeDate && /^-?\d+\.?\d*$/.test(tradeDate)) {
    return tradeDate;
  }

  // Otherwise try NetCash
  return netCash;
}

/**
 * Preprocess IBKR CSV data before validation
 *
 * @param data Raw CSV data
 * @returns Preprocessed data with _IBKR_TYPE column and filtered rows
 */
export function preprocessIBKRData(data: CsvRowData[]): {
  processedData: CsvRowData[];
  skipped: number;
  classifications: Map<string, number>;
} {
  const processedData: CsvRowData[] = [];
  let skippedCount = 0;
  const classifications = new Map<string, number>();

  for (const row of data) {
    const ibkrRow = asIBKRRow(row);
    const classification = classifyIBKRTransaction(ibkrRow);

    // Track classification stats
    const classType = classification.classification;
    classifications.set(classType, (classifications.get(classType) ?? 0) + 1);

    // Skip transactions that shouldn't be imported
    if (!classification.shouldImport) {
      skippedCount++;
      continue;
    }

    // Add computed _IBKR_TYPE column
    const processedRow: CsvRowData = {
      ...row,
      _IBKR_TYPE: classificationToActivityType(classification.classification),
    };

    // Normalize symbol to uppercase (IBKR sometimes provides mixed-case symbols like "BAKKAo")
    if (processedRow.Symbol && typeof processedRow.Symbol === "string") {
      processedRow.Symbol = processedRow.Symbol.toUpperCase();
    }

    // For cash transactions (FEE, DEPOSIT, WITHDRAWAL, TRANSFER_IN, TRANSFER_OUT, INTEREST, FX), add cash symbol
    if (
      ["FEE", "DEPOSIT", "WITHDRAWAL", "TRANSFER_IN", "TRANSFER_OUT", "INTEREST", "DIVIDEND_PAYMENT", "DIVIDEND_TAX", "FX_DEPOSIT", "FX_WITHDRAWAL"].includes(
        classification.classification,
      )
    ) {
      // For dividends/taxes, use special extraction logic due to shifted columns
      if (["DIVIDEND_PAYMENT", "DIVIDEND_TAX"].includes(classification.classification)) {
        // Get dividend amount from correct column (TradeDate for dividend rows)
        const dividendAmount = getDividendAmount(ibkrRow);
        if (dividendAmount) {
          processedRow.TradeMoney = dividendAmount;
        }

        // Get correct exchange name (ListingExchange for dividend rows)
        const exchange = getExchangeField(ibkrRow);
        if (exchange) {
          processedRow.Exchange = exchange;
        }

        // Get correct date (DateTime for dividend rows)
        const date = getDateField(ibkrRow);
        if (date) {
          processedRow.TradeDate = date;
        }

        // Try to extract symbol from description if missing
        if (!row.Symbol) {
          const extractedSymbol = extractSymbolFromDescription(row.Description || "");
          if (extractedSymbol) {
            processedRow.Symbol = extractedSymbol;
          }
        }

        processedRow.Quantity = "0";
        processedRow.TradePrice = "0";

        // Extract dividend info for comment
        if (classification.classification === "DIVIDEND_PAYMENT") {
          processedRow.Description = extractDividendInfo(row.Description || "");
        } else {
          // For tax, keep original description
          processedRow.Description = row.Description || "";
        }
      } else if (["DEPOSIT", "WITHDRAWAL"].includes(classification.classification)) {
        // For deposit/withdrawal transactions, CSV parser already maps data correctly:
        // - TradeMoney already contains the amount (e.g., "-1086", "0.01")
        // - TradeDate already contains the date (e.g., "2024-05-09")
        // No column shifting needed - the CSV parser handles it based on headers!

        // Set symbol to $CASH-{currency}
        const currency = row.CurrencyPrimary ?? "USD";
        processedRow.Symbol = `$CASH-${currency}`;
        processedRow.Quantity = "0";
        processedRow.TradePrice = "0";
      } else if (["TRANSFER_IN", "TRANSFER_OUT"].includes(classification.classification)) {
        // For cash transfers (from Section 3):
        // - TradeMoney already contains the transfer amount (mapped from CashTransfer)
        // - TradeDate contains the date (mapped from Date)
        // - _TRANSFER_DIRECTION contains "IN" or "OUT"
        //
        // IMPORTANT: Normalize TradeMoney to positive value.
        // The type (TRANSFER_IN vs TRANSFER_OUT) indicates direction.
        // This ensures consistent handling with FX transfers.

        // Set symbol to $CASH-{currency}
        const currency = row.CurrencyPrimary ?? "USD";
        processedRow.Symbol = `$CASH-${currency}`;
        processedRow.Quantity = "0";
        processedRow.TradePrice = "0";

        // Normalize TradeMoney to positive (direction indicated by type)
        const amount = normalizeNumericValue(row.TradeMoney);
        if (amount !== undefined) {
          processedRow.TradeMoney = Math.abs(amount).toString();
        }
      } else if (["FX_DEPOSIT", "FX_WITHDRAWAL"].includes(classification.classification)) {
        // For FX conversions (IDEALFX trades), we create linked TRANSFER_IN/TRANSFER_OUT pairs:
        // - Symbol is like "GBP.AUD" (source.target currency pair)
        // - TradeMoney is the target currency amount (negative for SELL, positive for BUY)
        // - TradePrice is the exchange rate
        // - CurrencyPrimary in the row is the TARGET currency
        // - Source amount = |TradeMoney| / TradePrice
        //
        // For SELL (FX_DEPOSIT): Selling GBP to get AUD (TradeMoney is negative AUD)
        //   - Source side: TRANSFER_OUT from GBP account (we're giving GBP)
        //   - Target side: TRANSFER_IN to AUD account (we're receiving AUD)
        //
        // For BUY (FX_WITHDRAWAL): Buying GBP with AUD (TradeMoney is positive AUD)
        //   - Source side: TRANSFER_IN to GBP account (we're receiving GBP)
        //   - Target side: TRANSFER_OUT from AUD account (we're giving AUD)
        //
        // Transfers are linked via matching Description/comment field
        //
        // IMPORTANT: FX commission is ALWAYS in the IBCommissionCurrency (the account's base currency).
        // We create a SEPARATE FEE activity for the commission to ensure it's deducted from the
        // correct currency account. The commission is NOT included in the transfer rows.

        const symbol = row.Symbol || "";
        const parts = symbol.split(".");
        const sourceCurrency = parts.length === 2 ? parts[0] : "USD";
        // Target currency is in CurrencyPrimary or second part of symbol
        const targetCurrency = row.CurrencyPrimary || (parts.length === 2 ? parts[1] : "USD");

        const tradeMoney = normalizeNumericValue(row.TradeMoney);
        const tradePrice = normalizeNumericValue(row.TradePrice);
        const tradeDate = row.Date || row.TradeDate || "";
        const tradeId = row.TradeID || "";

        // Handle FX commission - create separate FEE activity in the commission currency
        const ibCommission = normalizeNumericValue(row.IBCommission);
        const commissionCurrency = row.IBCommissionCurrency || sourceCurrency;

        // Build all related rows first to ensure atomic addition (prevents inconsistent state
        // if we add fee but fail before adding the transfer pair)
        const rowsToAdd: CsvRowData[] = [];

        if (ibCommission !== undefined && ibCommission !== 0) {
          const feeRow: CsvRowData = {
            ...row,
            CurrencyPrimary: commissionCurrency,
            Symbol: `$CASH-${commissionCurrency}`,
            TradeMoney: Math.abs(ibCommission).toString(),
            Quantity: "0",
            TradePrice: "0",
            IBCommission: "0", // Clear to prevent double-counting
            // Include tradeId in description to make each FX commission unique
            // (prevents false positive deduplication for multiple FX trades on same day)
            Description: `FX commission: ${symbol}:${tradeDate}:${tradeId}`,
            _IBKR_TYPE: "IBKR_FEE",
          };
          rowsToAdd.push(feeRow);
        }

        if (tradeMoney !== undefined && tradePrice !== undefined && tradePrice !== 0) {
          const targetAmount = Math.abs(tradeMoney);
          const sourceAmount = Math.abs(tradeMoney) / tradePrice;

          // Create linking reference for transfer pairing
          const transferRef = `FX:${symbol}:${tradeDate}:${tradeId}`;

          // Create SOURCE side transaction (without commission - it's in separate FEE)
          const sourceRow: CsvRowData = {
            ...row,
            CurrencyPrimary: sourceCurrency,
            Symbol: `$CASH-${sourceCurrency}`,
            TradeMoney: sourceAmount.toString(),
            Quantity: "0",
            TradePrice: "0",
            IBCommission: "0", // Clear - commission is in separate FEE activity
            Description: transferRef,
            // For SELL (FX_DEPOSIT to target): source side is TRANSFER_OUT (we're giving source currency)
            // For BUY (FX_WITHDRAWAL from target): source side is TRANSFER_IN (we're receiving source currency)
            _IBKR_TYPE: classification.classification === "FX_DEPOSIT" ? "IBKR_TRANSFER_OUT" : "IBKR_TRANSFER_IN",
          };
          rowsToAdd.push(sourceRow);

          // Set up TARGET side transaction (the current processedRow)
          processedRow.TradeMoney = targetAmount.toString();
          processedRow.CurrencyPrimary = targetCurrency;
          processedRow.Symbol = `$CASH-${targetCurrency}`;
          processedRow.Quantity = "0";
          processedRow.TradePrice = "0";
          processedRow.IBCommission = "0"; // Clear - commission is in separate FEE activity
          processedRow.Description = transferRef;
          // For SELL (FX_DEPOSIT): target side is TRANSFER_IN (we're receiving target currency)
          // For BUY (FX_WITHDRAWAL): target side is TRANSFER_OUT (we're giving target currency)
          processedRow._IBKR_TYPE = classification.classification === "FX_DEPOSIT" ? "IBKR_TRANSFER_IN" : "IBKR_TRANSFER_OUT";
        }

        // Add all rows atomically after successful preparation
        for (const rowToAdd of rowsToAdd) {
          processedData.push(rowToAdd);
        }
      } else {
        // For other cash transactions (FEE, INTEREST)
        // IBKR uses different fields depending on CSV section:
        // - trades section: Amount, Debit, or Credit fields
        // - dividends section: NetCash field
        // Try multiple fields to find the fee amount
        const feeAmount = row.Amount || row.Debit || row.NetCash;
        if (feeAmount) {
          processedRow.TradeMoney = feeAmount;
        }

        // Determine the correct currency for the symbol
        // For TTAX (Transaction Tax) at BaseCurrency level, the tax is in the
        // security's trading currency, not the base currency. Use ListingExchange
        // to determine the actual currency.
        // For DINT (Debit Interest), the currency is in the description (e.g., "USD Debit Interest").
        const activityCodeForCurrency = row.ActivityCode?.trim();
        const activityDesc = row.ActivityDescription || row.Description || "";
        let currency = row.CurrencyPrimary ?? "USD";

        // DINT: Parse currency from description (e.g., "USD Debit Interest for Dec-2024")
        if (activityCodeForCurrency === "DINT") {
          const dintMatch = /^([A-Z]{3}) Debit Int/i.exec(activityDesc);
          if (dintMatch) {
            currency = dintMatch[1];
          }
        }

        if (activityCodeForCurrency === "TTAX" && row.ListingExchange) {
          const exchangeCurrency = EXCHANGE_TO_CURRENCY[row.ListingExchange.trim()];
          if (exchangeCurrency) {
            currency = exchangeCurrency;
          }
        }

        // Set symbol to $CASH-{currency}
        processedRow.Symbol = `$CASH-${currency}`;
        processedRow.CurrencyPrimary = currency; // Also update CurrencyPrimary for consistency
        processedRow.Quantity = "0";
        processedRow.TradePrice = "0";
      }
    }

    // For BUY/SELL, ensure positive values (Wealthfolio expects absolute values)
    if (["STOCK_BUY", "STOCK_SELL"].includes(classification.classification)) {
      if (row.Quantity) {
        const qty = normalizeNumericValue(row.Quantity);
        if (qty !== undefined) {
          processedRow.Quantity = Math.abs(qty).toString();
        }
      }
      if (row.TradePrice) {
        const price = normalizeNumericValue(row.TradePrice);
        if (price !== undefined) {
          processedRow.TradePrice = Math.abs(price).toString();
        }
      }
      if (row.IBCommission) {
        const fee = normalizeNumericValue(row.IBCommission);
        if (fee !== undefined) {
          processedRow.IBCommission = Math.abs(fee).toString();
        }
      }
    }

    processedData.push(processedRow);
  }

  return {
    processedData,
    skipped: skippedCount,
    classifications,
  };
}


import { CsvRowData } from "../presets/types";

/**
 * Detects all unique currencies from IBKR CSV data
 *
 * Primary method: looks for Cash Report rows with LevelOfDetail = "Currency"
 * Fallback: detects currencies from CurrencyPrimary field on transaction rows
 *
 * @param parsedData - Array of parsed CSV rows
 * @returns Sorted array of unique currency codes
 */
export function detectCurrenciesFromIBKR(parsedData: CsvRowData[]): string[] {
  const currenciesSet = new Set<string>();

  // Primary method: summary section rows (LevelOfDetail = "Currency")
  for (const row of parsedData) {
    if (row.LevelOfDetail === "Currency") {
      const currency = row.CurrencyPrimary?.trim();
      if (currency && currency.length > 0 && currency !== "Currency") {
        currenciesSet.add(currency);
      }
    }
  }

  // Fallback: if no summary rows found, detect from CurrencyPrimary on all rows
  if (currenciesSet.size === 0) {
    for (const row of parsedData) {
      const currency = row.CurrencyPrimary?.trim();
      if (
        currency &&
        currency.length === 3 &&
        currency !== "Currency" &&
        /^[A-Z]{3}$/.test(currency)
      ) {
        currenciesSet.add(currency);
      }
    }
  }

  // Second fallback: check the Currency column directly
  if (currenciesSet.size === 0) {
    for (const row of parsedData) {
      const currency = row.Currency?.trim();
      if (
        currency &&
        currency.length === 3 &&
        /^[A-Z]{3}$/.test(currency)
      ) {
        currenciesSet.add(currency);
      }
    }
  }

  return Array.from(currenciesSet).sort();
}

# IBKR Multi-Currency Import Addon

A comprehensive import solution for Interactive Brokers (IBKR) activity statements with multi-currency support and Flex Query API integration.

> **This is a community fork** of [CoolONEOfficial/wealthfolio-ibkr-addon](https://github.com/CoolONEOfficial/wealthfolio-ibkr-addon), ported to Wealthfolio SDK 3.9.0 by [JinKanzaki](https://github.com/JinKanzaki) with assistance from Claude (Anthropic). The original addon was built for SDK 2.0 and stopped working with Wealthfolio 3.x. This fork fixes compatibility, adds FOREX transfer linking, and documents the exact Flex Query configuration required to make it work.
>
> **Honest disclosure:** This fork was almost entirely a trial-and-error process guided by Claude. It works, but treat it as community software — test it carefully before relying on it.

## What's Changed From the Original

- **SDK 3.9.0 compatibility** — fixed route registration, network API (`ctx.api.network` instead of `ctx.api.http`), permission declarations, and the `activities["import"]` keyword mangling bug
- **FOREX transfer linking** — automatically pairs EUR/USD, EUR/GBP etc. conversion legs using `linkTransfer`, eliminating "incomplete transfer" health center errors (146 → 6 unlinked rounding artifacts)
- **Required field fixes** — added `quoteCcy`, `instrumentType` fields required by Wealthfolio 3.9
- **Date format fix** — converts IBKR's YYYYMMDD format to YYYY-MM-DD
- **localStorage removed** — replaced with graceful no-op since addon sandbox blocks localStorage
- **Yahoo Finance CSP fix** — direct fetch calls to Yahoo Finance are blocked by Wealthfolio's Content Security Policy; patched to use fallback resolution instead
- **Form sandbox fix** — replaced `<form>` elements with `<div>` + onClick since sandbox blocks form submission
- **Symbol override** — added manual mapping for BRK B → BRK-B to prevent wrong ticker resolution
- **Flex Query configuration** — documented the exact setup that actually works (see below)

## Features

- **Flex Query API**: Automatically fetch transactions via IBKR Flex Query with configurable auto-fetch (max once per 6 hours)
- **CSV Import**: Upload multiple IBKR activity statement CSV files in a single import session
- **Multi-Currency Support**: Automatically detects currencies (EUR, USD, GBP, DKK etc.) and creates separate accounts per currency
- **FOREX Transfer Linking**: Automatically pairs currency conversion legs to prevent health center errors
- **Transaction Types**: Handles trades, dividends, fees, deposits, withdrawals, and transfers
- **Smart Deduplication**: Prevents duplicate imports on repeated syncs

## Requirements

- Wealthfolio **3.9.0 or later**
- Node.js **20+** (for building from source)
- pnpm (for building from source)

## Installation

### From GitHub Releases

1. Go to the [Releases](https://github.com/JinKanzaki/wealthfolio-ibkr-addon/releases) page
2. Download the latest `.zip` file
3. Open Wealthfolio → Settings → Add-ons
4. Click "Install from File" and select the downloaded ZIP
5. Click "Approve & Install" to grant required permissions

## Flex Query Setup (Important — Read This First)

The Flex Query configuration is critical. Use the wrong settings and the addon will either fail to import or import transactions incorrectly.

### Step 1: Create a Flex Query in IBKR

1. Log in to [IBKR Client Portal](https://www.interactivebrokers.com)
2. Navigate to **Reports → Flex Queries → Activity Flex Query**
3. Click **+** to create a new query
4. Give it a name (e.g. "Wealthfolio Import")

### Step 2: Enable These Sections

Enable the following sections (click each to expand and configure):

**Cash Report** ✓
- Options: **Currency Breakout** (not Base Currency Summary)
- Fields: **Currency**, **Level of Detail**
- This is required for currency detection

**Trades** ✓
- Options: **Execution**
- Fields: Click **Select All**

**Cash Transactions** ✓
- Options: **Dividends, Withholding Tax, Broker Fees, Deposits & Withdrawals, Detail**
- Fields: Click **Select All**

**Statement of Funds** ✓
- Options: **Base Currency Summary**
- Fields: Click **Select All**
- This section provides the FOREX conversion data

**Transfers** ✓ (optional but recommended)
- Options: **Transfer**
- Fields: Click **Select All**

> **Important:** For every section, click **Select All** fields. The addon needs `ClientAccountID` as the first column to correctly parse the CSV sections. Missing fields cause silent import failures.

### Step 3: Delivery Settings

| Setting | Value |
|---------|-------|
| **Format** | CSV |
| **Include header and trailer records?** | No |
| **Include column headers?** | Yes |
| **Display single column header row?** | No (important) |
| **Include section code and line descriptor?** | No |
| **Period** | Last 365 Calendar Days |

### Step 4: Date/Time Format

| Setting | Value |
|---------|-------|
| **Date Format** | `yyyyMMdd` (no dashes — IBKR default) |
| **Time Format** | `HHmmss` |
| **Date/Time Separator** | `;` |
| **Include Canceled Trades?** | No |

### Step 5: Get Your Flex Token

1. In IBKR Client Portal, go to **Reports → Flex Queries**
2. Scroll to **Flex Web Service** at the bottom
3. Click **Generate Token** or copy your existing token

### Step 6: Note Your Query ID

After saving the Flex Query, the Query ID appears at the top of the query details page. You'll need this in Wealthfolio.

### Step 7: Configure in Wealthfolio

1. Open Wealthfolio → **IBKR Settings** (sidebar)
2. Enter your **Flex Web Service Token**
3. Click **Add Query**
4. Enter your **Query ID** and give it a name
5. Enable **Auto-fetch** if you want automatic syncing

## Usage

### First Import

1. Go to **IBKR Import** in the sidebar
2. Select **Flex Query API** (or CSV if preferred)
3. Enter account group name — use `IBKR` (this creates accounts like "IBKR - EUR", "IBKR - USD" etc.)
4. Click through the wizard — review currencies, preview transactions, import
5. After import, the addon automatically links FOREX transfer pairs

### Subsequent Imports

With auto-fetch enabled, the addon will automatically fetch and import new transactions whenever Wealthfolio's portfolio updates (max once per 6 hours). Deduplication prevents re-importing existing transactions.

## Known Limitations

- **6 unlinked FOREX transfers**: Tiny rounding/remainder legs from currency conversions (~$0.01-$1.00) may remain unlinked in the Health Center. Mark these as "External" manually — they have no meaningful impact on returns.
- **Ticker resolution**: Without Yahoo Finance API access (blocked by CSP), ticker resolution falls back to Wealthfolio's built-in search and symbol+exchange matching. Most common stocks resolve correctly. For any that don't, edit the asset manually in Wealthfolio.
- **BRK B**: Mapped to BRK-B via hardcoded override. Other unusual tickers may need manual correction.

## Supported Transaction Types

| IBKR Type | Wealthfolio Type |
|-----------|-----------------|
| BUY | BUY |
| SELL | SELL |
| DIV | DIVIDEND |
| FRTAX / TTAX | TAX |
| OFEE | FEE |
| DEP | DEPOSIT |
| WITH | WITHDRAWAL |
| FOREX | TRANSFER_IN / TRANSFER_OUT (linked pairs) |

## Permissions

| Permission | Purpose |
|------------|---------|
| accounts.getAll, accounts.create | Create multi-currency accounts |
| activities.import, activities.getAll | Import and fetch transactions |
| activities.linkTransfer | Pair FOREX conversion legs |
| market-data.searchTicker | Resolve ticker symbols |
| secrets.get/set/delete | Store Flex Query credentials |
| events.onUpdateComplete | Trigger auto-fetch |
| network.request | Fetch from IBKR Flex API |

## Building From Source

```bash
# Clone
git clone https://github.com/JinKanzaki/wealthfolio-ibkr-addon.git
cd wealthfolio-ibkr-addon

# Install dependencies (requires Node.js 20+)
npm install -g pnpm
pnpm approve-builds  # approve esbuild
pnpm install

# Build and package
npm run bundle
# ZIP created at dist/wealthfolio-ibkr-addon-*.zip
```

## Troubleshooting

**"0 currencies detected"**
→ Make sure you enabled the Cash Report section with Currency Breakout option and all fields selected

**"No transaction section found"**
→ Make sure ClientAccountID is included in your Flex Query fields (Select All covers this)

**Activities imported but not showing**
→ Make sure your IBKR accounts are set to "Transactions" tracking mode in Wealthfolio

**Ticker resolves to wrong stock**
→ Edit the asset in Wealthfolio → Securities and correct the symbol manually

**"Addon permission denied"**
→ Uninstall and reinstall the addon, then approve all permissions when prompted

## License

MIT License — see [LICENSE](LICENSE) for details.

## Credits

- Original addon: [Nikolai Trukhin (CoolONEOfficial)](https://github.com/CoolONEOfficial/wealthfolio-ibkr-addon)
- SDK 3.9 port and FOREX linking: [JinKanzaki](https://github.com/JinKanzaki) with [Claude](https://claude.ai) (Anthropic)

## Links

- [Original Repository](https://github.com/CoolONEOfficial/wealthfolio-ibkr-addon)
- [This Fork](https://github.com/JinKanzaki/wealthfolio-ibkr-addon)
- [Issue Tracker](https://github.com/JinKanzaki/wealthfolio-ibkr-addon/issues)
- [Wealthfolio](https://wealthfolio.app)

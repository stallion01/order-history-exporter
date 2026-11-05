# Order History Exporter

A free, open-source Chrome extension that exports your own purchase history from online stores to a CSV file. Pick the stores, pick a year or date range, and download.

| Store | How it reads orders | Tested against live pages? |
| --- | --- | --- |
| Amazon (.com) | Order list and order detail pages | Yes, on one account |
| eBay (.com) | eBay's JSON endpoint, falling back to pages | Yes, on one account |
| Walmart | Order list and order detail pages | Yes, on one account |
| Sam's Club | Same parser as Walmart | Yes, on one account |
| Newegg | Order list (using its year dropdown) and order detail pages | Yes, on one account |
| Home Depot | Purchase history table and order detail pages | Yes, on one Pro Xtra account |

> **Status: early version.** Each store has been run on one real account, and the automated tests use made-up sample pages. Stores change their pages often, and other accounts may see layouts this one didn't. If a store fails, the extension tells you, and you can [report it](#when-a-store-stops-working).

## Privacy

- Your orders are read in your own browser, using the accounts you're already signed in to.
- Nothing is uploaded. The extension has no server, analytics or tracking.
- It never sees your password. If a store asks you to sign in, you do that yourself on the store's page.
- Only your export settings are saved. Order data stays in memory until you close the page or download the CSV.

## Install

The extension isn't on the Chrome Web Store, so you load it from this folder:

1. Download or clone this repository.
2. Go to `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder (the one containing `manifest.json`).
4. Pin the extension and click its icon to open the exporter.

## Use

1. Choose the stores, the period and the CSV layout.
2. Click **Start export**. A separate browser window opens and steps through your order pages. You can leave it running in the background, but don't close it.
3. If a store asks you to sign in, enter a code sent by text or email, or complete a security check, do it in that window and press **Continue**. The extension can't do these for you or skip them.
4. Review the preview and click **Download CSV**.

Pages load one at a time with a pause between them, so large histories take a while. Turning off **Open each order** is much faster, but you lose item prices, tax and shipping.

## CSV layouts

- **One row per item:** `Store, Order Date, Order ID, Status, Item, Quantity, Item Price, Seller, Order Subtotal, Tax, Shipping, Order Total, Payment Method, Delivery Address, Delivery ZIP, Currency, Item URL, Order URL`. Order-level amounts appear on each order's first row only, so summing a column never double counts.
- **One row per order:** one line per order, with item names joined by `;`.

Dates are `YYYY-MM-DD`. Text that a spreadsheet could run as a formula is prefixed with `'`.

**Payment Method** shows values like `Visa ending 1234`, `Cash` or `Visa ending 1234; Gift card`. The extension only ever keeps a card's brand and last four digits.

**Delivery Address** runs from the street to the ZIP and leaves out the recipient's name, and **Delivery ZIP** holds the ZIP alone. They cover US addresses, and stay blank for pickup and in-store orders.

Both need **Open each order** turned on. Treat the CSV as private, since it shows where you live and what you bought.

Excel drops leading zeros when it opens a CSV directly, so `02134` displays as `2134`. To keep them, use **Data > From Text/CSV** in Excel and set Delivery ZIP to Text.

## Known limits

- Only the US sites are supported so far.
- Amazon digital orders (Kindle, video) have a separate listing and aren't included.
- eBay's year filter reaches back 22 years, and eBay's JSON endpoint is undocumented.
- Home Depot's history reaches back 7 years, and has only been checked with a Pro Xtra account.
- Newegg's details page covers a whole checkout. For a checkout with several orders, tax, shipping and item prices aren't split per order, so those stay blank and the order's total comes from the list.
- Orders with no readable date are left out of date-limited exports, and the results page tells you how many.

## When a store stops working

The results page says when a page couldn't be read and offers a **redacted copy of the page**. It masks text, zeroes digits and removes form values, keeping the structure needed to fix the parser. Please open the file and check it yourself before attaching it to an issue.

## Terms of use

This tool is for exporting your own data from your own accounts, at a deliberately slow pace. Automated access may still conflict with a store's terms of service, so check them and use it at your own risk. This project isn't affiliated with any of these stores.

## Development

```bash
npm install
```

```bash
npm test
```

```bash
npx playwright install chromium
```

```bash
npm run test:e2e
```

The extension itself has no dependencies and no build step. `npm install` is only for the tests. See [CONTRIBUTING.md](CONTRIBUTING.md) to add a store.

## Acknowledgements

Studying these projects helped confirm how the stores' pages and data are laid out. No code was copied from them.

- [Amazon Order History Reporter (Azad)](https://github.com/philipmulcahy/azad)
- Ebay Purchase History Downloader

## Licence

Copyright (C) 2026 Raj Chacko

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the [GNU General Public License](LICENSE) for more details.

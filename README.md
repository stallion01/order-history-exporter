# Order History Exporter

A free, open-source Chrome extension that collects your own purchase history from online stores into a database on your own machine, with a reports page and CSV downloads. Repeat runs read only what's new or missing. It can also export straight to a CSV file with no database.

| Store | How it reads orders | Tested against live pages? |
| --- | --- | --- |
| Amazon (.com) | Order list and order detail pages | Yes, on one account |
| eBay (.com) | eBay's JSON endpoint, falling back to pages | Yes, on one account |
| Walmart | Order list and order detail pages | Yes, on one account |
| Sam's Club | Same parser as Walmart | Yes, on one account |
| Newegg | Order list (using its year dropdown) and order detail pages | Yes, on one account |
| Home Depot | Purchase history table and order detail pages | Yes, on one Pro Xtra account |

> **Status: early version.** Each store has been run on one real account, and the automated tests use made-up sample pages. Syncing to the database, with categories and tax groups, has been tested live with Sam's Club so far. Stores change their pages often, and other accounts may see layouts this one didn't. If a store fails, the extension tells you, and you can [report it](#when-a-store-stops-working).

## Privacy

- Your orders are read in your own browser, using the accounts you're already signed in to.
- There are no analytics or tracking, and no service run by this project. Your orders only go to the database server you set up, if you use one.
- It never sees your password. If a store asks you to sign in, you do that yourself on the store's page.
- The database holds your purchases, delivery addresses and the last four digits of your cards, unencrypted, so keep it somewhere private. It lives in `server/data/`, which git ignores.
- In CSV-only mode, order data stays in memory until you close the page or download the file.

## Install

The extension isn't on the Chrome Web Store, so you load it from this folder:

1. Download or clone this repository.
2. Go to `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder (the one containing `manifest.json`).
4. Pin the extension and click its icon to open the exporter.

## Set up the database

The database is [SQLite](https://sqlite.org): a single file, with no database software to install or administer. A small server that comes with this project looks after it and serves the reports page. It needs [Node.js](https://nodejs.org) 22.13 or newer and has no other dependencies.

```bash
npm run server
```

The server prints its address and an **access token**. It must be running while you sync or view reports. Then, in the extension:

1. Reload it at `chrome://extensions` if you've just updated it, so Chrome grants its permissions.
2. Under **Save to**, choose **Database**, and enter the server address and token.
3. Press **Test connection**.

## Use

1. Choose the stores and the period.
2. Click **Start export**. A separate browser window opens and steps through your order pages. You can leave it running in the background, but don't close it.
3. If a store asks you to sign in, enter a code sent by text or email, or complete a security check, do it in that window and press **Continue**. The extension can't do these for you or skip them.
4. Press **Open reports**, or go to the server's address.

Pages load one at a time with a pause between them, so a first run over a large history takes a while. Orders are saved as they're read, so you can stop at any time and carry on later. Turning off **Open each order** is much faster, but you lose item prices, tax, shipping, payment method and delivery address until a later run with it on.

### What a repeat run reads

- **Periods never fully read.** Each store's finished date ranges are recorded. A range only counts if it was read to the end, so one that was stopped or failed is read again.
- **The last 60 days,** because recent orders change when they're delivered or returned.
- **Details still missing.** Orders whose details page was never read are tried again, up to three failures.
- **Changed orders.** If a list shows a new status or total, that order's details are re-read.

Everything else is skipped. To read a period again regardless, for example after a store's parser is improved, tick **Re-read everything in this period**. Existing values are never blanked by a later read.

### Reports

The reports page has three tabs, all filtered by period, store, category, delivery ZIP, payment method or text. Click a column heading to sort by it.

- **Overview:** total spending, tax, spending by month, category, store, payment method and delivery ZIP, your most-bought items, a list of orders, and each store's sync status.
- **Items:** every purchased item, sortable by category, ZIP, amount and more, where you can correct its category or mark it business or personal.
- **Tax groups:** business purchases grouped by form line. See below.

Each tab has CSV downloads for what it's showing.

Money figures add up each order's total, and returns count as negatives. An item's amount is its share of what the order actually cost, including tax and shipping, so items add up to the order total. If an order has no item prices yet, its total is split evenly and marked as an estimate. Totals assume a single currency.

### Categories

Items are categorized on your own machine, and nothing is sent to an outside service. An item's category comes from, in order: your own correction, what your corrections have taught about similar names, keywords in its name, and finally a weak guess from the store. The Items tab shows which one applied.

Correcting an item applies to every item with the same name. After two corrected items share a word, other items containing it follow too. You can add your own categories on the Tax groups tab.

Delivery ZIP comes from the order's delivery address, so in-store, pickup and fuel purchases don't have one.

### Tax groups

This groups purchases to help you or your tax preparer. **It isn't tax advice, and it can't tell whether a purchase is deductible.** The exports are CSV files for a preparer or for reference. Tax software generally can't import them directly.

1. **Mark purchases business or personal.** Only business items are counted. Add rules on the Tax groups tab, such as "everything delivered to this ZIP" or "everything on this card", or mark items on the Items tab. Your own mark always wins, and a personal rule beats a business one.
2. **Choose a form:** Schedule C for a business, or Schedule E for rental property. Filter by ZIP to see one property or location.
3. **Check the category to form line suggestions.** They're starting points, and you should change them to match how you file. Categories with no sensible default, such as Grocery, stay unassigned until you choose.
4. **Download** the summary, which has one row per form line, or the itemized list behind it.

Things to raise with your preparer:

- The lines follow the 2025 forms, so check them against the year you're filing.
- Items of $2,500 or more are listed for review, because they may need depreciating. That's the usual limit for the de minimis safe harbor election.
- Business meals are usually only 50% deductible, and fuel can't be claimed alongside the standard mileage rate. Amounts are shown in full.
- Partial business use isn't handled: an item counts entirely as business or not at all.

### Running the database on your network

SQLite is a file rather than a network service, so this project's server is what other computers connect to. To serve your network from this computer, or from a Linux box:

```bash
npm run server:network
```

It prints a **Server URL** with this machine's network address. Put that URL and the access token into the extension on any computer, and press **Test connection**. Chrome will ask to allow that address. Open the same URL in a browser for the reports page. If other computers can't connect, your firewall may need to allow the port (8787 by default).

Only one server should use the database file at a time. Don't put it in a shared folder for several servers to open, because SQLite isn't safe to use that way over network file shares.

**Security on a network:**

- Every request needs the access token, and connections from public internet addresses are refused unless you set `OHE_ALLOW_PUBLIC_CLIENTS=1`.
- **The connection isn't encrypted by default.** Anyone who can watch traffic on that network could read your token and orders, so use it only on a network you trust, such as your home network and not public Wi-Fi.
- For encryption, set `OHE_TLS_CERT` and `OHE_TLS_KEY` to certificate files that your computers trust, use an SSH tunnel, or use an HTTPS reverse proxy.
- Never forward this port from your router to the internet.

An SSH tunnel leaves the server local-only, and you keep using `http://127.0.0.1:8787` in the extension:

```bash
ssh -N -L 8787:127.0.0.1:8787 you@your-server
```

With an HTTPS reverse proxy such as Caddy or nginx, set `OHE_PUBLIC_HOST` to its host name and use the `https://` address in the extension.

To set it up on Linux, install Node.js 22.13 or newer and copy this repository across. Stop the server on your PC before copying `server/data/`. `deploy/order-history-server.service` is a systemd service with install steps at the top. The settings are environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OHE_PORT` | `8787` | Port to listen on |
| `OHE_HOST` | `127.0.0.1` (`0.0.0.0` with `--network`) | Address to listen on |
| `OHE_DATA_DIR` | `server/data` | Where the database and token are kept |
| `OHE_PUBLIC_HOST` | none | Extra address to accept requests for, such as `orders.example.com` |
| `OHE_TLS_CERT`, `OHE_TLS_KEY` | none | Certificate and key files, to serve HTTPS |
| `OHE_ALLOW_PUBLIC_CLIENTS` | off | Set to `1` to accept connections from public addresses |

### Backups

Stop the server and copy the `server/data/` folder. Upgrades that change the database make their own copy first, as `orders.db.before-v2.bak` and so on. To change the token, delete `server/data/token` and restart.

### CSV only

Choose **CSV file only** under **Save to** to skip the database. Each run then reads the whole period and offers a **Download CSV** button.

## CSV layouts

- **One row per item:** `Store, Order Date, Order ID, Status, Item, Category, Quantity, Item Price, Seller, Order Subtotal, Tax, Shipping, Order Total, Payment Method, Delivery Address, Delivery ZIP, Currency, Item URL, Order URL`. Order-level amounts appear on each order's first row only, so summing a column never double counts.
- **One row per order:** one line per order, with item names joined by `;`.

Dates are `YYYY-MM-DD`. Text that a spreadsheet could run as a formula is prefixed with `'`.

**Payment Method** shows values like `Visa ending 1234`, `Cash` or `Visa ending 1234; Gift card`. The extension only ever keeps a card's brand and last four digits.

**Delivery Address** runs from the street to the ZIP and leaves out the recipient's name, and **Delivery ZIP** holds the ZIP alone. They cover US addresses, and stay blank for pickup and in-store orders.

Both need **Open each order** turned on. On a repeat run with the database, those columns stay as they were first read unless the order changes. Treat the CSV as private, since it shows where you live and what you bought.

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

// The order database: one SQLite file, using the SQLite built into Node.
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const OHE = require('./core');
const { CATEGORIES, UNCATEGORIZED, createClassifier, nameKey } = require('./categories');
const tax = require('./tax');

const RECHECK_DAYS = 60;
const MAX_DETAIL_ATTEMPTS = 3;
const SCHEMA_VERSION = 22;

const SCHEMA_V1 = `
  CREATE TABLE orders (
    store TEXT NOT NULL,
    order_id TEXT NOT NULL,
    store_name TEXT,
    order_date TEXT,
    status TEXT,
    subtotal REAL,
    tax REAL,
    shipping REAL,
    total REAL,
    currency TEXT,
    payment TEXT,
    delivery_address TEXT,
    delivery_zip TEXT,
    url TEXT,
    detail_url TEXT,
    list_fingerprint TEXT,
    detail_fetched_at TEXT,
    detail_attempts INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (store, order_id)
  );
  CREATE INDEX orders_date ON orders (order_date);

  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    store TEXT NOT NULL,
    order_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    name TEXT,
    quantity REAL,
    price REAL,
    seller TEXT,
    url TEXT,
    FOREIGN KEY (store, order_id) REFERENCES orders (store, order_id) ON DELETE CASCADE
  );
  CREATE INDEX items_order ON items (store, order_id);

  CREATE TABLE sync_coverage (
    store TEXT NOT NULL,
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    PRIMARY KEY (store, from_date)
  );

  CREATE TABLE sync_runs (
    id INTEGER PRIMARY KEY,
    store TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    range_from TEXT,
    range_to TEXT,
    new_orders INTEGER NOT NULL DEFAULT 0,
    updated_orders INTEGER NOT NULL DEFAULT 0,
    details_read INTEGER NOT NULL DEFAULT 0,
    details_missed INTEGER NOT NULL DEFAULT 0,
    complete INTEGER NOT NULL DEFAULT 0
  );
`;

// Corrections and marks are keyed by item name, because item rows are replaced
// whenever an order's details are re-read.
const SCHEMA_V2 = `
  ALTER TABLE items ADD COLUMN line_total REAL;

  CREATE TABLE categories (
    name TEXT PRIMARY KEY,
    schedule_c TEXT,
    schedule_e TEXT,
    position INTEGER NOT NULL
  );

  CREATE TABLE category_overrides (
    name_key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL
  );

  CREATE TABLE item_marks (
    store TEXT NOT NULL,
    order_id TEXT NOT NULL,
    name_key TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (store, order_id, name_key)
  );

  CREATE TABLE tax_rules (
    id INTEGER PRIMARY KEY,
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    status TEXT NOT NULL,
    UNIQUE (field, value)
  );
`;

// Sign-in and an audit trail for the web app. Session ids are stored hashed, so a
// copy of the database can't be used to sign in.
const SCHEMA_V3 = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    totp_secret TEXT,
    totp_pending TEXT,
    totp_last_step INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    user_agent TEXT
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    username TEXT,
    action TEXT NOT NULL,
    detail TEXT
  );
`;

// Bank and card accounts and their transactions (Phase 2). Each transaction keeps
// every source that reported it (SimpleFIN, an OFX/QFX file, a CSV file), so the same
// payment arriving from two sources is stored once. Account numbers are never kept:
// only the last four digits, and a hash to recognise the account in later files.
const SCHEMA_V5 = `
  CREATE TABLE bank_accounts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    institution TEXT,
    kind TEXT NOT NULL DEFAULT 'checking',
    owner TEXT NOT NULL DEFAULT 'mixed',
    last4 TEXT,
    currency TEXT NOT NULL DEFAULT 'USD',
    simplefin_id TEXT UNIQUE,
    file_key TEXT,
    balance REAL,
    balance_date TEXT,
    last_synced_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE bank_transactions (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES bank_accounts (id) ON DELETE CASCADE,
    posted TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT NOT NULL,
    payee TEXT,
    memo TEXT,
    kind TEXT NOT NULL DEFAULT 'normal',
    kind_source TEXT,
    transfer_id INTEGER REFERENCES bank_transactions (id) ON DELETE SET NULL,
    category TEXT,
    category_source TEXT,
    status TEXT,
    status_source TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX bank_tx_account_posted ON bank_transactions (account_id, posted);
  CREATE INDEX bank_tx_posted ON bank_transactions (posted);

  CREATE TABLE bank_tx_sources (
    account_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    transaction_id INTEGER NOT NULL REFERENCES bank_transactions (id) ON DELETE CASCADE,
    PRIMARY KEY (account_id, source, external_id)
  );
  CREATE INDEX bank_tx_sources_tx ON bank_tx_sources (transaction_id);

  CREATE TABLE bank_rules (
    id INTEGER PRIMARY KEY,
    pattern TEXT NOT NULL,
    account_id INTEGER REFERENCES bank_accounts (id) ON DELETE CASCADE,
    category TEXT,
    status TEXT,
    kind TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE bank_imports (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    username TEXT,
    source TEXT NOT NULL,
    file_name TEXT,
    account_id INTEGER REFERENCES bank_accounts (id) ON DELETE SET NULL,
    added INTEGER NOT NULL DEFAULT 0,
    merged INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    first_date TEXT,
    last_date TEXT
  );

  CREATE TABLE csv_layouts (
    signature TEXT PRIMARY KEY,
    mapping TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

// Which transactions each import added, matched to ones already there, or skipped as
// already imported, so an import's result can be listed.
const SCHEMA_V6 = `
  CREATE TABLE bank_import_rows (
    import_id INTEGER NOT NULL REFERENCES bank_imports (id) ON DELETE CASCADE,
    transaction_id INTEGER NOT NULL REFERENCES bank_transactions (id) ON DELETE CASCADE,
    outcome TEXT NOT NULL,
    PRIMARY KEY (import_id, transaction_id)
  );
  CREATE INDEX bank_import_rows_tx ON bank_import_rows (transaction_id);
`;

// Receipts (Phase 3): the photo or PDF lives in the data folder; what was read from
// it, and the transaction it belongs to, live here.
const SCHEMA_V7 = `
  CREATE TABLE receipts (
    id INTEGER PRIMARY KEY,
    original_hash TEXT NOT NULL UNIQUE,
    file_name TEXT,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    stored_path TEXT NOT NULL,
    thumb_path TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    read_error TEXT,
    read_at TEXT,
    read_model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    vendor TEXT,
    receipt_date TEXT,
    currency TEXT,
    subtotal REAL,
    tax REAL,
    tip REAL,
    total REAL,
    card_last4 TEXT,
    payment_method TEXT,
    category TEXT,
    items TEXT,
    confidence TEXT,
    reader_notes TEXT,
    note TEXT,
    checked INTEGER NOT NULL DEFAULT 0,
    transaction_id INTEGER REFERENCES bank_transactions (id) ON DELETE SET NULL,
    match_source TEXT,
    uploaded_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX receipts_tx ON receipts (transaction_id);
  CREATE INDEX receipts_date ON receipts (receipt_date);
`;

// ZIP codes are kept as five digits (ZIP+4 is trimmed), and each can be given a name.
const SCHEMA_V8 = `
  CREATE TABLE zip_names (
    zip TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  UPDATE orders SET delivery_zip = substr(delivery_zip, 1, 5) WHERE delivery_zip GLOB '[0-9][0-9][0-9][0-9][0-9]-*';
  UPDATE OR IGNORE tax_rules SET value = substr(value, 1, 5) WHERE field = 'zip' AND value GLOB '[0-9][0-9][0-9][0-9][0-9]-*';
  DELETE FROM tax_rules WHERE field = 'zip' AND value GLOB '[0-9][0-9][0-9][0-9][0-9]-*';
`;

// Phase 4: store orders linked to the card charges that paid for them, and the
// businesses and properties ("entities") spending belongs to. A transaction belongs
// to one entity, or is shared between several by percentage.
const SCHEMA_V9 = `
  CREATE TABLE entities (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind TEXT NOT NULL DEFAULT 'business',
    created_at TEXT NOT NULL
  );

  ALTER TABLE bank_accounts ADD COLUMN entity_id INTEGER REFERENCES entities (id) ON DELETE SET NULL;
  ALTER TABLE bank_rules ADD COLUMN entity_id INTEGER REFERENCES entities (id) ON DELETE SET NULL;
  ALTER TABLE bank_rules ADD COLUMN shared_entities TEXT;
  ALTER TABLE bank_transactions ADD COLUMN entity_id INTEGER REFERENCES entities (id) ON DELETE SET NULL;
  ALTER TABLE bank_transactions ADD COLUMN entity_source TEXT;

  CREATE TABLE tx_entity_shares (
    transaction_id INTEGER NOT NULL REFERENCES bank_transactions (id) ON DELETE CASCADE,
    entity_id INTEGER NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
    percent REAL NOT NULL,
    PRIMARY KEY (transaction_id, entity_id)
  );

  CREATE TABLE place_entities (
    zip TEXT PRIMARY KEY,
    entity_id INTEGER NOT NULL REFERENCES entities (id) ON DELETE CASCADE
  );

  CREATE TABLE order_links (
    transaction_id INTEGER NOT NULL REFERENCES bank_transactions (id) ON DELETE CASCADE,
    store TEXT NOT NULL,
    order_id TEXT NOT NULL,
    amount REAL NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (transaction_id, store, order_id),
    FOREIGN KEY (store, order_id) REFERENCES orders (store, order_id) ON DELETE CASCADE
  );
  CREATE INDEX order_links_order ON order_links (store, order_id);

  -- Pairs the user unlinked, so they aren't matched again automatically.
  CREATE TABLE order_link_rejections (
    transaction_id INTEGER NOT NULL REFERENCES bank_transactions (id) ON DELETE CASCADE,
    store TEXT NOT NULL,
    order_id TEXT NOT NULL,
    PRIMARY KEY (transaction_id, store, order_id)
  );
`;

// Phase 5: what kind of cost each category is (operating, cost of goods sold),
// the register of capital assets, and large purchases the user decided aren't
// capital, so they stop being flagged.
const SCHEMA_V10 = `
  ALTER TABLE categories ADD COLUMN expense_class TEXT NOT NULL DEFAULT 'opex';

  CREATE TABLE assets (
    id INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    cost REAL NOT NULL,
    placed_in_service TEXT NOT NULL,
    entity_id INTEGER REFERENCES entities (id) ON DELETE SET NULL,
    recovery TEXT,
    transaction_id INTEGER REFERENCES bank_transactions (id) ON DELETE SET NULL,
    item_key TEXT,
    note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX assets_source ON assets (transaction_id, COALESCE(item_key, '')) WHERE transaction_id IS NOT NULL;

  CREATE TABLE capital_reviews (
    key TEXT PRIMARY KEY,
    decided_at TEXT NOT NULL
  );
`;

// Who confirmed a receipt: the user, or the reader when it was sure of everything.
const SCHEMA_V11 = `
  ALTER TABLE receipts ADD COLUMN checked_by TEXT;
  UPDATE receipts SET checked_by = 'user' WHERE checked = 1;
`;

// Stays from Hospitable: the properties, each reservation with its guest and money,
// Airbnb's payouts and what each paid for, and which bank deposit brought the money in.
const SCHEMA_V12 = `
  CREATE TABLE stay_properties (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    public_name TEXT,
    city TEXT,
    state TEXT,
    synced_at TEXT NOT NULL
  );

  CREATE TABLE stays (
    id TEXT PRIMARY KEY,
    code TEXT,
    platform TEXT NOT NULL,
    property_id TEXT REFERENCES stay_properties (id) ON DELETE SET NULL,
    status TEXT NOT NULL,
    booked_at TEXT,
    arrival TEXT NOT NULL,
    departure TEXT NOT NULL,
    check_in TEXT,
    check_out TEXT,
    nights INTEGER NOT NULL DEFAULT 0,
    guest_first TEXT,
    guest_last TEXT,
    guest_email TEXT,
    guest_phone TEXT,
    guest_location TEXT,
    adults INTEGER,
    children INTEGER,
    infants INTEGER,
    pets INTEGER,
    currency TEXT NOT NULL DEFAULT 'USD',
    guest_total REAL,
    accommodation REAL,
    cleaning REAL,
    host_fees REAL,
    taxes REAL,
    payout REAL,
    financials TEXT,
    note TEXT,
    synced_at TEXT NOT NULL
  );
  CREATE INDEX stays_arrival ON stays (arrival);

  CREATE TABLE stay_payouts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    amount REAL NOT NULL,
    paid_on TEXT NOT NULL,
    bank_account TEXT,
    transaction_id INTEGER REFERENCES bank_transactions (id) ON DELETE SET NULL,
    match_source TEXT,
    synced_at TEXT NOT NULL
  );
  CREATE INDEX stay_payouts_tx ON stay_payouts (transaction_id);

  CREATE TABLE stay_payout_lines (
    id TEXT PRIMARY KEY,
    payout_id TEXT NOT NULL REFERENCES stay_payouts (id) ON DELETE CASCADE,
    stay_id TEXT REFERENCES stays (id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    posted TEXT
  );
  CREATE INDEX stay_payout_lines_stay ON stay_payout_lines (stay_id);

  -- Deposits for stays Hospitable has no payout for (Vrbo, Booking.com, direct).
  CREATE TABLE stay_deposits (
    stay_id TEXT NOT NULL REFERENCES stays (id) ON DELETE CASCADE,
    transaction_id INTEGER NOT NULL REFERENCES bank_transactions (id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (stay_id, transaction_id)
  );
  CREATE INDEX stay_deposits_tx ON stay_deposits (transaction_id);

  -- Matches the user turned down, so they aren't offered or made again.
  CREATE TABLE stay_link_rejections (
    subject TEXT NOT NULL,
    transaction_id INTEGER NOT NULL REFERENCES bank_transactions (id) ON DELETE CASCADE,
    PRIMARY KEY (subject, transaction_id)
  );
`;

// Deposits that could be made up of payouts or stays in more than one way. Worked out
// again after every sync and import; the user settles them by linking one way.
const SCHEMA_V13 = `
  CREATE TABLE stay_conflicts (
    subject TEXT NOT NULL,
    transaction_id INTEGER NOT NULL REFERENCES bank_transactions (id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    options TEXT NOT NULL,
    PRIMARY KEY (subject, transaction_id)
  );
`;

// A deposit can be shared between stays, each taking part of it, and part can be a
// security deposit; a refund (money out) can be linked against that. Each link now
// says how much and what for. Existing links keep the whole deposit, or each stay's
// expected amount where one deposit paid for several.
const SCHEMA_V14 = `
  CREATE TABLE stay_deposits_new (
    id INTEGER PRIMARY KEY,
    stay_id TEXT NOT NULL REFERENCES stays (id) ON DELETE CASCADE,
    transaction_id INTEGER NOT NULL REFERENCES bank_transactions (id) ON DELETE CASCADE,
    purpose TEXT NOT NULL DEFAULT 'stay',
    amount REAL NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (stay_id, transaction_id, purpose)
  );
  INSERT INTO stay_deposits_new (stay_id, transaction_id, purpose, amount, source, created_at)
    SELECT d.stay_id, d.transaction_id, 'stay',
      CASE WHEN (SELECT COUNT(*) FROM stay_deposits o WHERE o.transaction_id = d.transaction_id) = 1
        THEN (SELECT t.amount FROM bank_transactions t WHERE t.id = d.transaction_id)
        ELSE (SELECT CASE WHEN s.platform = 'booking' AND s.host_fees < 0 THEN s.payout - s.host_fees ELSE s.payout END FROM stays s WHERE s.id = d.stay_id)
      END,
      d.source, d.created_at
    FROM stay_deposits d;
  DROP TABLE stay_deposits;
  ALTER TABLE stay_deposits_new RENAME TO stay_deposits;
  CREATE INDEX stay_deposits_tx ON stay_deposits (transaction_id);
  CREATE INDEX stay_deposits_stay ON stay_deposits (stay_id);
`;

// The amount the user expects for a stay, in place of what Hospitable says. Syncing
// never touches it.
const SCHEMA_V15 = `
  ALTER TABLE stays ADD COLUMN expected_override REAL;
`;

// Each file import keeps its rows, so it can be undone or moved to the right account
// and imported again there; and how its account was recognised, to forget that too.
const SCHEMA_V16 = `
  ALTER TABLE bank_imports ADD COLUMN file_key TEXT;
  ALTER TABLE bank_imports ADD COLUMN layout TEXT;
  CREATE TABLE bank_import_lines (
    import_id INTEGER NOT NULL REFERENCES bank_imports (id) ON DELETE CASCADE,
    line INTEGER NOT NULL,
    posted TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT NOT NULL,
    payee TEXT,
    memo TEXT,
    external_id TEXT,
    PRIMARY KEY (import_id, line)
  );
`;

// Leases: mid-term tenancies, the rent expected each month, and what was paid (rent,
// security deposits held and paid back). Payments received outside the bank become
// transactions of their own; one that reached the bank links to its transaction.
const SCHEMA_V17 = `
  CREATE TABLE leases (
    id INTEGER PRIMARY KEY,
    ref TEXT,
    property_id TEXT,
    unit TEXT NOT NULL,
    tenant TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    start_date TEXT NOT NULL,
    end_date TEXT,
    rent REAL,
    deposit REAL,
    channel TEXT,
    ended INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE lease_months (
    lease_id INTEGER NOT NULL REFERENCES leases (id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    PRIMARY KEY (lease_id, month)
  );

  CREATE TABLE lease_payments (
    id INTEGER PRIMARY KEY,
    lease_id INTEGER NOT NULL REFERENCES leases (id) ON DELETE CASCADE,
    paid_on TEXT NOT NULL,
    amount REAL NOT NULL,
    purpose TEXT NOT NULL,
    channel TEXT,
    note TEXT,
    verified INTEGER NOT NULL DEFAULT 1,
    transaction_id INTEGER REFERENCES bank_transactions (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX lease_payments_lease ON lease_payments (lease_id);
`;

// Several businesses kept apart: each says what it is (short-term rental, long-term
// rental or another business), which tax form it files, and what was invested in it.
// Hospitable properties and leases each belong to one. Categories gain lines on Form
// 1065 (a partnership's trade or business, page 1) and Form 8825 (its rental real
// estate), suggested from their Schedule C and E lines.
// Leases: the names a tenant's rent arrives under at the bank, so deposits can be
// matched to the lease, and the matches the user took back, so they aren't made again.
// Store charges the user says have no online order (bought in the store), so they
// aren't listed as needing one.
// Loans whose balance the user keeps (the bank feed doesn't bring it): the balance is
// reduced by each payment's principal, entered by the user, and each payment is split
// into principal and interest in a split account.
// Money the owner puts into the business, or takes out: transfers, not income or
// spending, so choosing either category makes the transaction a transfer.
const SCHEMA_V22 = `
  INSERT OR IGNORE INTO categories (name, position) VALUES ('Owner Contribution', (SELECT COALESCE(MAX(position), 0) + 1 FROM categories));
  INSERT OR IGNORE INTO categories (name, position) VALUES ('Owner Withdrawal', (SELECT COALESCE(MAX(position), 0) + 1 FROM categories));
`;

const SCHEMA_V21 = `
  ALTER TABLE bank_accounts ADD COLUMN balance_manual INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE bank_accounts ADD COLUMN tracked_from TEXT;
  ALTER TABLE bank_accounts ADD COLUMN split_account_id INTEGER;
  CREATE TABLE loan_payments (
    id INTEGER PRIMARY KEY,
    transaction_id INTEGER NOT NULL UNIQUE REFERENCES bank_transactions (id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES bank_accounts (id) ON DELETE CASCADE,
    paid_on TEXT NOT NULL,
    amount REAL NOT NULL,
    -- Null when the payment was skipped (already counted in the balance).
    principal REAL,
    interest REAL,
    balance_before REAL,
    balance_after REAL,
    -- The same payment leaving checking, set aside so it isn't counted twice.
    paid_from INTEGER REFERENCES bank_transactions (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
`;

const SCHEMA_V20 = `
  ALTER TABLE bank_transactions ADD COLUMN no_order INTEGER NOT NULL DEFAULT 0;
`;

const SCHEMA_V19 = `
  ALTER TABLE leases ADD COLUMN payers TEXT;
  -- Rent due each month, for a lease without a month-by-month schedule.
  ALTER TABLE leases ADD COLUMN monthly_rent REAL;
  CREATE TABLE lease_link_rejections (
    lease_id INTEGER NOT NULL REFERENCES leases (id) ON DELETE CASCADE,
    transaction_id INTEGER NOT NULL REFERENCES bank_transactions (id) ON DELETE CASCADE,
    PRIMARY KEY (lease_id, transaction_id)
  );
`;

const SCHEMA_V18 = `
  ALTER TABLE entities ADD COLUMN activity TEXT;
  ALTER TABLE entities ADD COLUMN tax_form TEXT;
  ALTER TABLE entities ADD COLUMN invested REAL;
  ALTER TABLE entities ADD COLUMN invested_on TEXT;
  ALTER TABLE stay_properties ADD COLUMN entity_id INTEGER REFERENCES entities (id) ON DELETE SET NULL;
  ALTER TABLE leases ADD COLUMN entity_id INTEGER REFERENCES entities (id) ON DELETE SET NULL;
  ALTER TABLE categories ADD COLUMN form_1065 TEXT;
  ALTER TABLE categories ADD COLUMN form_8825 TEXT;

  UPDATE categories SET form_8825 = CASE schedule_e
    WHEN '5' THEN '3' WHEN '6' THEN '4' WHEN '7' THEN '5' WHEN '8' THEN '6' WHEN '9' THEN '7'
    WHEN '10' THEN '9' WHEN '12' THEN '8' WHEN '13' THEN '8' WHEN '14' THEN '11' WHEN '16' THEN '10'
    WHEN '17' THEN '12' WHEN '18' THEN '14' WHEN '11' THEN '17' WHEN '15' THEN '17' WHEN '19' THEN '17'
    ELSE NULL END;
  UPDATE categories SET form_1065 = CASE
    WHEN schedule_c = '21' OR schedule_e = '14' THEN '11'
    WHEN schedule_c = '23' OR schedule_e = '16' THEN '14'
    WHEN schedule_c = '20b' THEN '13'
    WHEN schedule_c = '13' OR schedule_e = '18' THEN '16'
    WHEN schedule_e IN ('12', '13') THEN '15'
    WHEN schedule_c IS NOT NULL OR schedule_e IS NOT NULL THEN '21'
    ELSE NULL END;
  UPDATE entities SET tax_form = CASE kind WHEN 'rental' THEN 'schedule-e' ELSE 'schedule-c' END WHERE tax_form IS NULL;
  UPDATE entities SET activity = CASE kind WHEN 'rental' THEN 'ltr' ELSE 'other' END WHERE activity IS NULL;
`;

// "02134-1234" -> "02134". Anything that isn't a US ZIP is kept as it is.
function zip5(value) {
  if (value === null || value === undefined || value === '') return value;
  const match = String(value).trim().match(/^(\d{5})(?:-?\d{4})?$/);
  return match ? match[1] : String(value).trim();
}

const STREET_WORDS = new Set(
  'st street rd road ave avenue av blvd boulevard dr drive ln lane ct court way pl place cir circle ter terrace pkwy parkway hwy highway trl trail sq square loop row pike path aly alley xing crossing cv cove pt point walk plz plaza hts heights tpke turnpike expy expressway'.split(' ')
);
// Only short forms: a full word after the street is usually the city (North Andover).
const DIRECTIONS = new Set('n s e w ne nw se sw'.split(' '));
const UNIT_WORDS = new Set('apt apartment unit ste suite bldg building fl floor rm room lot spc space dept'.split(' '));
const plainWord = (token) => token.toLowerCase().replace(/[.,]/g, '');

// The city in a one-line address such as "12 Oak Road Apt 4 Bentonville, AR 72712":
// the words after the street type (Road) and any unit (Apt 4), before the state.
// Null when it can't be told apart from the street.
function cityFromAddress(address) {
  const match = String(address || '').match(/^(.*?)[\s,]+([A-Z]{2})[\s,]+\d{5}(?:-\d{4})?\s*$/);
  if (!match) return null;
  const state = match[2];
  const before = match[1].trim().replace(/,$/, '');
  let city = null;
  if (before.includes(',')) {
    city = before.slice(before.lastIndexOf(',') + 1).trim();
  } else {
    const tokens = before.split(/\s+/);
    for (let i = 1; i < tokens.length - 1; i++) {
      const word = plainWord(tokens[i]);
      const box = word === 'box' && /^\d+$/.test(tokens[i + 1]);
      // The street type is the last of a run: "12 Court St Boston" ends at "St".
      if (!box && !(STREET_WORDS.has(word) && !STREET_WORDS.has(plainWord(tokens[i + 1])))) continue;
      let j = box ? i + 2 : i + 1;
      if (j < tokens.length && DIRECTIONS.has(plainWord(tokens[j]))) j++;
      while (j < tokens.length && (UNIT_WORDS.has(plainWord(tokens[j])) || /^#/.test(tokens[j]))) {
        j += /^#\S+/.test(tokens[j]) ? 1 : 2;
      }
      city = tokens.slice(j).join(' ');
      break;
    }
  }
  if (!city || /\d/.test(city) || city.split(/\s+/).length > 4 || city.length < 2) return null;
  const tidy = city === city.toUpperCase() ? city.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : city;
  return `${tidy}, ${state}`;
}

// Categories for bank and card spending that store orders don't cover.
// name, Schedule C line, Schedule E line.
const BANK_CATEGORIES = [
  ['Utilities', '25', '17'],
  ['Phone & Internet', '25', '17'],
  ['Insurance', '15', '9'],
  ['Software & Subscriptions', '18', '19'],
  ['Professional Services', '17', '10'],
  ['Advertising & Listing Fees', '8', '5'],
  ['Platform & Merchant Fees', '10', '8'],
  ['Bank & Card Fees', '27b', '19'],
  ['Cleaning & Maintenance Services', '21', '7'],
  ['Contractor Repairs', '21', '14'],
  ['Taxes & Licenses', '23', '16'],
  ['Travel', '24a', '6'],
  ['Meals', '24b', null],
  ['Rent & Lease', '20b', null],
  ['Loan & Mortgage Payments', null, null],
  ['Rental Income', null, null],
  ['Refunds & Returns', null, null],
  ['Other Income', null, null],
  ['Owner Contribution', null, null],
  ['Owner Withdrawal', null, null],
];

// Whitelisted so request data can never choose a column name.
const ORDER_COLUMNS = {
  storeName: 'store_name',
  date: 'order_date',
  status: 'status',
  subtotal: 'subtotal',
  tax: 'tax',
  shipping: 'shipping',
  total: 'total',
  currency: 'currency',
  payment: 'payment',
  deliveryAddress: 'delivery_address',
  deliveryZip: 'delivery_zip',
  url: 'url',
  detailUrl: 'detail_url',
};
const ORDER_SORTS = {
  date: 'o.order_date',
  store: 'COALESCE(o.store_name, o.store)',
  zip: 'o.delivery_zip',
  payment: 'o.payment',
  total: 'o.total',
};
const ITEM_SORTS = {
  date: (i) => i.date,
  store: (i) => i.storeName,
  item: (i) => i.name,
  category: (i) => i.category,
  zip: (i) => i.deliveryZip,
  payment: (i) => i.payment,
  amount: (i) => i.amount,
  status: (i) => i.status,
};
const NO_ZIP = 'none';
const NO_PAYMENT = 'none';

const present = (value) => value !== undefined && value !== null && value !== '';
const now = () => new Date().toISOString();

// Coverage stores "from the beginning" as this date, since a key can't be null.
const EARLIEST = '0001-01-01';

function compareValues(a, b, direction) {
  const aMissing = a === null || a === undefined || a === '';
  const bMissing = b === null || b === undefined || b === '';
  if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1; // blanks always last
  const order = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true });
  return direction === 'desc' ? -order : order;
}

function migrate(db, file) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > SCHEMA_VERSION) {
    throw new Error(`This database was made by a newer version of the server (schema ${version}).`);
  }
  if (version === SCHEMA_VERSION) return;

  // A safety copy before an existing database is changed.
  if (version > 0 && file !== ':memory:') {
    const backup = `${file}.before-v${SCHEMA_VERSION}.bak`;
    if (!fs.existsSync(backup)) db.prepare('VACUUM INTO ?').run(backup);
  }

  db.exec('BEGIN');
  try {
    if (version < 1) db.exec(SCHEMA_V1);
    if (version < 2) {
      db.exec(SCHEMA_V2);
      const insert = db.prepare('INSERT INTO categories (name, schedule_c, schedule_e, position) VALUES (?, ?, ?, ?)');
      CATEGORIES.forEach(([name, c, e], index) => insert.run(name, c, e, index));
      // Earlier versions missed these stores' item prices, so their details are read again.
      db.exec(`UPDATE orders SET detail_fetched_at = NULL, detail_attempts = 0
               WHERE store IN ('samsclub', 'walmart') AND NOT EXISTS (
                 SELECT 1 FROM items i WHERE i.store = orders.store AND i.order_id = orders.order_id AND i.price IS NOT NULL
               )`);
    }
    if (version < 3) db.exec(SCHEMA_V3);
    // Earlier versions took Amazon's recommendation carousels for items bought, so
    // Amazon details are read again; a details read replaces an order's items.
    if (version >= 1 && version < 4) {
      db.exec(`UPDATE orders SET detail_fetched_at = NULL, detail_attempts = 0 WHERE store = 'amazon'`);
    }
    if (version < 5) {
      db.exec(SCHEMA_V5);
      const insert = db.prepare(
        'INSERT OR IGNORE INTO categories (name, schedule_c, schedule_e, position) VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM categories))'
      );
      for (const [name, c, e] of BANK_CATEGORIES) insert.run(name, c, e);
    }
    if (version < 6) db.exec(SCHEMA_V6);
    if (version < 7) db.exec(SCHEMA_V7);
    if (version < 8) db.exec(SCHEMA_V8);
    if (version < 9) db.exec(SCHEMA_V9);
    if (version < 10) db.exec(SCHEMA_V10);
    if (version < 11) db.exec(SCHEMA_V11);
    if (version < 12) db.exec(SCHEMA_V12);
    if (version < 13) db.exec(SCHEMA_V13);
    if (version < 14) db.exec(SCHEMA_V14);
    if (version < 15) db.exec(SCHEMA_V15);
    if (version < 16) db.exec(SCHEMA_V16);
    if (version < 17) db.exec(SCHEMA_V17);
    if (version < 18) db.exec(SCHEMA_V18);
    if (version < 19) db.exec(SCHEMA_V19);
    if (version < 20) db.exec(SCHEMA_V20);
    if (version < 21) db.exec(SCHEMA_V21);
    if (version < 22) db.exec(SCHEMA_V22);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db, file);

  function transaction(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const getOrder = db.prepare('SELECT * FROM orders WHERE store = ? AND order_id = ?');
  const countItems = db.prepare('SELECT COUNT(*) AS n FROM items WHERE store = ? AND order_id = ?');
  const deleteItems = db.prepare('DELETE FROM items WHERE store = ? AND order_id = ?');
  const insertItem = db.prepare(
    'INSERT INTO items (store, order_id, position, name, quantity, price, line_total, seller, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );

  function writeItems(store, orderId, items) {
    deleteItems.run(store, orderId);
    items.forEach((item, index) => {
      insertItem.run(
        store,
        orderId,
        index,
        item.name ?? null,
        typeof item.quantity === 'number' ? item.quantity : null,
        typeof item.price === 'number' ? item.price : null,
        typeof item.lineTotal === 'number' ? item.lineTotal : null,
        item.seller ?? null,
        item.url ?? null
      );
    });
  }

  // Adds or updates orders. A value is only ever replaced by another value, so a
  // later partial read can't blank out something already known.
  // order.fromList: this came from an order list page.
  // order.detailRead / order.detailFailed: the outcome of reading its details page.
  function saveOrders(store, orders) {
    return transaction(() => {
      const counts = { inserted: 0, updated: 0 };
      for (const order of orders) {
        if (!present(order.orderId)) continue;
        const orderId = String(order.orderId);
        const existing = getOrder.get(store, orderId);
        // A details page is the better source. Once it's been read, a list page saying
        // the same as last time adds nothing, and its figures may be less exact.
        if (
          order.fromList &&
          existing &&
          existing.detail_fetched_at &&
          existing.list_fingerprint === OHE.listFingerprint(order)
        ) {
          continue;
        }
        const stamp = now();
        const columns = {};
        for (const [key, column] of Object.entries(ORDER_COLUMNS)) {
          if (present(order[key])) columns[column] = key === 'deliveryZip' ? zip5(order[key]) : order[key];
        }
        if (order.fromList) columns.list_fingerprint = OHE.listFingerprint(order);
        if (order.detailRead) columns.detail_fetched_at = stamp;
        if (order.detailFailed) columns.detail_attempts = (existing ? existing.detail_attempts : 0) + 1;

        if (existing) {
          const bookkeeping = ['detail_fetched_at', 'detail_attempts'];
          const changed = Object.keys(columns).some((name) => !bookkeeping.includes(name) && existing[name] !== columns[name]);
          columns.updated_at = changed ? stamp : existing.updated_at;
          const assignments = Object.keys(columns).map((name) => `${name} = ?`).join(', ');
          db.prepare(`UPDATE orders SET ${assignments} WHERE store = ? AND order_id = ?`).run(
            ...Object.values(columns),
            store,
            orderId
          );
          if (changed) counts.updated++;
        } else {
          columns.first_seen_at = stamp;
          columns.updated_at = stamp;
          const names = Object.keys(columns);
          db.prepare(
            `INSERT INTO orders (store, order_id, ${names.join(', ')}) VALUES (?, ?, ${names.map(() => '?').join(', ')})`
          ).run(store, orderId, ...Object.values(columns));
          counts.inserted++;
        }

        // List pages often give thinner item rows than a details page, so they only
        // replace items when they add something.
        const items = order.items || [];
        if (items.length) {
          const known = countItems.get(store, orderId).n;
          const detailed = existing && existing.detail_fetched_at;
          if (order.detailRead || !known || (!detailed && items.length >= known) || items.length > known) {
            writeItems(store, orderId, items);
          }
        }
      }
      return counts;
    });
  }

  function coverage(store) {
    return db
      .prepare('SELECT from_date AS "from", to_date AS "to" FROM sync_coverage WHERE store = ? ORDER BY from_date')
      .all(store)
      .map((r) => ({ from: r.from, to: r.to }));
  }

  function addCoverage(store, ranges) {
    const merged = OHE.mergeRanges([
      ...coverage(store),
      ...ranges.map((r) => ({ from: r.from || EARLIEST, to: r.to })),
    ]);
    transaction(() => {
      db.prepare('DELETE FROM sync_coverage WHERE store = ?').run(store);
      const insert = db.prepare('INSERT INTO sync_coverage (store, from_date, to_date) VALUES (?, ?, ?)');
      for (const range of merged) insert.run(store, range.from, range.to);
    });
    return merged;
  }

  // What a sync run should read for this store and date range.
  function syncPlan(store, range, { full = false, today = OHE.localToday() } = {}) {
    const bounded = { from: range.from || null, to: range.to || null };
    const gaps = full
      ? [{ from: bounded.from, to: bounded.to && bounded.to < today ? bounded.to : today }]
      : OHE.planGaps(bounded, coverage(store), today, RECHECK_DAYS);

    const known = {};
    if (!full) {
      const rows = db
        .prepare('SELECT order_id, list_fingerprint, detail_fetched_at FROM orders WHERE store = ?')
        .all(store);
      for (const row of rows) known[row.order_id] = { fingerprint: row.list_fingerprint, detailDone: Boolean(row.detail_fetched_at) };
    }

    // Orders in range whose details were never read, and haven't failed too often.
    const rows = db
      .prepare(
        `SELECT order_id, detail_url, order_date FROM orders
         WHERE store = ? AND detail_url IS NOT NULL AND detail_attempts < ?
           AND ${full ? '1 = 1' : 'detail_fetched_at IS NULL'}
         ORDER BY order_date DESC`
      )
      .all(store, MAX_DETAIL_ATTEMPTS);
    const pendingDetails = rows
      .filter((row) => OHE.inRange(row.order_date, bounded) || !row.order_date)
      .map((row) => ({ orderId: row.order_id, detailUrl: row.detail_url, date: row.order_date, store }));

    return { gaps, known, pendingDetails };
  }

  function recordRun(store, run) {
    db.prepare(
      `INSERT INTO sync_runs (store, finished_at, range_from, range_to, new_orders, updated_orders, details_read, details_missed, complete)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      store,
      now(),
      run.from ?? null,
      run.to ?? null,
      run.newOrders || 0,
      run.updatedOrders || 0,
      run.detailsRead || 0,
      run.detailsMissed || 0,
      run.complete ? 1 : 0
    );
  }

  /* ---------- Categories and tax settings ---------- */

  let classifier = null;
  function classify(name, store) {
    if (!classifier) {
      classifier = createClassifier(db.prepare('SELECT name, category FROM category_overrides').all());
    }
    return classifier(name, store);
  }

  function categoryList() {
    return db
      .prepare('SELECT name, schedule_c, schedule_e, form_1065, form_8825, expense_class FROM categories ORDER BY position')
      .all()
      .map((row) => ({ name: row.name, scheduleC: row.schedule_c, scheduleE: row.schedule_e, form1065: row.form_1065, form8825: row.form_8825, expenseClass: row.expense_class }));
  }

  // Sets a category for every item with this name, and teaches similar names.
  function setItemCategory(name, category) {
    const key = nameKey(name);
    if (!key) return;
    if (category) {
      db.prepare(
        'INSERT INTO category_overrides (name_key, name, category) VALUES (?, ?, ?) ON CONFLICT (name_key) DO UPDATE SET category = excluded.category'
      ).run(key, name, category);
    } else {
      db.prepare('DELETE FROM category_overrides WHERE name_key = ?').run(key);
    }
    classifier = null;
  }

  // Lines left out (undefined) keep what they were; null clears one.
  function saveCategory({ name, scheduleC, scheduleE, form1065, form8825, expenseClass }) {
    const position = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM categories').get().next;
    const before = db.prepare('SELECT form_1065, form_8825 FROM categories WHERE name = ?').get(name);
    db.prepare(
      `INSERT INTO categories (name, schedule_c, schedule_e, position, expense_class, form_1065, form_8825) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET schedule_c = excluded.schedule_c, schedule_e = excluded.schedule_e, form_1065 = excluded.form_1065, form_8825 = excluded.form_8825,
         expense_class = COALESCE(?, categories.expense_class)`
    ).run(
      name,
      scheduleC ?? null,
      scheduleE ?? null,
      position,
      expenseClass ?? 'opex',
      form1065 === undefined ? before?.form_1065 ?? null : form1065,
      form8825 === undefined ? before?.form_8825 ?? null : form8825,
      expenseClass ?? null
    );
  }

  const taxRules = () => db.prepare('SELECT id, field, value, status FROM tax_rules ORDER BY field, value').all().map((row) => ({ ...row }));

  function saveTaxRule({ field, value, status }) {
    // Several conditions are stored in one order, so the same rule isn't saved twice.
    if (field === 'multi') {
      const conditions = (Array.isArray(value) ? value : JSON.parse(value))
        .map((c) => ({ field: c.field, value: c.field === 'zip' ? zip5(c.value) : c.value, not: Boolean(c.not) }))
        .sort((a, b) => a.field.localeCompare(b.field) || Number(a.not) - Number(b.not) || a.value.localeCompare(b.value));
      const unique = [...new Map(conditions.map((c) => [JSON.stringify(c), c])).values()];
      value = JSON.stringify(unique);
    }
    db.prepare(
      'INSERT INTO tax_rules (field, value, status) VALUES (?, ?, ?) ON CONFLICT (field, value) DO UPDATE SET status = excluded.status'
    ).run(field, field === 'zip' ? zip5(value) : value, status);
  }
  const deleteTaxRule = (id) => db.prepare('DELETE FROM tax_rules WHERE id = ?').run(id);

  function markItems(items, status) {
    transaction(() => {
      const remove = db.prepare('DELETE FROM item_marks WHERE store = ? AND order_id = ? AND name_key = ?');
      const insert = db.prepare(
        `INSERT INTO item_marks (store, order_id, name_key, status) VALUES (?, ?, ?, ?)
         ON CONFLICT (store, order_id, name_key) DO UPDATE SET status = excluded.status`
      );
      for (const item of items) {
        const key = nameKey(item.name);
        if (status) insert.run(item.store, item.orderId, key, status);
        else remove.run(item.store, item.orderId, key);
      }
    });
  }

  /* ---------- Reading orders and items ---------- */

  // Store, payment, ZIP, category and year filters can each hold several values (any
  // of them matches). A single string still works. An empty list means no filter.
  const LIST_FILTERS = ['store', 'payment', 'zip', 'category', 'years'];
  function normalize(filters = {}) {
    const out = { ...filters };
    for (const key of LIST_FILTERS) {
      const raw = filters[key];
      const values = (Array.isArray(raw) ? raw : [raw]).filter((v) => v !== null && v !== undefined && v !== '').map(String);
      out[key] = values.length ? [...new Set(key === 'zip' ? values.map(zip5) : values)] : null;
    }
    return out;
  }

  /* ---------- Places ---------- */

  function places() {
    const names = new Map(db.prepare('SELECT zip, name FROM zip_names').all().map((r) => [r.zip, r.name]));
    const found = new Map();
    for (const row of db.prepare('SELECT delivery_zip AS zip, delivery_address AS address, COUNT(*) AS n FROM orders WHERE delivery_zip IS NOT NULL GROUP BY delivery_zip, delivery_address').all()) {
      const entry = found.get(row.zip) || { orders: 0, cities: new Map() };
      entry.orders += row.n;
      const city = cityFromAddress(row.address);
      if (city) entry.cities.set(city, (entry.cities.get(city) || 0) + row.n);
      found.set(row.zip, entry);
    }
    for (const zip of names.keys()) if (!found.has(zip)) found.set(zip, { orders: 0, cities: new Map() });
    return [...found.entries()]
      .map(([zip, entry]) => {
        const city = [...entry.cities.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        const name = names.get(zip) ?? null;
        return { zip, city, name, label: name || city || zip, orders: entry.orders };
      })
      .sort((a, b) => a.label.localeCompare(b.label) || a.zip.localeCompare(b.zip));
  }

  function nameZip(zip, name) {
    const key = zip5(zip);
    if (name) db.prepare('INSERT INTO zip_names (zip, name) VALUES (?, ?) ON CONFLICT (zip) DO UPDATE SET name = excluded.name').run(key, name);
    else db.prepare('DELETE FROM zip_names WHERE zip = ?').run(key);
  }

  // Shared WHERE clause, built only from fixed text and bound parameters.
  function whereFor(raw = {}) {
    const filters = normalize(raw);
    const clauses = [];
    const params = [];
    // column IN (...), plus IS NULL when the "none recorded" choice is picked.
    const anyOf = (column, values, none) => {
      if (!values) return;
      const real = values.filter((v) => v !== none);
      const parts = [];
      if (real.length) {
        parts.push(`${column} IN (${real.map(() => '?').join(', ')})`);
        params.push(...real);
      }
      if (none && values.includes(none)) parts.push(`${column} IS NULL`);
      clauses.push(parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0]);
    };
    if (filters.from) {
      clauses.push('o.order_date >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      clauses.push('o.order_date <= ?');
      params.push(filters.to);
    }
    anyOf('substr(o.order_date, 1, 4)', filters.years);
    anyOf('o.store', filters.store);
    anyOf('o.payment', filters.payment, NO_PAYMENT);
    anyOf('o.delivery_zip', filters.zip, NO_ZIP);
    if (filters.q) {
      const like = `%${String(filters.q).replace(/[\\%_]/g, '\\$&')}%`;
      clauses.push(
        `(o.order_id LIKE ? ESCAPE '\\' OR EXISTS (
           SELECT 1 FROM items i WHERE i.store = o.store AND i.order_id = o.order_id AND i.name LIKE ? ESCAPE '\\'
         ))`
      );
      params.push(like, like);
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  // Which business each order belongs to: the business of a charge linked to it, else
  // of the card that paid (an account's last four digits), else of the place it was
  // delivered to. null when none of those says.
  function orderBusinesses(orders) {
    const out = new Map();
    if (!orders.length) return out;
    const linked = new Map();
    for (const row of db
      .prepare(
        'SELECT l.store, l.order_id, COALESCE(t.entity_id, a.entity_id) AS entity FROM order_links l JOIN bank_transactions t ON t.id = l.transaction_id JOIN bank_accounts a ON a.id = t.account_id'
      )
      .all()) {
      if (row.entity !== null) linked.set(`${row.store}\u0000${row.order_id}`, row.entity);
    }
    const cards = new Map();
    for (const account of db.prepare('SELECT name, last4, entity_id FROM bank_accounts WHERE entity_id IS NOT NULL').all()) {
      const digits = account.last4 ? String(account.last4) : (/\((\d{4})\)\s*$/.exec(account.name) || [])[1];
      if (digits && !cards.has(digits)) cards.set(digits, account.entity_id);
    }
    const places = new Map(db.prepare('SELECT zip, entity_id FROM place_entities').all().map((r) => [r.zip, r.entity_id]));
    for (const order of orders) {
      const key = `${order.store}\u0000${order.order_id}`;
      let entity = linked.get(key) ?? null;
      if (entity === null) {
        for (const match of String(order.payment || '').matchAll(/ending (\d{4})\b/gi)) {
          if (cards.has(match[1])) {
            entity = cards.get(match[1]);
            break;
          }
        }
      }
      if (entity === null && order.delivery_zip) entity = places.get(zip5(order.delivery_zip)) ?? null;
      out.set(key, entity);
    }
    return out;
  }

  // The orders of one business, when the filters choose one.
  function forBusiness(orders, filters) {
    if (!filters.entity) return orders;
    const owners = orderBusinesses(orders);
    return orders.filter((o) => owners.get(`${o.store}\u0000${o.order_id}`) === filters.entity);
  }

  function allItemsByOrder() {
    const byOrder = new Map();
    for (const row of db.prepare('SELECT * FROM items ORDER BY store, order_id, position').all()) {
      const key = `${row.store}\u0000${row.order_id}`;
      if (!byOrder.has(key)) byOrder.set(key, []);
      byOrder.get(key).push(row);
    }
    return byOrder;
  }

  function allMarks() {
    const marks = new Map();
    for (const row of db.prepare('SELECT * FROM item_marks').all()) {
      marks.set(`${row.store}\u0000${row.order_id}\u0000${row.name_key}`, row.status);
    }
    return marks;
  }

  // Which kind of card paid for each order, for "store unless on a business card" rules:
  // 'business' when a card number in its payment, or a charge linked to it, belongs to an
  // account marked Business; 'other' when it was paid some other way; null when unknown.
  // With no Business account set up, nothing is known.
  function cardsFor(orders, rules) {
    const stores = new Set(rules.filter((r) => r.field === 'store_card').map((r) => r.value));
    const cards = new Map();
    if (!stores.size) return cards;
    if (!db.prepare("SELECT 1 FROM bank_accounts WHERE owner = 'business' LIMIT 1").get()) return cards;
    const business = new Set(db.prepare("SELECT last4 FROM bank_accounts WHERE owner = 'business' AND last4 IS NOT NULL").all().map((r) => String(r.last4)));
    const charged = db.prepare(
      'SELECT DISTINCT a.owner FROM order_links l JOIN bank_transactions t ON t.id = l.transaction_id JOIN bank_accounts a ON a.id = t.account_id WHERE l.store = ? AND l.order_id = ?'
    );
    for (const order of orders) {
      if (!stores.has(order.store)) continue;
      const digits = [...String(order.payment || '').matchAll(/ending (\d{4})\b/gi)].map((m) => m[1]);
      const owners = charged.all(order.store, order.order_id).map((r) => r.owner);
      let card = null;
      if (digits.some((d) => business.has(d)) || owners.includes('business')) card = 'business';
      else if (digits.length || owners.length || /\b(cash|gift card|ebt)\b/i.test(order.payment || '')) card = 'other';
      cards.set(`${order.store}\u0000${order.order_id}`, card);
    }
    return cards;
  }

  // Every item matching the filters, with its category, share of the order's
  // total, and business or personal status. Worked out on each read, so an improved
  // rule or a new correction applies to everything straight away.
  function enrichedItems(raw = {}) {
    const filters = normalize(raw);
    const { sql, params } = whereFor(filters);
    const orders = forBusiness(db.prepare(`SELECT o.* FROM orders o ${sql}`).all(...params), filters);
    const byOrder = allItemsByOrder();
    const marks = allMarks();
    const rules = taxRules();
    const cards = cardsFor(orders, rules);
    const lookup = new Map(categoryList().map((c) => [c.name, c]));
    const search = filters.q ? String(filters.q).toLowerCase() : null;
    const out = [];
    for (const order of orders) {
      const rows = byOrder.get(`${order.store}\u0000${order.order_id}`) || [];
      const shares = tax.allocate(order, rows);
      const orderMatchesSearch = search && order.order_id.toLowerCase().includes(search);
      rows.forEach((row, index) => {
        if (search && !orderMatchesSearch && !String(row.name || '').toLowerCase().includes(search)) return;
        const { category, source } = classify(row.name, order.store);
        const item = {
          store: order.store,
          storeName: order.store_name || order.store,
          orderId: order.order_id,
          date: order.order_date,
          name: row.name,
          quantity: row.quantity,
          price: row.price,
          amount: shares[index].amount,
          estimated: shares[index].estimated,
          category,
          categorySource: source,
          deliveryZip: order.delivery_zip,
          deliveryAddress: order.delivery_address,
          payment: order.payment,
          card: cards.get(`${order.store}\u0000${order.order_id}`) ?? null,
          url: row.url,
          orderUrl: order.url,
          scheduleC: lookup.get(category) ? lookup.get(category).scheduleC : null,
          scheduleE: lookup.get(category) ? lookup.get(category).scheduleE : null,
        };
        const mark = marks.get(`${order.store}\u0000${order.order_id}\u0000${nameKey(row.name)}`);
        const resolved = tax.resolveStatus(item, mark, rules);
        item.status = resolved.status;
        item.statusSource = resolved.source;
        if (filters.category && !filters.category.includes(item.category)) return;
        // "notpersonal" is everything except personal.
        if (filters.status === 'notpersonal' ? item.status === 'personal' : filters.status && item.status !== filters.status) return;
        out.push(item);
      });
    }
    return out;
  }

  function listItems(filters, { sort = 'date', direction = 'desc', limit, offset = 0 } = {}) {
    const items = enrichedItems(filters);
    const get = ITEM_SORTS[sort] || ITEM_SORTS.date;
    items.sort((a, b) => compareValues(get(a), get(b), direction) || compareValues(a.date, b.date, 'desc') || String(a.orderId).localeCompare(String(b.orderId)));
    const amount = items.reduce((sum, item) => sum + (typeof item.amount === 'number' ? item.amount : 0), 0);
    return { total: items.length, amount: tax.cents(amount), items: limit ? items.slice(offset, offset + limit) : items };
  }

  // key is the filter value that lists these orders, such as a store id.
  function bump(map, label, spend, orderKey, key = label) {
    const entry = map.get(label) || { label, key, spend: 0, orderKeys: new Set() };
    entry.spend += spend;
    entry.orderKeys.add(orderKey);
    map.set(label, entry);
  }
  const finish = (map) =>
    [...map.values()]
      .map(({ label, key, spend, orderKeys }) => ({ label, key, spend: tax.cents(spend), orders: orderKeys.size }))
      .sort((a, b) => b.spend - a.spend);

  function report(raw = {}) {
    const filters = normalize(raw);
    const { sql, params } = whereFor(filters);
    const everyOrder = db.prepare(`SELECT o.* FROM orders o ${sql}`).all(...params);
    const orders = forBusiness(everyOrder, filters);
    // With a business chosen: the orders in these filters that no business could be
    // found for, so the page can say they're left out.
    let unassigned = null;
    if (filters.entity) {
      const owners = orderBusinesses(everyOrder);
      unassigned = everyOrder.filter((o) => owners.get(`${o.store}\u0000${o.order_id}`) === null).length;
    }
    const items = enrichedItems(filters);
    const itemsByOrder = new Map();
    for (const item of items) {
      const key = `${item.store}\u0000${item.orderId}`;
      if (!itemsByOrder.has(key)) itemsByOrder.set(key, []);
      itemsByOrder.get(key).push(item);
    }

    const totals = { orders: 0, spend: 0, tax: 0, shipping: 0, withoutTotal: 0, withoutDetails: 0, undated: 0, items: 0 };
    const months = new Map();
    const stores = new Map();
    const payments = new Map();
    const zips = new Map();
    const cities = new Map();
    const cityZips = new Map();
    const placeLabel = new Map(places().map((p) => [p.zip, p.label]));
    const allItems = filters.status ? new Map([...allItemsByOrder()].map(([key, rows]) => [key, rows.length])) : new Map();
    for (const order of orders) {
      const key = `${order.store}\u0000${order.order_id}`;
      const own = itemsByOrder.get(key) || [];
      // With a category or business/personal choice, only the matching items' share of
      // each order counts. An order with no items read yet stays whole unless a
      // category is chosen.
      const someItems = filters.category || (filters.status && own.length < (allItems.get(key) || 0));
      if (filters.category && !own.length) continue;
      if (someItems && !own.length) continue;
      const value = someItems ? own.reduce((sum, item) => sum + (item.amount || 0), 0) : order.total || 0;
      totals.orders++;
      totals.spend += value;
      if (!someItems) {
        totals.tax += order.tax || 0;
        totals.shipping += order.shipping || 0;
      }
      if (order.total === null) totals.withoutTotal++;
      if (!order.detail_fetched_at) totals.withoutDetails++;
      if (!order.order_date) totals.undated++;
      if (order.order_date) bump(months, order.order_date.slice(0, 7), value, key);
      bump(stores, order.store_name || order.store, value, key, order.store);
      bump(payments, order.payment || 'Not recorded', value, key, order.payment || NO_PAYMENT);
      if (order.delivery_zip) {
        bump(zips, order.delivery_zip, value, key);
        const label = placeLabel.get(order.delivery_zip) || order.delivery_zip;
        bump(cities, label, value, key);
        if (!cityZips.has(label)) cityZips.set(label, new Set());
        cityZips.get(label).add(order.delivery_zip);
      }
    }
    const counted = totals.orders - totals.withoutTotal;
    totals.spend = tax.cents(totals.spend);
    totals.tax = filters.category ? null : tax.cents(totals.tax);
    totals.shipping = filters.category ? null : tax.cents(totals.shipping);
    totals.average = counted > 0 ? tax.cents(totals.spend / counted) : null;
    totals.items = items.reduce((sum, item) => sum + (typeof item.quantity === 'number' ? item.quantity : 1), 0);

    const categories = new Map();
    const products = new Map();
    let estimatedItems = 0;
    for (const item of items) {
      bump(categories, item.category, item.amount || 0, `${item.store}\u0000${item.orderId}`);
      if (item.estimated) estimatedItems++;
      if (!item.name) continue;
      const product = products.get(item.name) || { label: item.name, orderKeys: new Set(), quantity: 0, lastBought: null };
      product.orderKeys.add(`${item.store}\u0000${item.orderId}`);
      product.quantity += typeof item.quantity === 'number' ? item.quantity : 1;
      if (item.date && (!product.lastBought || item.date > product.lastBought)) product.lastBought = item.date;
      products.set(item.name, product);
    }
    const topItems = [...products.values()]
      .map(({ label, orderKeys, quantity, lastBought }) => ({ label, orders: orderKeys.size, quantity, lastBought }))
      .sort((a, b) => b.orders - a.orders || b.quantity - a.quantity || String(b.lastBought).localeCompare(String(a.lastBought)))
      .slice(0, 10);

    return {
      totals: { ...totals, estimatedItems, unassigned },
      byMonth: finish(months).sort((a, b) => a.label.localeCompare(b.label)),
      byStore: finish(stores),
      byPayment: finish(payments),
      byZip: finish(zips),
      byCity: finish(cities).map((row) => ({ ...row, key: undefined, keys: [...cityZips.get(row.label)].sort() })),
      byCategory: finish(categories),
      topItems,
    };
  }

  function listOrders(raw = {}, { sort = 'date', direction = 'desc', limit, offset = 0 } = {}) {
    const filters = normalize(raw);
    const { sql, params } = whereFor(filters);
    const column = ORDER_SORTS[sort] || ORDER_SORTS.date;
    const order = direction === 'asc' ? 'ASC' : 'DESC';
    let rows = db
      .prepare(`SELECT o.* FROM orders o ${sql} ORDER BY ${column} IS NULL, ${column} ${order}, o.order_date DESC, o.store, o.order_id`)
      .all(...params);
    rows = forBusiness(rows, filters);
    if (filters.category) {
      const matching = new Set(enrichedItems(filters).map((item) => `${item.store}\u0000${item.orderId}`));
      rows = rows.filter((row) => matching.has(`${row.store}\u0000${row.order_id}`));
    }
    const total = rows.length;
    const page = limit ? rows.slice(offset, offset + limit) : rows;
    const byOrder = allItemsByOrder();
    const charges = db.prepare(
      `SELECT t.id, t.posted, l.amount, a.name AS account FROM order_links l JOIN bank_transactions t ON t.id = l.transaction_id
       JOIN bank_accounts a ON a.id = t.account_id WHERE l.store = ? AND l.order_id = ? ORDER BY t.posted`
    );
    return {
      total,
      orders: page.map((row) => ({
        store: row.store,
        storeName: row.store_name,
        orderId: row.order_id,
        date: row.order_date,
        status: row.status,
        subtotal: row.subtotal,
        tax: row.tax,
        shipping: row.shipping,
        total: row.total,
        currency: row.currency,
        payment: row.payment,
        deliveryAddress: row.delivery_address,
        deliveryZip: row.delivery_zip,
        url: row.url,
        detailRead: Boolean(row.detail_fetched_at),
        charges: charges.all(row.store, row.order_id).map((c) => ({ ...c })),
        items: (byOrder.get(`${row.store}\u0000${row.order_id}`) || []).map((item) => ({
          name: item.name,
          quantity: item.quantity,
          price: item.price,
          seller: item.seller,
          url: item.url,
          category: classify(item.name, row.store).category,
        })),
      })),
    };
  }

  function taxReport(formId, filters) {
    const key = tax.FORM_KEYS[formId] || 'scheduleC';
    const lookup = new Map(categoryList().map((c) => [c.name, c[key]]));
    return tax.buildReport(formId, enrichedItems(filters), (category) => lookup.get(category));
  }

  // The choices shown in the report filters, and each store's sync state.
  function status() {
    const stores = db
      .prepare(
        `SELECT store, COALESCE(MAX(store_name), store) AS name, COUNT(*) AS orders,
                MIN(order_date) AS earliest, MAX(order_date) AS latest,
                SUM(CASE WHEN detail_fetched_at IS NULL AND detail_url IS NOT NULL AND detail_attempts < ${MAX_DETAIL_ATTEMPTS} THEN 1 ELSE 0 END) AS missingDetails
         FROM orders GROUP BY store ORDER BY name`
      )
      .all()
      .map((row) => ({
        ...row,
        coverage: coverage(row.store).map((c) => ({ from: c.from === EARLIEST ? null : c.from, to: c.to })),
        lastRun: { ...(db.prepare('SELECT * FROM sync_runs WHERE store = ? ORDER BY id DESC LIMIT 1').get(row.store) || {}) },
      }));
    const column = (sql, name) => db.prepare(sql).all().map((row) => row[name]);
    return {
      stores,
      payments: column('SELECT DISTINCT payment FROM orders WHERE payment IS NOT NULL ORDER BY payment', 'payment'),
      zips: column('SELECT DISTINCT delivery_zip FROM orders WHERE delivery_zip IS NOT NULL ORDER BY delivery_zip', 'delivery_zip'),
      years: column("SELECT DISTINCT substr(order_date, 1, 4) AS year FROM orders WHERE order_date IS NOT NULL ORDER BY year DESC", 'year'),
      places: places(),
    };
  }

  return {
    saveOrders,
    addCoverage,
    coverage,
    syncPlan,
    recordRun,
    report,
    listOrders,
    listItems,
    enrichedItems,
    status,
    categoryList,
    setItemCategory,
    saveCategory,
    taxRules,
    saveTaxRule,
    deleteTaxRule,
    markItems,
    taxReport,
    places,
    nameZip,
    // For the web app's own tables (users, sessions, audit log).
    raw: db,
    close: () => db.close(),
  };
}

module.exports = { openDatabase, SCHEMA_V1, UNCATEGORIZED, cityFromAddress, zip5 };

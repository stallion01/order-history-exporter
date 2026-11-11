// Sorts purchased items into categories, entirely on this machine. In order of trust:
// the user's own correction for that exact item, what their corrections have taught
// about similar names, keyword rules, and finally a weak guess from the store.

const UNCATEGORIZED = 'Uncategorized';

// name, suggested Schedule C line, suggested Schedule E line, keywords.
// A null line means there's no sensible default, so it's left for the user to decide.
const CATEGORIES = [
  ['Cleaning Supplies', '22', '7', ['cleaner', 'cleaning', 'disinfectant', 'bleach', 'detergent', 'laundry', 'dish soap', 'dishwasher pod', 'dishwasher detergent', 'dishwashing', 'fabric softener', 'dryer sheet', 'stain remover', 'lysol', 'clorox', 'windex', 'pine sol', 'swiffer', 'mop', 'broom', 'scrubber', 'sponge', 'scouring', 'tide', 'gain', 'downy', 'cascade', 'dawn', 'vacuum bag', 'air freshener', 'febreze', 'disinfecting wipe', 'degreaser']],
  ['Linens & Bedding', '22', '15', ['bed sheet', 'sheet set', 'fitted sheet', 'pillowcase', 'pillow', 'duvet', 'comforter', 'blanket', 'mattress protector', 'mattress pad', 'mattress topper', 'bath towel', 'hand towel', 'towel set', 'washcloth', 'bath mat', 'tablecloth', 'shower curtain', 'bedding', 'linen', 'quilt', 'towel']],
  ['Household Paper & Disposables', '22', '15', ['paper towel', 'toilet paper', 'bath tissue', 'facial tissue', 'tissue', 'napkin', 'trash bag', 'garbage bag', 'kitchen bag', 'aluminum foil', 'plastic wrap', 'parchment paper', 'paper plate', 'disposable', 'battery', 'batteries', 'light bulb', 'lightbulb', 'storage bag', 'freezer bag', 'sandwich bag', 'charmin', 'bounty', 'kirkland toilet', 'hefty', 'glad', 'ziploc']],
  ['Grocery', null, null, ['milk', 'egg', 'cheese', 'yogurt', 'butter', 'bread', 'bagel', 'tortilla', 'chicken', 'beef', 'pork', 'turkey', 'bacon', 'sausage', 'salmon', 'shrimp', 'tuna', 'banana', 'apple', 'strawberry', 'blueberry', 'grape', 'avocado', 'tomato', 'potato', 'onion', 'lettuce', 'spinach', 'salad', 'broccoli', 'carrot', 'rice', 'pasta', 'cereal', 'oatmeal', 'flour', 'sugar', 'coffee', 'tea', 'juice', 'water', 'soda', 'sparkling', 'snack', 'chip', 'cracker', 'cookie', 'chocolate', 'candy', 'nut', 'almond', 'cashew', 'peanut', 'granola', 'protein bar', 'soup', 'broth', 'sauce', 'ketchup', 'mustard', 'mayonnaise', 'olive oil', 'cooking oil', 'vinegar', 'seasoning', 'spice', 'honey', 'jam', 'pizza', 'frozen', 'muffin', 'croissant', 'donut', 'cake', 'pie', 'beer', 'wine', 'rotisserie', 'kombucha', 'creamer', 'hummus', 'salsa', 'fruit', 'vegetable', 'berries', 'kiwi', 'nectarine', 'peach', 'pear', 'plum', 'mango', 'orange', 'lemon', 'lime', 'melon', 'cherry', 'clementine', 'mandarin', 'sprout', 'cabbage', 'cucumber', 'pepper', 'mushroom', 'garlic', 'corn', 'bean']],
  ['Bath & Personal Care', '22', '15', ['shampoo', 'conditioner', 'body wash', 'hand soap', 'soap', 'toothpaste', 'toothbrush', 'mouthwash', 'floss', 'deodorant', 'razor', 'shaving', 'lotion', 'sunscreen', 'cosmetic', 'makeup', 'hair dryer', 'feminine', 'tampon', 'cotton swab', 'cotton ball']],
  ['Health & Medicine', null, null, ['vitamin', 'supplement', 'ibuprofen', 'acetaminophen', 'allergy', 'antacid', 'bandage', 'first aid', 'probiotic', 'melatonin', 'pain relief', 'cold flu', 'thermometer', 'prescription', 'pharmacy', 'fish oil']],
  ['Kitchen & Dining', '22', '15', ['kettle', 'cookware', 'frying pan', 'skillet', 'saucepan', 'baking sheet', 'utensil', 'silverware', 'flatware', 'cutlery', 'knife set', 'cutting board', 'dinnerware', 'drinkware', 'mug', 'glassware', 'food storage', 'mixing bowl', 'can opener', 'coffee filter', 'dish rack', 'bakeware', 'measuring cup']],
  ['Appliances', '27b', '19', ['refrigerator', 'freezer', 'dishwasher', 'washer', 'dryer', 'microwave', 'oven', 'range hood', 'air fryer', 'blender', 'toaster', 'coffee maker', 'coffeemaker', 'vacuum', 'air purifier', 'humidifier', 'dehumidifier', 'space heater', 'air conditioner', 'water softener', 'water heater']],
  ['Furniture & Decor', '27b', '19', ['sofa', 'couch', 'sectional', 'chair', 'table', 'desk', 'dresser', 'nightstand', 'bookcase', 'bookshelf', 'cabinet', 'bed frame', 'mattress', 'headboard', 'ottoman', 'rug', 'lamp', 'curtain', 'mirror', 'wall art', 'picture frame', 'furniture', 'decor', 'mailbox']],
  ['Building & Repair Materials', '21', '14', ['lumber', 'plywood', 'drywall', 'insulation', 'roofing', 'shingle', 'flooring', 'tile', 'grout', 'caulk', 'paint', 'primer', 'stain', 'conduit', 'circuit breaker', 'electrical', 'outlet', 'switch', 'wire', 'junction box', 'gang box', 'pvc', 'pipe', 'plumbing', 'faucet', 'valve', 'toilet', 'sink', 'door', 'window', 'hinge', 'cement', 'concrete', 'mortar', 'thermostat', 'smoke detector', 'water filter', 'hvac', 'furnace filter', 'air filter']],
  ['Tools & Hardware', '22', '15', ['drill', 'saw', 'wrench', 'hammer', 'screwdriver', 'pliers', 'socket set', 'tool set', 'toolbox', 'tape measure', 'ladder', 'screw', 'nail', 'bolt', 'anchor', 'ratchet', 'tie down', 'clamp', 'sander', 'level', 'paint roller', 'paint brush', 'work glove', 'hardware', 'tool']],
  ['Garden & Outdoor', '21', '7', ['lawn', 'mower', 'garden', 'fertilizer', 'mulch', 'grass seed', 'weed', 'plant', 'planter', 'hose', 'sprinkler', 'grill', 'patio', 'outdoor', 'snow shovel', 'ice melt', 'pest control', 'insect', 'trimmer', 'leaf blower']],
  ['Electronics & Computers', '18', '15', ['graphics card', 'motherboard', 'processor', 'cpu', 'ssd', 'hard drive', 'memory card', 'flash drive', 'laptop', 'computer', 'monitor', 'keyboard', 'mouse', 'router', 'printer', 'tablet', 'ipad', 'iphone', 'smartphone', 'phone case', 'charger', 'usb', 'hdmi', 'cable', 'adapter', 'headphone', 'earbud', 'speaker', 'camera', 'television', 'smart tv', 'drone', 'webcam', 'ethernet', 'power supply', 'electronics', 'ink cartridge', 'toner']],
  ['Office Supplies', '18', '15', ['printer paper', 'copy paper', 'pen', 'pencil', 'marker', 'notebook', 'stapler', 'envelope', 'folder', 'binder', 'sticky note', 'label maker', 'shipping label', 'packing tape', 'office', 'postage', 'calculator']],
  ['Automotive & Fuel', '9', '6', ['unleaded', 'gasoline', 'diesel', 'fuel', 'motor oil', 'oil filter', 'car wash', 'car battery', 'wiper', 'tire', 'automotive', 'antifreeze', 'windshield']],
  ['Clothing', null, null, ['shirt', 'pants', 'jeans', 'jacket', 'coat', 'sock', 'underwear', 'shoe', 'sneaker', 'boot', 'dress', 'sweater', 'hoodie', 'clothing']],
  ['Pet Supplies', null, null, ['dog food', 'cat food', 'cat litter', 'litter', 'dog', 'cat', 'pet', 'puppy', 'kitten', 'flea']],
  ['Baby & Kids', null, null, ['diaper', 'baby', 'infant', 'toddler', 'stroller', 'car seat', 'baby wipe', 'formula']],
  ['Toys & Games', null, null, ['toy', 'lego', 'puzzle', 'board game', 'video game', 'doll']],
  ['Books & Media', '27b', '19', ['book', 'paperback', 'hardcover', 'kindle', 'dvd', 'magazine', 'subscription']],
  ['Sports & Fitness', null, null, ['fitness', 'yoga', 'dumbbell', 'treadmill', 'bicycle', 'camping', 'fishing', 'golf']],
];

// When nothing in the name matches, the store is a weak hint.
const STORE_HINTS = { newegg: 'Electronics & Computers', homedepot: 'Building & Repair Materials' };

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'pack', 'count', 'size', 'set', 'new', 'each', 'value', 'members', 'mark', 'great', 'black', 'white', 'inch', 'oz', 'lb', 'ct']);
const LEARN_MIN_EVIDENCE = 2; // corrected items needed before a word counts
const LEARN_MIN_SHARE = 0.6; // how clearly those words point at one category

const singular = (word) =>
  word.length > 3 && word.endsWith('ies')
    ? `${word.slice(0, -3)}y`
    : word.length > 3 && word.endsWith('s') && !word.endsWith('ss')
      ? word.slice(0, -1)
      : word;

// The key an item is remembered by: the same product name, however it's capitalised.
function nameKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const normalize = (name) => ` ${nameKey(name).split(' ').map(singular).join(' ')} `;

const RULES = CATEGORIES.map(([name, , , keywords], order) => ({
  name,
  order,
  keywords: keywords.map((keyword) => ({ text: ` ${keyword.toLowerCase().split(' ').map(singular).join(' ')} `, weight: keyword.split(' ').length })),
}));

function ruleMatch(name) {
  const text = normalize(name);
  let best = null;
  for (const rule of RULES) {
    let score = 0;
    for (const keyword of rule.keywords) {
      if (text.includes(keyword.text)) score += keyword.weight * keyword.weight; // a phrase beats single words
    }
    if (score && (!best || score > best.score)) best = { category: rule.name, score };
  }
  return best;
}

const wordsOf = (name) =>
  normalize(name)
    .trim()
    .split(' ')
    .filter((word) => word.length >= 3 && !/\d/.test(word) && !STOP_WORDS.has(word));

// overrides: [{ name, category }]. Builds what the corrections teach, then classifies.
function createClassifier(overrides) {
  const exact = new Map();
  const wordCounts = new Map(); // word -> Map(category -> number of corrected items)
  for (const { name, category } of overrides) {
    exact.set(nameKey(name), category);
    for (const word of new Set(wordsOf(name))) {
      if (!wordCounts.has(word)) wordCounts.set(word, new Map());
      const counts = wordCounts.get(word);
      counts.set(category, (counts.get(category) || 0) + 1);
    }
  }

  function learned(name) {
    const votes = new Map();
    let total = 0;
    for (const word of new Set(wordsOf(name))) {
      const counts = wordCounts.get(word);
      if (!counts) continue;
      const seen = [...counts.values()].reduce((sum, n) => sum + n, 0);
      if (seen < LEARN_MIN_EVIDENCE) continue;
      for (const [category, n] of counts) votes.set(category, (votes.get(category) || 0) + n);
      total += seen;
    }
    if (!total) return null;
    const [category, count] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    return count / total >= LEARN_MIN_SHARE ? category : null;
  }

  return function classify(name, store) {
    const yours = exact.get(nameKey(name));
    if (yours) return { category: yours, source: 'you' };
    const fromCorrections = learned(name);
    if (fromCorrections) return { category: fromCorrections, source: 'learned' };
    const rule = ruleMatch(name);
    if (rule) return { category: rule.category, source: 'rule' };
    if (STORE_HINTS[store]) return { category: STORE_HINTS[store], source: 'store' };
    return { category: UNCATEGORIZED, source: 'none' };
  };
}

module.exports = { CATEGORIES, UNCATEGORIZED, createClassifier, nameKey };

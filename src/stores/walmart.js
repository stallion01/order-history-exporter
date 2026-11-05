globalThis.OHE.registerStore(
  globalThis.OHE.walmartFamilyStore({
    id: 'walmart',
    name: 'Walmart',
    origin: 'https://www.walmart.com',
    hosts: ['www.walmart.com'],
    itemLink: 'a[href*="/ip/"]',
    loginPath: '/account/login',
  })
);

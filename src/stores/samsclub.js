globalThis.OHE.registerStore(
  globalThis.OHE.walmartFamilyStore({
    id: 'samsclub',
    name: "Sam's Club",
    origin: 'https://www.samsclub.com',
    hosts: ['www.samsclub.com'],
    itemLink: 'a[href*="/ip/"], a[href*="/p/"]',
    loginPath: '/login',
  })
);

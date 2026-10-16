const path = require("node:path");
const { createRequire } = require("node:module");

describe("symbol engine module identity", () => {
  let pack, cachedBeforeActivation;
  const currentRequire = () => createRequire(path.join(pack.path, "package.json"));

  beforeEach(async () => {
    if (lumine.packages.isPackageLoaded("symbol")) await lumine.packages.unloadPackage("symbol");
    // Other spec files import helpers during collection, before the package
    // owns that graph. A bootstrap must not evaluate any additional helper.
    cachedBeforeActivation = new Set(Object.values(require.cache));
    pack = await lumine.packages.activatePackage("symbol");
  });

  afterEach(async () => {
    await lumine.packages.unloadPackage("symbol");
  });

  it("publishes the synchronous registry without evaluating additional compatibility modules", () => {
    for (const name of ["config", "provider-broker"]) {
      const filename = path.join(pack.path, "lib", `${name}.js`);
      const added = Object.values(require.cache).filter(
        (entry) => entry?.filename === filename && !cachedBeforeActivation.has(entry),
      );
      expect(added.length).withContext(name).toBe(0);
    }
    const Registry = currentRequire()("./lib/registry");
    const broker = currentRequire()("./lib/provider-broker");
    const config = currentRequire()("./lib/config");
    expect(pack.mainModule.provideSymbolRegistry()).toBe(pack.mainModule.service);
    expect(pack.mainModule.registry instanceof Registry).toBe(true);
    expect(pack.mainModule.registry.broker instanceof broker).toBe(true);
    expect(config).toBe(Registry.Config);
    expect(config.activated).toBe(true);
    expect(Object.keys(Registry)).toEqual([]);
  });

  for (const helper of ["config", "provider-broker"]) {
    it(`shares the engine when ${helper} is required before the package main module`, async () => {
      await lumine.packages.unloadPackage("symbol");
      const early = currentRequire()(`./lib/${helper}`);
      pack = await lumine.packages.activatePackage("symbol");
      const Registry = currentRequire()("./lib/registry");
      expect(pack.mainModule.registry instanceof Registry).toBe(true);
      if (helper === "config") {
        expect(Registry.Config).toBe(early);
        expect(early.activated).toBe(true);
      } else {
        expect(Registry.ProviderBroker).toBe(early);
        expect(pack.mainModule.registry.broker instanceof early).toBe(true);
      }
    });
  }

  it("retires the old registry and reacquires the config singleton and broker after reload", async () => {
    const old = currentRequire()("./lib/registry");
    const registry = pack.mainModule.registry;
    await lumine.packages.unloadPackage("symbol");
    expect(registry.destroyed).toBe(true);
    expect(old.Config.activated).toBe(false);
    pack = await lumine.packages.activatePackage("symbol");
    const fresh = currentRequire()("./lib/registry");
    expect(fresh).not.toBe(old);
    expect(fresh.Config).not.toBe(old.Config);
    expect(fresh.ProviderBroker).not.toBe(old.ProviderBroker);
    expect(currentRequire()("./lib/config")).toBe(fresh.Config);
    expect(currentRequire()("./lib/provider-broker")).toBe(fresh.ProviderBroker);
    expect(fresh.Config.activated).toBe(true);
    expect(pack.mainModule.registry.broker instanceof fresh.ProviderBroker).toBe(true);
  });
});

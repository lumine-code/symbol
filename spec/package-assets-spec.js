const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));

// Keep the split provider roles and their public documentation in sync.
describe("symbol package assets", () => {
  it("ships the renamed keymap and stylesheet", () => {
    expect(exists("keymaps/main.json")).toBe(true);
    expect(exists("styles/main.css")).toBe(true);
    expect(exists("keymaps/symbols-view.json")).toBe(false);
    expect(exists("styles/symbols-view.css")).toBe(false);
  });

  it("uses the symbol: command prefix in the keymap", () => {
    const keymap = read("keymaps/main.json");
    expect(keymap).toContain("symbol:toggle-file-symbols");
    expect(keymap).toContain("symbol:toggle-project-symbols");
    expect(keymap).not.toContain("symbols-view:");
  });

  it("scopes the stylesheet to the renamed class root", () => {
    const css = read("styles/main.css");
    expect(css).toContain("lumine-panel.modal.symbol");
    expect(css).toContain(".symbol-badge-variant-0");
    expect(css).toContain(".symbol-badge-variant-f");
    expect(css).not.toContain("symbols-view");
  });

  it("is named `symbol` and points its metadata at the renamed repository", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("symbol");
    expect(pkg.author).toBe("lumine-code");
    expect(pkg.repository).toBe("https://github.com/lumine-code/symbol");
    expect(pkg.bugs.url).toBe("https://github.com/lumine-code/symbol/issues");
    expect(pkg.main).toBe("./lib/main");
    const contribution = require("../lib/main").provideBackgroundTips();
    expect(contribution.packageName).toBe("symbol");
    expect(contribution.tips.join("")).toContain("symbol:toggle-file-symbols");
  });

  it("provides the registry and consumes separate document, workspace and definition roles", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.providedServices["symbol.registry"].versions["1.1.0"]).toBe("provideSymbolRegistry");
    expect(pkg.providedServices["hyperclick.provider"].versions["1.0.0"]).toBe("provideHyperclick");
    expect(pkg.providedServices["background-tips.provider"].versions["1.0.0"]).toBe(
      "provideBackgroundTips",
    );
    for (const [role, method] of [
      ["document", "consumeDocumentSymbolProvider"],
      ["workspace", "consumeWorkspaceSymbolProvider"],
      ["definition", "consumeDefinitionProvider"],
    ])
      expect(pkg.consumedServices[`symbol.${role}-provider`].versions["^1.0.0"]).toBe(method);
    expect(Object.keys(pkg.consumedServices)).toEqual([
      "symbol.document-provider",
      "symbol.workspace-provider",
      "symbol.definition-provider",
    ]);
  });

  it("defines the config schema under the symbol namespace without order keys", () => {
    const pkg = JSON.parse(read("package.json"));
    const schema = pkg.configSchema;
    expect(Object.keys(schema).sort()).toEqual([
      "enableDebugLogging",
      "preferCertainProviders",
      "prefillSelectedText",
      "providerTimeout",
      "quickJumpToFileSymbol",
      "showIcons",
      "showProviderNames",
      "useBadgeColors",
    ]);
    for (const entry of Object.values(schema)) {
      expect(entry.order).toBeUndefined();
      expect(entry.title).toBeDefined();
      expect(entry.description).toBeDefined();
      expect(entry.type).toBeDefined();
      // `default` must be the last key of every entry.
      const keys = Object.keys(entry);
      expect(keys[keys.length - 1]).toBe("default");
    }
  });

  it("keeps the README description in sync with package.json", () => {
    const pkg = JSON.parse(read("package.json"));
    const lines = read("README.md").split(/\r?\n/);
    expect(lines[0]).toBe("# symbol");
    const sentence = lines.find((line, index) => index > 0 && line.trim().length > 0);
    expect(sentence).toBe(pkg.description);
  });

  it("ships a contract document for every owned service", () => {
    expect(exists("docs/symbol.document-provider.md")).toBe(true);
    expect(exists("docs/symbol.workspace-provider.md")).toBe(true);
    expect(exists("docs/symbol.definition-provider.md")).toBe(true);
    expect(exists("docs/symbol.registry.md")).toBe(true);
    // `hyperclick.provider` is owned by its consumer, the hyperclick package.
    expect(exists("docs/hyperclick.provider.md")).toBe(false);
  });

  it("has no leftover symbols-view references in lib", () => {
    const libDir = path.join(root, "lib");
    for (const file of fs.readdirSync(libDir)) {
      const src = fs.readFileSync(path.join(libDir, file), "utf8");
      expect(src).not.toContain("symbols-view");
    }
  });
});

const path = require("path");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/temp");
const SymbolListView = require("../lib/symbol-list-view");

const DummyProvider = require("./fixtures/providers/dummy-provider");
const SecondDummyProvider = require("./fixtures/providers/second-dummy-provider");
const AsyncDummyProvider = require("./fixtures/providers/async-provider");
const ProgressiveProjectProvider = require("./fixtures/providers/progressive-project-provider.js");
const QuicksortProvider = require("./fixtures/providers/quicksort-provider.js");
const VerySlowProvider = require("./fixtures/providers/very-slow-provider");
const HangingProvider = require("./fixtures/providers/hanging-provider");
const UselessProvider = require("./fixtures/providers/useless-provider.js");
const EmptyProvider = require("./fixtures/providers/empty-provider.js");
const TaggedProvider = require("./fixtures/providers/tagged-provider.js");
const CacheClearingProvider = require("./fixtures/providers/cache-clearing-provider.js");
const CompetingExclusiveProvider = require("./fixtures/providers/competing-exclusive-provider.js");
const AbortHonoringProvider = require("./fixtures/providers/abort-honoring-provider.js");
const LateProvider = require("./fixtures/providers/late-provider.js");

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The views here are select-list's, which render on select-list's own copy of
// etch. This package's copy schedules nothing, so flushing it would wait on an
// empty queue; wait on the registry both copies are pointed at instead.
function getOrScheduleUpdatePromise() {
  return new Promise((resolve) => lumine.views.updateDocument(resolve));
}

function choiceCount(symbolsView) {
  return symbolsView.element.querySelectorAll("li").length;
}

function getWorkspaceView() {
  return lumine.views.getView(lumine.workspace);
}

function getEditor() {
  return lumine.workspace.getActiveTextEditor();
}

function getEditorView() {
  return lumine.views.getView(lumine.workspace.getActiveTextEditor());
}

function getSymbolsView() {
  return lumine.workspace.getModalPanels()[0]?.item;
}

// A toggle empties the list before it repopulates it, but that teardown is an
// etch update, so it only reaches the DOM on an animation frame. A poll that
// starts before that frame counts the rows of the *previous* toggle and
// resolves on them — with this toggle's providers not yet asked for anything.
// Flushing the document on the way in, and again on every poll, is what makes
// a rendered row mean that this dispatch rendered it: the wait then cannot
// outrun the fetch behind it, however hard the host is throttling frames.
async function dispatchAndWaitForChoices(commandName) {
  await getOrScheduleUpdatePromise();
  lumine.commands.dispatch(getEditorView(), commandName);
  let symbolsView = lumine.workspace.getModalPanels()[0].item;
  await conditionPromise(async () => {
    await getOrScheduleUpdatePromise();
    let count = symbolsView.element.querySelectorAll("li").length;
    return count > 0;
  }, `choices to render for ${commandName}`);
}

// A provider that clears its own cached results does so from a timer it starts
// inside `getSymbols`, so the invalidation lands some time after the list that
// prompted it has rendered. Wait for the registry to actually be in that state
// rather than for a duration that guesses at it.
function waitForProviderInvalidation(registry, editor, provider) {
  return conditionPromise(
    () => registry.invalidatedProviders.get(editor)?.has(provider),
    `${provider.name} to have its cached tags invalidated`,
  );
}

function registerProvider(...args) {
  let pkg = lumine.packages.getActivePackage("symbol");
  let main = pkg?.mainModule;
  if (!main) {
    let disposable = lumine.packages.onDidActivatePackage((pack) => {
      if (pack.name !== "symbol") return;
      for (let provider of args) {
        pack.mainModule.consumeSymbol(provider);
      }
      disposable.dispose();
    });
    // If we let the package lazy-activate the first time a command is invoked,
    // we lose an opportunity to add mock providers. So we should activate it
    // manually.
    lumine.packages.getLoadedPackage("symbol").activateNow();
  } else {
    for (let provider of args) {
      main.consumeSymbol(provider);
    }
  }
}

describe("symbol", () => {
  let symbolsView, activationPromise, editor, directory, mainModule, languageMode;

  beforeEach(async () => {
    jasmine.unspy(Date, "now");
    jasmine.unspy(global, "setTimeout");

    lumine.project.setPaths([temp.mkdirSync("other-dir-"), temp.mkdirSync("symbol-spec-")]);

    directory = lumine.project.getDirectories()[1];

    fs.copySync(path.join(__dirname, "fixtures", "js"), lumine.project.getPaths()[1]);

    lumine.config.set("symbol.showProviderNames", false);
    lumine.config.set("symbol.showIcons", false);

    activationPromise = lumine.packages.activatePackage("symbol");
    await activationPromise.then(() => {
      mainModule = lumine.packages.getActivePackage("symbol").mainModule;
    });
    await lumine.packages.activatePackage("language-javascript");
    jasmine.attachToDOM(getWorkspaceView());
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("symbol");
  });

  describe("when toggling file symbols", () => {
    beforeEach(async () => {
      lumine.config.set("symbol.providerTimeout", 500);
      await lumine.workspace.open(directory.resolve("sample.js"));
      editor = lumine.workspace.getActiveTextEditor();
      languageMode = editor.getBuffer().getLanguageMode();
      if (languageMode.ready) await languageMode.ready;
    });

    it("displays all symbols with line numbers", async () => {
      registerProvider(DummyProvider);
      await activationPromise;
      await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
      symbolsView = getSymbolsView();

      expect(symbolsView.selectListView.refs.loadingMessage).toBeUndefined();
      expect(document.body.contains(symbolsView.element)).toBe(true);
      expect(symbolsView.element.querySelectorAll("li").length).toBe(5);

      expect(symbolsView.element.querySelector("li:first-child .primary-line")).toHaveText(
        "Symbol on Row 1",
      );
      expect(symbolsView.element.querySelector("li:first-child .secondary-line")).toHaveText(
        "Line 1",
      );
      expect(symbolsView.element.querySelector("li:last-child .primary-line")).toHaveText(
        "Symbol on Row 13",
      );
      expect(symbolsView.element.querySelector("li:last-child .secondary-line")).toHaveText(
        "Line 13",
      );

      // No icon-related classes should be added when `showIconsInSymbolsView`
      // is false.
      expect(
        symbolsView.element
          .querySelector("li:first-child .primary-line")
          .classList.contains("icon"),
      ).toBe(false);
      expect(
        symbolsView.element
          .querySelector("li:first-child .primary-line")
          .classList.contains("no-icon"),
      ).toBe(false);
    });

    it("prefills the query field if `prefillSelectedText` is `true`", async () => {
      lumine.config.set("symbol.prefillSelectedText", true);
      registerProvider(DummyProvider);
      await activationPromise;
      spyOn(editor, "getSelectedText").and.returnValue("Symbol on Row 13");
      await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
      symbolsView = getSymbolsView();

      expect(symbolsView.selectListView.refs.loadingMessage).toBeUndefined();
      expect(document.body.contains(symbolsView.element)).toBe(true);
      expect(symbolsView.element.querySelectorAll("li").length).toBe(1);

      expect(symbolsView.element.querySelector("li:first-child .primary-line")).toHaveText(
        "Symbol on Row 13",
      );
      expect(symbolsView.element.querySelector("li:first-child .secondary-line")).toHaveText(
        "Line 13",
      );

      // We reach inside of the `SelectListView` instance to its `TextEditor`
      // so that we can assert that the text in the query field is selected.
      // This allows the user to start typing and replace the prefilled
      // selection if they didn't mean to prefill the query.
      expect(symbolsView.selectListView.refs.queryEditor.getSelectedText()).toBe(
        "Symbol on Row 13",
      );
    });

    it("does not use a mini editor's selection as a symbol query", () => {
      lumine.config.set("symbol.prefillSelectedText", true);
      const miniEditor = lumine.workspace.buildTextEditor({ mini: true });
      const miniElement = lumine.views.getView(miniEditor);
      miniEditor.setText("mini selection");
      miniEditor.selectAll();

      try {
        expect(mainModule.getSelectedTextIfEnabled({ target: miniElement })).toBe("");
      } finally {
        miniEditor.destroy();
      }
    });

    it("does not prefill the query field if `prefillSelectedText` is `false`", async () => {
      lumine.config.set("symbol.prefillSelectedText", false);
      registerProvider(DummyProvider);
      await activationPromise;
      spyOn(editor, "getSelectedText").and.returnValue("Symbol on Row 13");
      await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
      symbolsView = getSymbolsView();

      expect(symbolsView.selectListView.refs.loadingMessage).toBeUndefined();
      expect(document.body.contains(symbolsView.element)).toBe(true);
      expect(symbolsView.element.querySelectorAll("li").length).toBe(5);

      expect(symbolsView.element.querySelector("li:first-child .primary-line")).toHaveText(
        "Symbol on Row 1",
      );
      expect(symbolsView.element.querySelector("li:first-child .secondary-line")).toHaveText(
        "Line 1",
      );
      expect(symbolsView.element.querySelector("li:last-child .primary-line")).toHaveText(
        "Symbol on Row 13",
      );
      expect(symbolsView.element.querySelector("li:last-child .secondary-line")).toHaveText(
        "Line 13",
      );
    });

    it("does not wait for providers that take too long", async () => {
      registerProvider(DummyProvider, VerySlowProvider);
      await activationPromise;
      expect(mainModule.registry.broker.providers.length).toBe(2);
      lumine.commands.dispatch(getEditorView(), "symbol:toggle-file-symbols");

      symbolsView = lumine.workspace.getModalPanels()[0].item;
      await conditionPromise(async () => {
        await getOrScheduleUpdatePromise();
        let count = symbolsView.element.querySelectorAll("li").length;
        return count > 0;
      });

      expect(symbolsView.selectListView.refs.loadingMessage).toBeUndefined();
      expect(document.body.contains(symbolsView.element)).toBe(true);
      expect(symbolsView.element.querySelectorAll("li").length).toBe(5);

      expect(symbolsView.element.querySelector("li:first-child .primary-line")).toHaveText(
        "Symbol on Row 1",
      );
      expect(symbolsView.element.querySelector("li:first-child .secondary-line")).toHaveText(
        "Line 1",
      );
      expect(symbolsView.element.querySelector("li:last-child .primary-line")).toHaveText(
        "Symbol on Row 13",
      );
      expect(symbolsView.element.querySelector("li:last-child .secondary-line")).toHaveText(
        "Line 13",
      );
    });

    it("does not report a provider for honoring the timeout we set for it", async () => {
      // `AbortHonoringProvider` does what `docs/symbol.provider.md` asks of a
      // cancelled provider: it stops and comes back with nothing. Cancelling it
      // was our decision, so empty hands are the contract working rather than a
      // provider failing us, and saying otherwise blames it for our own budget.
      registerProvider(DummyProvider, AbortHonoringProvider);
      await activationPromise;
      spyOn(console, "error").and.callThrough();

      await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
      symbolsView = getSymbolsView();
      expect(choiceCount(symbolsView)).toBe(5);

      // Wait for the moment it gives up rather than sleeping past it.
      await AbortHonoringProvider.answered;
      await getOrScheduleUpdatePromise();

      expect(console.error).not.toHaveBeenCalled();
    });

    it("ignores symbols that arrive after it has given up on the provider", async () => {
      // `LateProvider` ignores its signal and answers long after the budget has
      // run out — the one way symbols can still show up once the list has been
      // rendered and stored. Taking them would leave the straggler out of order
      // on screen, or invisible until the cached list is served again.
      registerProvider(DummyProvider, LateProvider);
      await activationPromise;

      await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
      symbolsView = getSymbolsView();
      expect(choiceCount(symbolsView)).toBe(5);

      await LateProvider.answered;
      await getOrScheduleUpdatePromise();

      expect(choiceCount(symbolsView)).toBe(5);
      expect(mainModule.registry.cache.get(editor).length).toBe(5);
    });

    it("skips providers that hang while answering canProvideSymbols", async () => {
      // `VerySlowProvider` answers `canProvideSymbols` instantly; only its
      // `getSymbols` is slow. `HangingProvider` never resolves
      // `canProvideSymbols`, so the broker must time it out and still return the
      // responsive provider rather than waiting forever.
      registerProvider(VerySlowProvider, HangingProvider);
      await activationPromise;
      expect(mainModule.registry.broker.providers.length).toBe(2);

      let meta = { type: "file", editor, paths: lumine.project.getPaths() };
      let selected = await mainModule.registry.broker.select(meta);
      let names = selected.map((provider) => provider.name);

      expect(names).toContain("Very Slow");
      expect(names).not.toContain("Hanging");
    });

    it("allows the exclusive provider to control certain UI aspects", async () => {
      // `AsyncDummyProvider` spends ~350ms setting and then clearing its
      // loading message, and the 500ms budget this block sets for the two
      // timeout specs above leaves that only ~150ms of headroom. A loaded
      // machine spends it: the race in `generateSymbols` picks the timeout
      // branch, the provider's symbols land after the list has already
      // rendered, and no `li` ever appears. This spec is about the
      // `ListController` privilege, not about the budget, so give the provider
      // one its own delays cannot exhaust. A provider that truly hangs still
      // fails the spec at jasmine's own five-second cap.
      lumine.config.set("symbol.providerTimeout", 30000);
      registerProvider(AsyncDummyProvider);
      await activationPromise;
      expect(mainModule.registry.broker.providers.length).toBe(1);
      lumine.commands.dispatch(getEditorView(), "symbol:toggle-file-symbols");
      symbolsView = getSymbolsView();
      spyOn(symbolsView.selectListView, "update").and.callThrough();
      await conditionPromise(async () => {
        await getOrScheduleUpdatePromise();
        let count = symbolsView.element.querySelectorAll("li").length;
        return count > 0;
      });

      expect(symbolsView.selectListView.update).toHaveBeenCalledWith({
        loadingMessage: "Loading…",
      });
    });

    it("caches tags until the editor changes", async () => {
      registerProvider(DummyProvider);
      await activationPromise;
      editor = lumine.workspace.getActiveTextEditor();
      await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
      symbolsView = lumine.workspace.getModalPanels()[0].item;
      await symbolsView.cancel();

      spyOn(DummyProvider, "getSymbols").and.callThrough();

      await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
      expect(choiceCount(symbolsView)).toBe(5);
      expect(DummyProvider.getSymbols).not.toHaveBeenCalled();
      await symbolsView.cancel();

      await editor.save();
      await dispatchAndWaitForChoices("symbol:toggle-file-symbols");

      expect(symbolsView.selectListView.refs.loadingMessage).toBeUndefined();
      expect(choiceCount(symbolsView)).toBe(5);
      expect(DummyProvider.getSymbols).toHaveBeenCalled();
      editor.destroy();
      expect(mainModule.registry.cache.get(editor)).toBeUndefined();
    });

    it("invalidates a single provider's tags if the provider asks it to", async () => {
      registerProvider(DummyProvider, CacheClearingProvider);
      await activationPromise;
      editor = lumine.workspace.getActiveTextEditor();
      await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
      symbolsView = lumine.workspace.getModalPanels()[0].item;
      expect(choiceCount(symbolsView)).toBe(6);
      await symbolsView.cancel();
      await waitForProviderInvalidation(mainModule.registry, editor, CacheClearingProvider);

      spyOn(DummyProvider, "getSymbols").and.callThrough();
      spyOn(CacheClearingProvider, "getSymbols").and.callThrough();

      await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
      expect(choiceCount(symbolsView)).toBe(6);
      expect(DummyProvider.getSymbols).not.toHaveBeenCalled();
      expect(CacheClearingProvider.getSymbols).toHaveBeenCalled();
      await symbolsView.cancel();
      // That toggle asked the provider again, so it has asked for another
      // invalidation. Let it land before the save: arriving mid-fetch, it
      // would abort the run the assertions below are about.
      await waitForProviderInvalidation(mainModule.registry, editor, CacheClearingProvider);
      await editor.save();

      expect(mainModule.registry.cache.get(editor)).toBeUndefined();

      await dispatchAndWaitForChoices("symbol:toggle-file-symbols");

      expect(symbolsView.selectListView.refs.loadingMessage).toBeUndefined();
      expect(choiceCount(symbolsView)).toBe(6);
      expect(DummyProvider.getSymbols).toHaveBeenCalled();
      expect(CacheClearingProvider.getSymbols).toHaveBeenCalled();
      editor.destroy();
      expect(mainModule.registry.cache.get(editor)).toBeUndefined();
    });

    it("displays a message when no tags match text in mini-editor", async () => {
      registerProvider(DummyProvider);
      await activationPromise;
      await dispatchAndWaitForChoices("symbol:toggle-file-symbols");

      symbolsView = getSymbolsView();
      symbolsView.selectListView.refs.queryEditor.setText("nothing will match this");

      await conditionPromise(() => symbolsView.selectListView.refs.emptyMessage);
      expect(document.body.contains(symbolsView.element)).toBe(true);
      expect(choiceCount(symbolsView)).toBe(0);

      expect(symbolsView.selectListView.refs.emptyMessage.textContent.length).toBeGreaterThan(0);

      symbolsView.selectListView.refs.queryEditor.setText("");
      await conditionPromise(() => choiceCount(symbolsView) > 0);
      expect(choiceCount(symbolsView)).toBe(5);
      expect(symbolsView.selectListView.refs.emptyMessage).toBeUndefined();
    });

    it("moves the cursor to the selected function", async () => {
      registerProvider(DummyProvider);
      await activationPromise;
      editor = lumine.workspace.getActiveTextEditor();
      expect(editor.getCursorBufferPosition()).toEqual([0, 0]);
      await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
      symbolsView = getSymbolsView();

      symbolsView.element.querySelectorAll("li")[1].click();
      // It'll move to the first non-whitespace character on the line.
      expect(editor.getCursorBufferPosition()).toEqual([3, 4]);
    });

    describe("when there are multiple exclusive providers", () => {
      describe("and none have priority in the user's settings", () => {
        it("prefers the one with the highest score", async () => {
          registerProvider(DummyProvider, CompetingExclusiveProvider);
          spyOn(CompetingExclusiveProvider, "getSymbols").and.callThrough();
          spyOn(DummyProvider, "getSymbols").and.callThrough();
          await activationPromise;
          await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
          symbolsView = getSymbolsView();
          expect(choiceCount(symbolsView)).toBe(5);
          expect(DummyProvider.getSymbols).toHaveBeenCalled();
          expect(CompetingExclusiveProvider.getSymbols).not.toHaveBeenCalled();
        });
      });

      describe("and one is listed in `preferCertainProviders`", () => {
        beforeEach(() => {
          lumine.config.set("symbol.preferCertainProviders", [
            "symbol-provider-competing-exclusive",
          ]);
        });

        it("prefers the one with the highest score (providers listed beating those not listed)", async () => {
          registerProvider(DummyProvider, CompetingExclusiveProvider);
          spyOn(CompetingExclusiveProvider, "getSymbols").and.callThrough();
          spyOn(DummyProvider, "getSymbols").and.callThrough();
          await activationPromise;
          await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
          symbolsView = getSymbolsView();
          expect(choiceCount(symbolsView)).toBe(5);
          expect(DummyProvider.getSymbols).not.toHaveBeenCalled();
          expect(CompetingExclusiveProvider.getSymbols).toHaveBeenCalled();
        });
      });

      describe("and more than one is listed in `preferCertainProviders`", () => {
        beforeEach(() => {
          // Last time we referred to this one by its package name; now we use
          // its human-friendly name. They should be interchangeable.
          lumine.config.set("symbol.preferCertainProviders", [
            "Competing Exclusive",
            "symbol-provider-dummy",
          ]);
        });

        it("prefers the one with the highest score (providers listed earlier beating those listed later)", async () => {
          registerProvider(DummyProvider, CompetingExclusiveProvider);
          spyOn(CompetingExclusiveProvider, "getSymbols").and.callThrough();
          spyOn(DummyProvider, "getSymbols").and.callThrough();
          await activationPromise;
          await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
          symbolsView = getSymbolsView();
          expect(choiceCount(symbolsView)).toBe(5);
          expect(DummyProvider.getSymbols).not.toHaveBeenCalled();
          expect(CompetingExclusiveProvider.getSymbols).toHaveBeenCalled();
        });
      });

      describe("and one has a scope-specific `preferCertainProviders` setting", () => {
        beforeEach(() => {
          // Last time we referred to this one by its package name; now we use
          // its human-friendly name. They should be interchangeable.
          lumine.config.set(
            "symbol.preferCertainProviders",
            ["Competing Exclusive", "symbol-provider-dummy"],
            { scopeSelector: ".source.js" },
          );

          lumine.config.set("symbol.preferCertainProviders", ["symbol-provider-dummy"]);
        });

        it("prefers the one with the highest score (providers listed earlier beating those listed later)", async () => {
          registerProvider(DummyProvider, CompetingExclusiveProvider);
          spyOn(CompetingExclusiveProvider, "getSymbols").and.callThrough();
          spyOn(DummyProvider, "getSymbols").and.callThrough();
          await activationPromise;
          await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
          symbolsView = getSymbolsView();
          expect(choiceCount(symbolsView)).toBe(5);
          expect(DummyProvider.getSymbols).not.toHaveBeenCalled();
          expect(CompetingExclusiveProvider.getSymbols).toHaveBeenCalled();
        });
      });
    });

    describe("when no symbols are found", () => {
      it("shows the list view with an error message", async () => {
        registerProvider(EmptyProvider);
        await activationPromise;
        lumine.commands.dispatch(getEditorView(), "symbol:toggle-file-symbols");
        await conditionPromise(() => getSymbolsView()?.selectListView.refs.emptyMessage);
        symbolsView = getSymbolsView();

        expect(document.body.contains(symbolsView.element));
        expect(choiceCount(symbolsView)).toBe(0);
        let refs = symbolsView.selectListView.refs;
        expect(refs.emptyMessage).toBeVisible();
        expect(refs.emptyMessage.textContent.length).toBeGreaterThan(0);
        expect(refs.loadingMessage).not.toBeVisible();
      });
    });

    describe("when symbols can't be generated for a file", () => {
      it("does not show the list view", async () => {
        registerProvider(UselessProvider);
        await activationPromise;
        expect(mainModule.registry.broker.providers.length).toBe(1);
        lumine.commands.dispatch(getEditorView(), "symbol:toggle-file-symbols");

        await wait(1000);
        symbolsView = lumine.workspace.getModalPanels()[0].item;

        // List view should not be visible, nor should it have any options.
        expect(symbolsView.element.querySelectorAll("li").length).toBe(0);
        expect(symbolsView.element).not.toBeVisible();
      });
    });

    describe("when the user has enabled icons in the symbols list", () => {
      beforeEach(() => {
        lumine.config.set("symbol.showIcons", true);
      });

      it("shows icons in the symbols list", async () => {
        registerProvider(DummyProvider);
        await activationPromise;
        await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
        symbolsView = getSymbolsView();

        expect(symbolsView.selectListView.refs.loadingMessage).toBeUndefined();
        expect(document.body.contains(symbolsView.element)).toBe(true);
        expect(symbolsView.element.querySelectorAll("li").length).toBe(5);

        expect(
          symbolsView.element
            .querySelector("li:first-child .primary-line")
            .classList.contains("icon-package"),
        ).toBe(true);
        expect(
          symbolsView.element
            .querySelector("li:first-child .secondary-line")
            .classList.contains("no-icon"),
        ).toBe(true);

        expect(
          symbolsView.element
            .querySelector("li:nth-child(2) .primary-line")
            .classList.contains("icon-key"),
        ).toBe(true);
        expect(
          symbolsView.element
            .querySelector("li:nth-child(3) .primary-line")
            .classList.contains("icon-gear"),
        ).toBe(true);
        expect(
          symbolsView.element
            .querySelector("li:nth-child(4) .primary-line")
            .classList.contains("icon-tag"),
        ).toBe(true);

        // Simulate lack of icon on a random element.
        expect(
          symbolsView.element
            .querySelector("li:nth-child(5) .primary-line")
            .classList.contains("no-icon"),
        ).toBe(true);
      });
    });
  });

  describe("when going to declaration", () => {
    beforeEach(async () => {
      await lumine.workspace.open(directory.resolve("sample.js"));
    });

    describe("when no declaration is found", () => {
      beforeEach(async () => {
        registerProvider(EmptyProvider);
        editor = lumine.workspace.getActiveTextEditor();
      });

      it("doesn't move the cursor", async () => {
        await activationPromise;
        editor.setCursorBufferPosition([0, 2]);
        lumine.commands.dispatch(getEditorView(), "symbol:toggle-project-symbols");
        await wait(100);

        expect(editor.getCursorBufferPosition()).toEqual([0, 2]);
      });
    });

    describe("when there is a single matching declaration", () => {
      beforeEach(async () => {
        registerProvider(TaggedProvider);
        await lumine.workspace.open(directory.resolve("tagged.js"));
        editor = lumine.workspace.getActiveTextEditor();
      });

      it("moves the cursor to the declaration", async () => {
        editor.setCursorBufferPosition([6, 24]);
        spyOn(SymbolListView.prototype, "moveToPosition").and.callThrough();

        lumine.commands.dispatch(getEditorView(), "symbol:go-to-declaration");

        await conditionPromise(() => {
          return SymbolListView.prototype.moveToPosition.calls.count() === 1;
        });
        expect(editor.getCursorBufferPosition()).toEqual([2, 0]);
      });
    });

    describe("when there is more than one matching declaration", () => {
      beforeEach(async () => {
        registerProvider(TaggedProvider);
        TaggedProvider.mockResultCount = 2;
        TaggedProvider.mockFileName = "other-file.js";
        await lumine.workspace.open(directory.resolve("tagged.js"));
        editor = lumine.workspace.getActiveTextEditor();
        await activationPromise;
      });

      afterEach(() => {
        TaggedProvider.reset();
      });

      it("displays matches and opens the selected match", async () => {
        editor.setCursorBufferPosition([8, 14]);
        lumine.commands.dispatch(getEditorView(), "symbol:go-to-declaration");
        symbolsView = getSymbolsView();

        await conditionPromise(() => {
          return symbolsView.element.querySelectorAll("li").length > 0;
        });

        expect(choiceCount(symbolsView)).toBe(2);
        expect(symbolsView.element).toBeVisible();
        spyOn(SymbolListView.prototype, "moveToPosition").and.callThrough();
        symbolsView.selectListView.confirmSelection();

        await conditionPromise(() => {
          return SymbolListView.prototype.moveToPosition.calls.count() === 1;
        });

        editor = lumine.workspace.getActiveTextEditor();

        expect(lumine.workspace.getActiveTextEditor().getPath()).toBe(
          directory.resolve("other-file.js"),
        );

        expect(lumine.workspace.getActiveTextEditor().getCursorBufferPosition()).toEqual([2, 0]);
      });
    });
  });

  describe("when returning from declaration", () => {
    describe("in the same file", () => {
      beforeEach(async () => {
        registerProvider(TaggedProvider);
        await lumine.workspace.open(directory.resolve("tagged.js"));
        await activationPromise;
        editor = lumine.workspace.getActiveTextEditor();
      });

      it("doesn't do anything when no go-tos have been triggered", async () => {
        editor.setCursorBufferPosition([6, 0]);
        lumine.commands.dispatch(getEditorView(), "symbol:return-from-declaration");

        expect(editor.getCursorBufferPosition()).toEqual([6, 0]);
      });

      it("returns to the previous row and column", async () => {
        editor.setCursorBufferPosition([6, 24]);
        editor = lumine.workspace.getActiveTextEditor();
        spyOn(SymbolListView.prototype, "moveToPosition").and.callThrough();
        lumine.commands.dispatch(getEditorView(), "symbol:go-to-declaration");

        await conditionPromise(() => {
          return SymbolListView.prototype.moveToPosition.calls.count() === 1;
        });

        expect(getEditor()).toBe(editor);

        expect(getEditor().getCursorBufferPosition()).toEqual([2, 0]);
        lumine.commands.dispatch(getEditorView(), "symbol:return-from-declaration");

        await conditionPromise(() => SymbolListView.prototype.moveToPosition.calls.count() === 2);
        expect(getEditor().getCursorBufferPosition()).toEqual([6, 24]);
      });
    });

    describe("in a different file", () => {
      beforeEach(async () => {
        registerProvider(TaggedProvider);
        await lumine.workspace.open(directory.resolve("sample.js"));
        await activationPromise;
        editor = lumine.workspace.getActiveTextEditor();
      });

      it("doesn't do anything when no go-tos have been triggered", async () => {
        editor.setCursorBufferPosition([6, 0]);
        lumine.commands.dispatch(getEditorView(), "symbol:return-from-declaration");

        expect(editor.getCursorBufferPosition()).toEqual([6, 0]);
      });

      it("returns to the previous row and column", async () => {
        editor.setCursorBufferPosition([6, 24]);
        editor = lumine.workspace.getActiveTextEditor();
        spyOn(SymbolListView.prototype, "moveToPosition").and.callThrough();
        lumine.commands.dispatch(getEditorView(), "symbol:go-to-declaration");

        await conditionPromise(() => {
          return SymbolListView.prototype.moveToPosition.calls.count() === 1;
        });

        expect(getEditor()).not.toBe(editor);

        expect(getEditor().getCursorBufferPosition()).toEqual([2, 0]);
        lumine.commands.dispatch(getEditorView(), "symbol:return-from-declaration");

        await conditionPromise(() => SymbolListView.prototype.moveToPosition.calls.count() === 2);

        expect(getEditor()).toBe(editor);
        expect(getEditor().getCursorBufferPosition()).toEqual([6, 24]);
      });

      it("returns to a different file when the file was already open", async () => {
        editor.setCursorBufferPosition([6, 24]);
        editor = lumine.workspace.getActiveTextEditor();
        spyOn(SymbolListView.prototype, "moveToPosition").and.callThrough();
        lumine.commands.dispatch(getEditorView(), "symbol:go-to-declaration");

        await conditionPromise(() => {
          return SymbolListView.prototype.moveToPosition.calls.count() === 1;
        });

        expect(getEditor()).not.toBe(editor);
        let editorPath = editor.getPath();
        let editorId = editor.id;
        lumine.workspace.getActivePane().destroyItem(editor);

        expect(getEditor().getCursorBufferPosition()).toEqual([2, 0]);
        lumine.commands.dispatch(getEditorView(), "symbol:return-from-declaration");

        await conditionPromise(() => SymbolListView.prototype.moveToPosition.calls.count() === 2);

        // Make sure this is a different instance of TextEditor for the same
        // path.
        expect(getEditor().getPath()).toBe(editorPath);
        expect(getEditor().id).not.toBe(editorId);
        expect(getEditor().getCursorBufferPosition()).toEqual([6, 24]);
      });
    });
  });

  describe("when toggling project symbols", () => {
    beforeEach(async () => {
      await lumine.workspace.open(directory.resolve("sample.js"));
      editor = lumine.workspace.getActiveTextEditor();
    });

    it("displays all symbols", async () => {
      registerProvider(DummyProvider);
      await activationPromise;
      await dispatchAndWaitForChoices("symbol:toggle-project-symbols");
      symbolsView = lumine.workspace.getModalPanels()[0].item;

      expect(symbolsView.selectListView.refs.loadingMessage).toBeUndefined();
      expect(document.body.contains(symbolsView.element)).toBe(true);
      expect(symbolsView.element.querySelectorAll("li").length).toBe(5);

      let root = lumine.project.getPaths()[1];
      let resolved = directory.resolve("other-file.js");
      let relative = `${path.basename(root)}${resolved.replace(root, "")}`;

      expect(symbolsView.element.querySelector("li:first-child .primary-line")).toHaveText(
        "Symbol on Row 1",
      );
      expect(symbolsView.element.querySelector("li:first-child .secondary-line")).toHaveText(
        `${relative}:1`,
      );
      expect(symbolsView.element.querySelector("li:last-child .primary-line")).toHaveText(
        "Symbol on Row 13",
      );
      expect(symbolsView.element.querySelector("li:last-child .secondary-line")).toHaveText(
        `${relative}:13`,
      );
    });

    it("prefills the query field if `prefillSelectedText` is `true`", async () => {
      lumine.config.set("symbol.prefillSelectedText", true);
      registerProvider(DummyProvider);
      await activationPromise;
      spyOn(editor, "getSelectedText").and.returnValue("Symbol on Row 13");
      await dispatchAndWaitForChoices("symbol:toggle-project-symbols");
      symbolsView = getSymbolsView();

      expect(symbolsView.selectListView.refs.loadingMessage).toBeUndefined();
      expect(document.body.contains(symbolsView.element)).toBe(true);
      expect(symbolsView.element.querySelectorAll("li").length).toBe(1);

      let root = lumine.project.getPaths()[1];
      let resolved = directory.resolve("other-file.js");
      let relative = `${path.basename(root)}${resolved.replace(root, "")}`;

      expect(symbolsView.element.querySelector("li:first-child .primary-line")).toHaveText(
        "Symbol on Row 13",
      );
      expect(symbolsView.element.querySelector("li:first-child .secondary-line")).toHaveText(
        `${relative}:13`,
      );
    });

    it("includes results from all providers, even if they claim to be exclusive", async () => {
      registerProvider(DummyProvider);
      registerProvider(SecondDummyProvider);

      await dispatchAndWaitForChoices("symbol:toggle-project-symbols");
      symbolsView = lumine.workspace.getModalPanels()[0].item;

      expect(symbolsView.selectListView.refs.loadingMessage).toBeUndefined();
      expect(document.body.contains(symbolsView.element)).toBe(true);
      expect(symbolsView.element.querySelectorAll("li").length).toBe(10);

      let root = lumine.project.getPaths()[1];
      let resolved = directory.resolve("other-file.js");
      let relative = `${path.basename(root)}${resolved.replace(root, "")}`;

      expect(symbolsView.element.querySelector("li:first-child .primary-line")).toHaveText(
        "Symbol on Row 1",
      );
      expect(symbolsView.element.querySelector("li:first-child .secondary-line")).toHaveText(
        `${relative}:1`,
      );
      expect(symbolsView.element.querySelector("li:last-child .primary-line")).toHaveText(
        "(Second) Symbol on Row 13",
      );
      expect(symbolsView.element.querySelector("li:last-child .secondary-line")).toHaveText(
        `${relative}:13`,
      );
    });

    it("does not prefill the query field if `prefillSelectedText` is `false`", async () => {
      lumine.config.set("symbol.prefillSelectedText", false);
      registerProvider(DummyProvider);
      await activationPromise;
      spyOn(editor, "getSelectedText").and.returnValue("Symbol on Row 13");
      await dispatchAndWaitForChoices("symbol:toggle-project-symbols");
      symbolsView = lumine.workspace.getModalPanels()[0].item;

      expect(symbolsView.selectListView.refs.loadingMessage).toBeUndefined();
      expect(document.body.contains(symbolsView.element)).toBe(true);
      expect(symbolsView.element.querySelectorAll("li").length).toBe(5);

      let root = lumine.project.getPaths()[1];
      let resolved = directory.resolve("other-file.js");
      let relative = `${path.basename(root)}${resolved.replace(root, "")}`;

      expect(symbolsView.element.querySelector("li:first-child .primary-line")).toHaveText(
        "Symbol on Row 1",
      );
      expect(symbolsView.element.querySelector("li:first-child .secondary-line")).toHaveText(
        `${relative}:1`,
      );
      expect(symbolsView.element.querySelector("li:last-child .primary-line")).toHaveText(
        "Symbol on Row 13",
      );
      expect(symbolsView.element.querySelector("li:last-child .secondary-line")).toHaveText(
        `${relative}:13`,
      );
    });

    it("asks for new symbols when the user starts typing", async () => {
      registerProvider(ProgressiveProjectProvider);
      spyOn(ProgressiveProjectProvider, "getSymbols").and.callThrough();
      await activationPromise;
      lumine.commands.dispatch(getEditorView(), "symbol:toggle-project-symbols");
      symbolsView = lumine.workspace.getModalPanels()[0].item;
      await wait(2000);

      expect(symbolsView.element.querySelectorAll("li .primary-line").length).toBe(0);
      expect(ProgressiveProjectProvider.getSymbols.calls.count()).toBe(1);

      expect(symbolsView.selectListView.props.emptyMessage).toBe(
        "Query must be at least 3 characters long.",
      );

      await symbolsView.updateView({ query: "lor" });
      await wait(2000);

      expect(symbolsView.selectListView.props.emptyMessage).toBeNull();

      expect(symbolsView.element.querySelectorAll("li .primary-line").length).toBe(1);
      expect(symbolsView.element.querySelector("li:first-child .primary-line")).toHaveText(
        "Lorem ipsum",
      );
      expect(ProgressiveProjectProvider.getSymbols.calls.count()).toBe(2);
    });

    describe("when there is only one project", () => {
      beforeEach(() => {
        lumine.project.setPaths([directory.getPath()]);
      });

      it("does not include the root directory's name when displaying the symbol's filename", async () => {
        registerProvider(TaggedProvider);
        await lumine.workspace.open(directory.resolve("tagged.js"));
        await activationPromise;
        expect(getWorkspaceView().querySelector(".symbol")).toBeNull();
        await dispatchAndWaitForChoices("symbol:toggle-project-symbols");
        symbolsView = getSymbolsView();

        expect(choiceCount(symbolsView)).toBe(1);

        expect(symbolsView.element.querySelector("li:first-child .primary-line")).toHaveText(
          "callMeMaybe",
        );
        expect(symbolsView.element.querySelector("li:first-child .secondary-line")).toHaveText(
          "tagged.js:3",
        );
      });
    });

    describe("when selecting a tag", () => {
      describe("when the file doesn't exist", () => {
        beforeEach(async () => fs.removeSync(directory.resolve("tagged.js")));

        it("doesn't open the editor", async () => {
          registerProvider(TaggedProvider);
          await activationPromise;
          await dispatchAndWaitForChoices("symbol:toggle-project-symbols");
          symbolsView = getSymbolsView();

          spyOn(lumine.workspace, "open").and.callThrough();

          symbolsView.element.querySelector("li:first-child").click();

          await conditionPromise(() => symbolsView.selectListView.refs.statusMessage);

          expect(lumine.workspace.open).not.toHaveBeenCalled();
          const status = symbolsView.selectListView.refs.statusMessage;
          expect(status.textContent.length).toBeGreaterThan(0);
          expect(status.classList.contains("text-error")).toBe(true);
        });
      });
    });

    describe("match highlighting", () => {
      beforeEach(async () => {
        await lumine.workspace.open(directory.resolve("sample.js"));
        editor = lumine.workspace.getActiveTextEditor();
        registerProvider(QuicksortProvider);
      });

      it("highlights an exact match", async () => {
        await activationPromise;
        await dispatchAndWaitForChoices("symbol:toggle-file-symbols");

        symbolsView = getSymbolsView();
        symbolsView.selectListView.refs.queryEditor.setText("quicksort");
        await getOrScheduleUpdatePromise();
        let resultView = symbolsView.element.querySelector(".selected");
        let matches = resultView.querySelectorAll(".character-match");
        expect(matches.length).toBe(1);
        expect(matches[0].textContent).toBe("quicksort");
      });

      it("highlights a partial match", async () => {
        await activationPromise;
        await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
        symbolsView = getSymbolsView();

        symbolsView.selectListView.refs.queryEditor.setText("quick");
        await getOrScheduleUpdatePromise();

        let resultView = symbolsView.element.querySelector(".selected");
        let matches = resultView.querySelectorAll(".character-match");
        expect(matches.length).toBe(1);
        expect(matches[0].textContent).toBe("quick");
      });

      it("highlights multiple matches in the symbol name", async () => {
        await activationPromise;
        await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
        symbolsView = getSymbolsView();

        symbolsView.selectListView.refs.queryEditor.setText("quicort");
        await getOrScheduleUpdatePromise();

        let resultView = symbolsView.element.querySelector(".selected");
        let matches = resultView.querySelectorAll(".character-match");
        expect(matches.length).toBe(2);
        expect(matches[0].textContent).toBe("quic");
        expect(matches[1].textContent).toBe("ort");
      });
    });

    describe("when quickJumpToSymbol is true", () => {
      beforeEach(async () => {
        await lumine.workspace.open(directory.resolve("sample.js"));
        editor = lumine.workspace.getActiveTextEditor();
        languageMode = editor.getBuffer().getLanguageMode();
        if (languageMode.ready) await languageMode.ready;
      });

      it("jumps to the selected function", async () => {
        registerProvider(DummyProvider);
        await activationPromise;
        editor = lumine.workspace.getActiveTextEditor();
        expect(editor.getCursorBufferPosition()).toEqual([0, 0]);
        await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
        symbolsView = getSymbolsView();

        symbolsView.selectListView.selectNext();

        expect(editor.getCursorBufferPosition()).toEqual([3, 4]);
      });

      // NOTE: If this test fails, could it have been because you opened the
      // dev tools console? That seems to break it on a reliable basis. Not
      // sure why yet.
      it("restores previous editor state on cancel", async () => {
        lumine.config.set("symbol.prefillSelectedText", false);
        registerProvider(DummyProvider);
        await activationPromise;
        const bufferRanges = [{ start: { row: 0, column: 0 }, end: { row: 0, column: 3 } }];
        editor = lumine.workspace.getActiveTextEditor();
        editor.setSelectedBufferRanges(bufferRanges);

        await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
        symbolsView = getSymbolsView();

        symbolsView.selectListView.selectNext();
        expect(editor.getCursorBufferPosition()).toEqual([3, 4]);

        await symbolsView.didCancelSelection();
        expect(editor.getSelectedBufferRanges()).toEqual(bufferRanges);
      });
    });

    describe("when quickJumpToSymbol is false", () => {
      beforeEach(async () => {
        lumine.config.set("symbol.quickJumpToFileSymbol", false);
        await lumine.workspace.open(directory.resolve("sample.js"));
      });

      it("won't jump to the selected function", async () => {
        registerProvider(DummyProvider);
        await activationPromise;
        editor = lumine.workspace.getActiveTextEditor();
        expect(editor.getCursorBufferPosition()).toEqual([0, 0]);

        await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
        symbolsView = getSymbolsView();
        symbolsView.selectListView.selectNext();
        expect(editor.getCursorBufferPosition()).toEqual([0, 0]);
      });
    });
  });
});

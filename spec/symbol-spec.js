const path = require("path");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/fs-temp");
const { Icon } = require("lumine");
let SymbolListView;

const DummyProvider = require("./fixtures/providers/dummy-provider");
const SecondDummyProvider = require("./fixtures/providers/second-dummy-provider");
const QuicksortProvider = require("./fixtures/providers/quicksort-provider.js");
const VerySlowProvider = require("./fixtures/providers/very-slow-provider");
const HangingProvider = require("./fixtures/providers/hanging-provider");
const UselessProvider = require("./fixtures/providers/useless-provider.js");
const EmptyProvider = require("./fixtures/providers/empty-provider.js");
const TaggedProvider = require("./fixtures/providers/tagged-provider.js");
const PreferredProvider = require("./fixtures/providers/preferred-provider.js");
const AbortHonoringProvider = require("./fixtures/providers/abort-honoring-provider.js");
const LateProvider = require("./fixtures/providers/late-provider.js");

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait on the editor's document update registry so every scheduled list render
// has reached the DOM before an assertion counts its rows.
function getOrScheduleUpdatePromise() {
  return new Promise((resolve) => lumine.views.updateDocument(resolve));
}

function choiceCount(symbolsView) {
  return symbolsView.getElement().querySelectorAll("li").length;
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

function getDocumentSymbolsView() {
  const list = lumine.workspace.getModalPanels()[0]?.item;
  const main = lumine.packages.getActivePackage("symbol")?.mainModule;
  return [main?.fileView, main?.projectView, main?.goToView].find(
    (symbolsView) => symbolsView?.selectList === list,
  );
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
  let symbolsView = getDocumentSymbolsView();
  await conditionPromise(async () => {
    await getOrScheduleUpdatePromise();
    let count = symbolsView.getElement().querySelectorAll("li").length;
    return count > 0 && !symbolsView.selectList.isLoading();
  }, `choices to render for ${commandName}`);
}

// A provider that clears its own cached results does so from a timer it starts
// inside `getDocumentSymbols`, so the invalidation lands some time after the list that
// prompted it has rendered. Wait for the registry to actually be in that state
// rather than for a duration that guesses at it.
function registerRoles(main, provider) {
  if (provider.getDocumentSymbols) main.consumeDocumentSymbolProvider(provider);
  if (provider.searchWorkspaceSymbols) main.consumeWorkspaceSymbolProvider(provider);
  if (provider.getDefinitions) main.consumeDefinitionProvider(provider);
}

function registerProvider(...args) {
  let pkg = lumine.packages.getActivePackage("symbol");
  let main = pkg?.mainModule;
  if (!main) {
    let disposable = lumine.packages.onDidActivatePackage((pack) => {
      if (pack.name !== "symbol") return;
      for (let provider of args) {
        registerRoles(pack.mainModule, provider);
      }
      disposable.dispose();
    });
    // If we let the package lazy-activate the first time a command is invoked,
    // we lose an opportunity to add mock providers. So we should activate it
    // manually.
    lumine.packages.activatePackage("symbol").catch((error) => fail(error));
  } else {
    for (let provider of args) {
      registerRoles(main, provider);
    }
  }
}

describe("symbol", () => {
  let symbolsView, activationPromise, editor, directory, mainModule, languageMode, iconRegistration;

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
      SymbolListView = require("../lib/symbol-list-view");
    });
    await lumine.packages.activatePackage("language-javascript");
    jasmine.attachToDOM(getWorkspaceView());
  });

  afterEach(async () => {
    iconRegistration?.dispose();
    await lumine.packages.deactivatePackage("symbol");
  });

  it("keeps an old registration disposable from changing a new package generation", async () => {
    const provider = {
      name: "Persistent backend",
      packageName: "persistent-backend",
      getDocumentSymbolSources: () => [
        {
          id: "persistent-backend",
          name: "Persistent backend",
          shortLabel: "SP",
          score: 1,
          state: "ready",
        },
      ],
      getDocumentSymbols: () => [],
    };
    const oldRegistration = mainModule.consumeDocumentSymbolProvider(provider);
    await lumine.packages.deactivatePackage("symbol");
    await lumine.packages.activatePackage("symbol");
    mainModule = lumine.packages.getActivePackage("symbol").mainModule;
    mainModule.consumeDocumentSymbolProvider(provider);
    oldRegistration.dispose();
    expect(mainModule.registry.broker.providers.document).toContain(provider);
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
      symbolsView = getDocumentSymbolsView();

      expect(symbolsView.selectList.getLoadingState()).toBeNull();
      expect(document.body.contains(symbolsView.getElement())).toBe(true);
      expect(symbolsView.getElement().querySelectorAll("li").length).toBe(5);

      const panelElement = symbolsView.selectListHost.getPanel().getElement();
      const firstPrimaryLine = symbolsView
        .getElement()
        .querySelector("li:first-child .primary-line");
      expect(panelElement.matches("lumine-panel.modal.symbol")).toBe(true);
      expect(getComputedStyle(firstPrimaryLine).display).toBe("flex");

      expect(firstPrimaryLine).toHaveText("Symbol on Row 1");
      expect(symbolsView.getElement().querySelector("li:first-child .secondary-line")).toHaveText(
        "Line 1",
      );
      expect(symbolsView.getElement().querySelector("li:last-child .primary-line")).toHaveText(
        "Symbol on Row 13",
      );
      expect(symbolsView.getElement().querySelector("li:last-child .secondary-line")).toHaveText(
        "Line 13",
      );

      // No icon-related classes should be added when `showIconsInSymbolsView`
      // is false.
      expect(
        symbolsView
          .getElement()
          .querySelector("li:first-child .primary-line")
          .classList.contains("icon"),
      ).toBe(false);
      expect(
        symbolsView
          .getElement()
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
      symbolsView = getDocumentSymbolsView();

      expect(symbolsView.selectList.getLoadingState()).toBeNull();
      expect(document.body.contains(symbolsView.getElement())).toBe(true);
      expect(symbolsView.getElement().querySelectorAll("li").length).toBe(1);

      expect(symbolsView.getElement().querySelector("li:first-child .primary-line")).toHaveText(
        "Symbol on Row 13",
      );
      expect(symbolsView.getElement().querySelector("li:first-child .secondary-line")).toHaveText(
        "Line 13",
      );

      // The full SelectList model publicly exposes its query TextEditor so we
      // can assert that the prefilled query is selected.
      // This allows the user to start typing and replace the prefilled
      // selection if they didn't mean to prefill the query.
      expect(symbolsView.selectList.getQueryEditor().getSelectedText()).toBe("Symbol on Row 13");
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
      symbolsView = getDocumentSymbolsView();

      expect(symbolsView.selectList.getLoadingState()).toBeNull();
      expect(document.body.contains(symbolsView.getElement())).toBe(true);
      expect(symbolsView.getElement().querySelectorAll("li").length).toBe(5);

      expect(symbolsView.getElement().querySelector("li:first-child .primary-line")).toHaveText(
        "Symbol on Row 1",
      );
      expect(symbolsView.getElement().querySelector("li:first-child .secondary-line")).toHaveText(
        "Line 1",
      );
      expect(symbolsView.getElement().querySelector("li:last-child .primary-line")).toHaveText(
        "Symbol on Row 13",
      );
      expect(symbolsView.getElement().querySelector("li:last-child .secondary-line")).toHaveText(
        "Line 13",
      );
    });

    it("does not wait for providers that take too long", async () => {
      registerProvider(VerySlowProvider, DummyProvider);
      await activationPromise;
      expect(mainModule.registry.broker.providers.document.length).toBe(2);
      lumine.commands.dispatch(getEditorView(), "symbol:toggle-file-symbols");

      symbolsView = getDocumentSymbolsView();
      await conditionPromise(async () => {
        await getOrScheduleUpdatePromise();
        let count = symbolsView.getElement().querySelectorAll("li").length;
        return count > 0;
      });

      expect(symbolsView.selectList.getLoadingState()).toBeNull();
      expect(document.body.contains(symbolsView.getElement())).toBe(true);
      expect(symbolsView.getElement().querySelectorAll("li").length).toBe(5);

      expect(symbolsView.getElement().querySelector("li:first-child .primary-line")).toHaveText(
        "Symbol on Row 1",
      );
      expect(symbolsView.getElement().querySelector("li:first-child .secondary-line")).toHaveText(
        "Line 1",
      );
      expect(symbolsView.getElement().querySelector("li:last-child .primary-line")).toHaveText(
        "Symbol on Row 13",
      );
      expect(symbolsView.getElement().querySelector("li:last-child .secondary-line")).toHaveText(
        "Line 13",
      );
    });

    it("does not report a provider for honoring the timeout we set for it", async () => {
      // `AbortHonoringProvider` does what the document provider contract asks of a
      // cancelled provider: it stops and comes back with nothing. Cancelling it
      // was our decision, so empty hands are the contract working rather than a
      // provider failing us, and saying otherwise blames it for our own budget.
      registerProvider(AbortHonoringProvider, DummyProvider);
      await activationPromise;
      spyOn(console, "error").and.callThrough();

      await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
      symbolsView = getDocumentSymbolsView();
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
      registerProvider(LateProvider, DummyProvider);
      await activationPromise;

      await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
      symbolsView = getDocumentSymbolsView();
      expect(choiceCount(symbolsView)).toBe(5);

      await LateProvider.answered;
      await getOrScheduleUpdatePromise();

      expect(choiceCount(symbolsView)).toBe(5);
      expect(mainModule.registry.cache.get(editor).flat.length).toBe(5);
    });

    it("skips providers that hang while answering getDocumentSymbolSources", async () => {
      // `VerySlowProvider` answers `getDocumentSymbolSources` instantly; only its
      // `getDocumentSymbols` is slow. `HangingProvider` never resolves
      // `getDocumentSymbolSources`, so the broker must time it out and still return the
      // responsive provider rather than waiting forever.
      registerProvider(VerySlowProvider, HangingProvider);
      await activationPromise;
      expect(mainModule.registry.broker.providers.document.length).toBe(2);

      let selected = await mainModule.registry.broker.documentSources(editor);
      let names = selected.map((provider) => provider.name);

      expect(names).toContain("Very Slow");
      expect(names).not.toContain("Hanging");
    });

    it("caches tags until the editor changes", async () => {
      registerProvider(DummyProvider);
      await activationPromise;
      editor = lumine.workspace.getActiveTextEditor();
      await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
      symbolsView = getDocumentSymbolsView();
      await symbolsView.cancel();

      spyOn(DummyProvider, "getDocumentSymbols").and.callThrough();

      await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
      expect(choiceCount(symbolsView)).toBe(5);
      expect(DummyProvider.getDocumentSymbols).not.toHaveBeenCalled();
      await symbolsView.cancel();

      await editor.save();
      await dispatchAndWaitForChoices("symbol:toggle-file-symbols");

      expect(symbolsView.selectList.getLoadingState()).toBeNull();
      expect(choiceCount(symbolsView)).toBe(5);
      expect(DummyProvider.getDocumentSymbols).toHaveBeenCalled();
      editor.destroy();
      expect(mainModule.registry.cache.get(editor)).toBeUndefined();
    });

    it("displays a message when no tags match text in mini-editor", async () => {
      registerProvider(DummyProvider);
      await activationPromise;
      await dispatchAndWaitForChoices("symbol:toggle-file-symbols");

      symbolsView = getDocumentSymbolsView();
      symbolsView.selectList.getQueryEditor().setText("nothing will match this");

      await conditionPromise(() => symbolsView.getElement().querySelector(".empty-message"));
      expect(document.body.contains(symbolsView.getElement())).toBe(true);
      expect(choiceCount(symbolsView)).toBe(0);

      expect(
        symbolsView.getElement().querySelector(".empty-message").textContent.length,
      ).toBeGreaterThan(0);

      symbolsView.selectList.getQueryEditor().setText("");
      await conditionPromise(() => choiceCount(symbolsView) > 0);
      expect(choiceCount(symbolsView)).toBe(5);
      expect(symbolsView.getElement().querySelector(".empty-message")).toBeNull();
    });

    it("moves the cursor to the selected function", async () => {
      registerProvider(DummyProvider);
      await activationPromise;
      editor = lumine.workspace.getActiveTextEditor();
      expect(editor.getCursorBufferPosition()).toEqual([0, 0]);
      await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
      symbolsView = getDocumentSymbolsView();

      symbolsView.getElement().querySelectorAll("li")[1].click();
      // It'll move to the first non-whitespace character on the line.
      expect(editor.getCursorBufferPosition()).toEqual([3, 0]);
    });

    describe("when there are multiple document providers", () => {
      describe("and none have priority in the user's settings", () => {
        it("prefers the one with the highest score", async () => {
          registerProvider(DummyProvider, PreferredProvider);
          spyOn(PreferredProvider, "getDocumentSymbols").and.callThrough();
          spyOn(DummyProvider, "getDocumentSymbols").and.callThrough();
          await activationPromise;
          await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
          symbolsView = getDocumentSymbolsView();
          expect(choiceCount(symbolsView)).toBe(5);
          expect(DummyProvider.getDocumentSymbols).toHaveBeenCalled();
          expect(PreferredProvider.getDocumentSymbols).not.toHaveBeenCalled();
        });
      });

      describe("and one is listed in `preferCertainProviders`", () => {
        beforeEach(() => {
          lumine.config.set("symbol.preferCertainProviders", ["symbol-provider-preferred"]);
        });

        it("prefers the one with the highest score (providers listed beating those not listed)", async () => {
          registerProvider(DummyProvider, PreferredProvider);
          spyOn(PreferredProvider, "getDocumentSymbols").and.callThrough();
          spyOn(DummyProvider, "getDocumentSymbols").and.callThrough();
          await activationPromise;
          await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
          symbolsView = getDocumentSymbolsView();
          expect(choiceCount(symbolsView)).toBe(5);
          expect(DummyProvider.getDocumentSymbols).not.toHaveBeenCalled();
          expect(PreferredProvider.getDocumentSymbols).toHaveBeenCalled();
        });
      });

      describe("and more than one is listed in `preferCertainProviders`", () => {
        beforeEach(() => {
          // Last time we referred to this one by its package name; now we use
          // its human-friendly name. They should be interchangeable.
          lumine.config.set("symbol.preferCertainProviders", [
            "Preferred",
            "symbol-provider-dummy",
          ]);
        });

        it("prefers the one with the highest score (providers listed earlier beating those listed later)", async () => {
          registerProvider(DummyProvider, PreferredProvider);
          spyOn(PreferredProvider, "getDocumentSymbols").and.callThrough();
          spyOn(DummyProvider, "getDocumentSymbols").and.callThrough();
          await activationPromise;
          await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
          symbolsView = getDocumentSymbolsView();
          expect(choiceCount(symbolsView)).toBe(5);
          expect(DummyProvider.getDocumentSymbols).not.toHaveBeenCalled();
          expect(PreferredProvider.getDocumentSymbols).toHaveBeenCalled();
        });
      });

      describe("and one has a scope-specific `preferCertainProviders` setting", () => {
        beforeEach(() => {
          // Last time we referred to this one by its package name; now we use
          // its human-friendly name. They should be interchangeable.
          lumine.config.set(
            "symbol.preferCertainProviders",
            ["Preferred", "symbol-provider-dummy"],
            { scopeSelector: ".source.js" },
          );

          lumine.config.set("symbol.preferCertainProviders", ["symbol-provider-dummy"]);
        });

        it("prefers the one with the highest score (providers listed earlier beating those listed later)", async () => {
          registerProvider(DummyProvider, PreferredProvider);
          spyOn(PreferredProvider, "getDocumentSymbols").and.callThrough();
          spyOn(DummyProvider, "getDocumentSymbols").and.callThrough();
          await activationPromise;
          await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
          symbolsView = getDocumentSymbolsView();
          expect(choiceCount(symbolsView)).toBe(5);
          expect(DummyProvider.getDocumentSymbols).not.toHaveBeenCalled();
          expect(PreferredProvider.getDocumentSymbols).toHaveBeenCalled();
        });
      });
    });

    describe("when no symbols are found", () => {
      it("shows the list view with an error message", async () => {
        registerProvider(EmptyProvider);
        await activationPromise;
        lumine.commands.dispatch(getEditorView(), "symbol:toggle-file-symbols");
        await conditionPromise(
          () =>
            !getDocumentSymbolsView()?.selectList.isLoading() &&
            getDocumentSymbolsView()?.getElement().querySelector(".empty-message"),
        );
        symbolsView = getDocumentSymbolsView();

        expect(document.body.contains(symbolsView.getElement()));
        expect(choiceCount(symbolsView)).toBe(0);
        const emptyMessage = symbolsView.getElement().querySelector(".empty-message");
        expect(emptyMessage).toBeVisible();
        expect(emptyMessage.textContent.length).toBeGreaterThan(0);
        expect(symbolsView.selectList.getLoadingState()).toBeNull();
      });
    });

    describe("when symbols can't be generated for a file", () => {
      it("does not show the list view", async () => {
        registerProvider(UselessProvider);
        await activationPromise;
        expect(mainModule.registry.broker.providers.document.length).toBe(1);
        lumine.commands.dispatch(getEditorView(), "symbol:toggle-file-symbols");

        await wait(1000);
        symbolsView = getDocumentSymbolsView();

        // List view should not be visible, nor should it have any options.
        expect(symbolsView.getElement().querySelectorAll("li").length).toBe(0);
        expect(symbolsView.getElement()).not.toBeVisible();
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
        symbolsView = getDocumentSymbolsView();

        expect(symbolsView.selectList.getLoadingState()).toBeNull();
        expect(document.body.contains(symbolsView.getElement())).toBe(true);
        expect(symbolsView.getElement().querySelectorAll("li").length).toBe(5);

        expect(
          symbolsView
            .getElement()
            .querySelector("li:first-child .primary-line")
            .classList.contains("icon-package"),
        ).toBe(true);
        expect(
          symbolsView
            .getElement()
            .querySelector("li:first-child .secondary-line")
            .classList.contains("no-icon"),
        ).toBe(true);

        expect(
          symbolsView
            .getElement()
            .querySelector("li:nth-child(2) .primary-line")
            .classList.contains("icon-key"),
        ).toBe(true);
        expect(
          symbolsView
            .getElement()
            .querySelector("li:nth-child(3) .primary-line")
            .classList.contains("icon-gear"),
        ).toBe(true);
        expect(
          symbolsView
            .getElement()
            .querySelector("li:nth-child(4) .primary-line")
            .classList.contains("icon-tag"),
        ).toBe(true);

        // Simulate lack of icon on a random element.
        expect(
          symbolsView
            .getElement()
            .querySelector("li:nth-child(5) .primary-line")
            .classList.contains("no-icon"),
        ).toBe(true);
      });

      it("routes a provider's explicit icon through the shared name registry", async () => {
        registerProvider(DummyProvider);
        await activationPromise;
        await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
        symbolsView = getDocumentSymbolsView();
        expect(symbolsView.getElement().querySelector("li:first-child .icon-package")).toExist();

        iconRegistration = lumine.icons.addProvider(
          {
            id: "symbol-spec",
            handles: ["name"],
            usesContext: true,
            iconFor(target) {
              return target.context === "symbol" && target.name === "package"
                ? Icon.classes(["icon-flame"])
                : null;
            },
          },
          { priority: 100 },
        );
        expect(symbolsView.getElement().querySelector("li:first-child .icon-flame")).toExist();
      });
    });
  });

  describe("when going to definition", () => {
    beforeEach(async () => {
      await lumine.workspace.open(directory.resolve("sample.js"));
    });

    it("opens the definitions already fetched for hyperclick without another provider request", async () => {
      registerProvider(TaggedProvider);
      editor = lumine.workspace.getActiveTextEditor();
      spyOn(mainModule.registry, "findDefinitions").and.callThrough();
      const range = new (require("lumine").Range)([0, 1], [0, 3]);
      const suggestion = await mainModule
        .provideHyperclick()
        .getSuggestionForWord(editor, "call", range);
      expect(suggestion.range).toBe(range);
      await suggestion.callback();
      expect(mainModule.registry.findDefinitions).toHaveBeenCalledTimes(1);
      expect(getEditor().getPath()).toBe(directory.resolve("tagged.js"));
      expect(getEditor().getCursorBufferPosition()).toEqual([2, 0]);
    });

    describe("when no definition is found", () => {
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

    describe("when there is a single matching definition", () => {
      beforeEach(async () => {
        registerProvider(TaggedProvider);
        await lumine.workspace.open(directory.resolve("tagged.js"));
        editor = lumine.workspace.getActiveTextEditor();
      });

      it("moves the cursor to the definition", async () => {
        editor.setCursorBufferPosition([6, 24]);
        spyOn(SymbolListView.prototype, "moveToPosition").and.callThrough();

        lumine.commands.dispatch(getEditorView(), "symbol:go-to-definition");

        await conditionPromise(() => {
          return SymbolListView.prototype.moveToPosition.calls.count() === 1;
        });
        expect(editor.getCursorBufferPosition()).toEqual([2, 0]);
      });
    });

    describe("when there is more than one matching definition", () => {
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
        lumine.commands.dispatch(getEditorView(), "symbol:go-to-definition");
        symbolsView = getDocumentSymbolsView();

        await conditionPromise(() => {
          return symbolsView.getElement().querySelectorAll("li").length > 0;
        });

        expect(choiceCount(symbolsView)).toBe(2);
        expect(symbolsView.getElement()).toBeVisible();
        spyOn(SymbolListView.prototype, "moveToPosition").and.callThrough();
        symbolsView.selectList.confirmSelection();

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

  describe("when returning from definition", () => {
    describe("in the same file", () => {
      beforeEach(async () => {
        registerProvider(TaggedProvider);
        await lumine.workspace.open(directory.resolve("tagged.js"));
        await activationPromise;
        editor = lumine.workspace.getActiveTextEditor();
      });

      it("doesn't do anything when no go-tos have been triggered", async () => {
        editor.setCursorBufferPosition([6, 0]);
        lumine.commands.dispatch(getEditorView(), "symbol:return-from-definition");

        expect(editor.getCursorBufferPosition()).toEqual([6, 0]);
      });

      it("returns to the previous row and column", async () => {
        editor.setCursorBufferPosition([6, 24]);
        editor = lumine.workspace.getActiveTextEditor();
        spyOn(SymbolListView.prototype, "moveToPosition").and.callThrough();
        lumine.commands.dispatch(getEditorView(), "symbol:go-to-definition");

        await conditionPromise(() => {
          return SymbolListView.prototype.moveToPosition.calls.count() === 1;
        });

        expect(getEditor()).toBe(editor);

        expect(getEditor().getCursorBufferPosition()).toEqual([2, 0]);
        lumine.commands.dispatch(getEditorView(), "symbol:return-from-definition");

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
        lumine.commands.dispatch(getEditorView(), "symbol:return-from-definition");

        expect(editor.getCursorBufferPosition()).toEqual([6, 0]);
      });

      it("returns to the previous row and column", async () => {
        editor.setCursorBufferPosition([6, 24]);
        editor = lumine.workspace.getActiveTextEditor();
        spyOn(SymbolListView.prototype, "moveToPosition").and.callThrough();
        lumine.commands.dispatch(getEditorView(), "symbol:go-to-definition");

        await conditionPromise(() => {
          return SymbolListView.prototype.moveToPosition.calls.count() === 1;
        });

        expect(getEditor()).not.toBe(editor);

        expect(getEditor().getCursorBufferPosition()).toEqual([2, 0]);
        const reopen = spyOn(lumine.workspace, "open").and.callThrough();
        lumine.commands.dispatch(getEditorView(), "symbol:return-from-definition");

        await conditionPromise(() => SymbolListView.prototype.moveToPosition.calls.count() === 2);

        expect(reopen.calls.mostRecent().args[0]).toBe(editor);
        expect(reopen.calls.mostRecent().args[1]).toEqual({ searchAllPanes: true });
        expect(getEditor()).toBe(editor);
        expect(getEditor().getCursorBufferPosition()).toEqual([6, 24]);
      });

      it("returns to a different file when the file was already open", async () => {
        editor.setCursorBufferPosition([6, 24]);
        editor = lumine.workspace.getActiveTextEditor();
        spyOn(SymbolListView.prototype, "moveToPosition").and.callThrough();
        lumine.commands.dispatch(getEditorView(), "symbol:go-to-definition");

        await conditionPromise(() => {
          return SymbolListView.prototype.moveToPosition.calls.count() === 1;
        });

        expect(getEditor()).not.toBe(editor);
        let editorPath = editor.getPath();
        let editorId = editor.id;
        lumine.workspace.getActivePane().destroyItem(editor);

        expect(getEditor().getCursorBufferPosition()).toEqual([2, 0]);
        lumine.commands.dispatch(getEditorView(), "symbol:return-from-definition");

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

    it("opens workspace search when no editor is active", async () => {
      editor.destroy();
      registerProvider(DummyProvider);
      lumine.commands.dispatch(getWorkspaceView(), "symbol:toggle-project-symbols");
      await conditionPromise(async () => {
        await getOrScheduleUpdatePromise();
        return getDocumentSymbolsView() && choiceCount(getDocumentSymbolsView()) > 0;
      });
      symbolsView = getDocumentSymbolsView();
      expect(choiceCount(symbolsView)).toBe(5);
    });

    it("debounces workspace queries while a user continues typing", async () => {
      const searches = jasmine.createSpy("searches").and.returnValue([]);
      registerProvider({
        name: "Workspace",
        packageName: "workspace-fixture",
        searchWorkspaceSymbols: searches,
      });
      lumine.commands.dispatch(getWorkspaceView(), "symbol:toggle-project-symbols");
      await conditionPromise(() => searches.calls.count() === 1);
      symbolsView = getDocumentSymbolsView();
      const queryEditor = symbolsView.selectList.getQueryEditor();
      queryEditor.setText("a");
      await wait(50);
      queryEditor.setText("ab");
      await wait(100);
      expect(searches.calls.count()).toBe(1);
      await conditionPromise(() => searches.calls.count() === 2);
      expect(searches.calls.mostRecent().args[0]).toBe("ab");
      expect(searches.calls.allArgs().map(([query]) => query)).not.toContain("a");
    });

    it("displays all symbols", async () => {
      registerProvider(DummyProvider);
      await activationPromise;
      await dispatchAndWaitForChoices("symbol:toggle-project-symbols");
      symbolsView = getDocumentSymbolsView();

      expect(symbolsView.selectList.getLoadingState()).toBeNull();
      expect(document.body.contains(symbolsView.getElement())).toBe(true);
      expect(symbolsView.getElement().querySelectorAll("li").length).toBe(5);

      let root = lumine.project.getPaths()[1];
      let resolved = directory.resolve("other-file.js");
      let relative = `${path.basename(root)}${resolved.replace(root, "")}`;

      expect(symbolsView.getElement().querySelector("li:first-child .primary-line")).toHaveText(
        "Symbol on Row 1",
      );
      expect(symbolsView.getElement().querySelector("li:first-child .secondary-line")).toHaveText(
        `${relative}:1`,
      );
      expect(symbolsView.getElement().querySelector("li:last-child .primary-line")).toHaveText(
        "Symbol on Row 13",
      );
      expect(symbolsView.getElement().querySelector("li:last-child .secondary-line")).toHaveText(
        `${relative}:13`,
      );
    });

    it("prefills the query field if `prefillSelectedText` is `true`", async () => {
      lumine.config.set("symbol.prefillSelectedText", true);
      registerProvider(DummyProvider);
      await activationPromise;
      spyOn(editor, "getSelectedText").and.returnValue("Symbol on Row 13");
      await dispatchAndWaitForChoices("symbol:toggle-project-symbols");
      symbolsView = getDocumentSymbolsView();

      expect(symbolsView.selectList.getLoadingState()).toBeNull();
      expect(document.body.contains(symbolsView.getElement())).toBe(true);
      expect(symbolsView.getElement().querySelectorAll("li").length).toBe(1);

      let root = lumine.project.getPaths()[1];
      let resolved = directory.resolve("other-file.js");
      let relative = `${path.basename(root)}${resolved.replace(root, "")}`;

      expect(symbolsView.getElement().querySelector("li:first-child .primary-line")).toHaveText(
        "Symbol on Row 13",
      );
      expect(symbolsView.getElement().querySelector("li:first-child .secondary-line")).toHaveText(
        `${relative}:13`,
      );
    });

    it("includes results from every workspace provider", async () => {
      registerProvider(DummyProvider);
      registerProvider(SecondDummyProvider);

      await dispatchAndWaitForChoices("symbol:toggle-project-symbols");
      symbolsView = getDocumentSymbolsView();

      expect(symbolsView.selectList.getLoadingState()).toBeNull();
      expect(document.body.contains(symbolsView.getElement())).toBe(true);
      expect(symbolsView.getElement().querySelectorAll("li").length).toBe(10);

      let root = lumine.project.getPaths()[1];
      let resolved = directory.resolve("other-file.js");
      let relative = `${path.basename(root)}${resolved.replace(root, "")}`;

      expect(symbolsView.getElement().querySelector("li:first-child .primary-line")).toHaveText(
        "Symbol on Row 1",
      );
      expect(symbolsView.getElement().querySelector("li:first-child .secondary-line")).toHaveText(
        `${relative}:1`,
      );
      expect(symbolsView.getElement().querySelector("li:last-child .primary-line")).toHaveText(
        "(Second) Symbol on Row 13",
      );
      expect(symbolsView.getElement().querySelector("li:last-child .secondary-line")).toHaveText(
        `${relative}:13`,
      );
    });

    it("does not prefill the query field if `prefillSelectedText` is `false`", async () => {
      lumine.config.set("symbol.prefillSelectedText", false);
      registerProvider(DummyProvider);
      await activationPromise;
      spyOn(editor, "getSelectedText").and.returnValue("Symbol on Row 13");
      await dispatchAndWaitForChoices("symbol:toggle-project-symbols");
      symbolsView = getDocumentSymbolsView();

      expect(symbolsView.selectList.getLoadingState()).toBeNull();
      expect(document.body.contains(symbolsView.getElement())).toBe(true);
      expect(symbolsView.getElement().querySelectorAll("li").length).toBe(5);

      let root = lumine.project.getPaths()[1];
      let resolved = directory.resolve("other-file.js");
      let relative = `${path.basename(root)}${resolved.replace(root, "")}`;

      expect(symbolsView.getElement().querySelector("li:first-child .primary-line")).toHaveText(
        "Symbol on Row 1",
      );
      expect(symbolsView.getElement().querySelector("li:first-child .secondary-line")).toHaveText(
        `${relative}:1`,
      );
      expect(symbolsView.getElement().querySelector("li:last-child .primary-line")).toHaveText(
        "Symbol on Row 13",
      );
      expect(symbolsView.getElement().querySelector("li:last-child .secondary-line")).toHaveText(
        `${relative}:13`,
      );
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
        symbolsView = getDocumentSymbolsView();

        expect(choiceCount(symbolsView)).toBe(1);

        expect(symbolsView.getElement().querySelector("li:first-child .primary-line")).toHaveText(
          "callMeMaybe",
        );
        expect(symbolsView.getElement().querySelector("li:first-child .secondary-line")).toHaveText(
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
          symbolsView = getDocumentSymbolsView();

          spyOn(lumine.workspace, "open").and.callThrough();

          symbolsView.getElement().querySelector("li:first-child").click();

          await conditionPromise(() => symbolsView.selectList.getStatus());

          expect(lumine.workspace.open).not.toHaveBeenCalled();
          const status = symbolsView.selectList.getStatus();
          expect(status.message.length).toBeGreaterThan(0);
          expect(status.type).toBe("error");
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

        symbolsView = getDocumentSymbolsView();
        symbolsView.selectList.getQueryEditor().setText("quicksort");
        await getOrScheduleUpdatePromise();
        let resultView = symbolsView.getElement().querySelector(".selected");
        let matches = resultView.querySelectorAll(".character-match");
        expect(matches.length).toBe(1);
        expect(matches[0].textContent).toBe("quicksort");
      });

      it("highlights a partial match", async () => {
        await activationPromise;
        await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
        symbolsView = getDocumentSymbolsView();

        symbolsView.selectList.getQueryEditor().setText("quick");
        await getOrScheduleUpdatePromise();

        let resultView = symbolsView.getElement().querySelector(".selected");
        let matches = resultView.querySelectorAll(".character-match");
        expect(matches.length).toBe(1);
        expect(matches[0].textContent).toBe("quick");
      });

      it("highlights multiple matches in the symbol name", async () => {
        await activationPromise;
        await dispatchAndWaitForChoices("symbol:toggle-file-symbols");
        symbolsView = getDocumentSymbolsView();

        symbolsView.selectList.getQueryEditor().setText("quicort");
        await getOrScheduleUpdatePromise();

        let resultView = symbolsView.getElement().querySelector(".selected");
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
        symbolsView = getDocumentSymbolsView();

        symbolsView.selectList.selectNext();

        expect(editor.getCursorBufferPosition()).toEqual([3, 0]);
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
        symbolsView = getDocumentSymbolsView();

        symbolsView.selectList.selectNext();
        expect(editor.getCursorBufferPosition()).toEqual([3, 0]);

        symbolsView.selectListHost.cancel();
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
        symbolsView = getDocumentSymbolsView();
        symbolsView.selectList.selectNext();
        expect(editor.getCursorBufferPosition()).toEqual([0, 0]);
      });
    });
  });
});

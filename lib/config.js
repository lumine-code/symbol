const { CompositeDisposable, Emitter } = require("atom");

const Config = {
  activate() {
    if (this.activated) return;
    this.emitter ??= new Emitter();
    this.subscriptions = new CompositeDisposable();

    this.subscriptions.add(
      atom.config.onDidChange("symbol", (config) => {
        this.emitter.emit("did-change-config", config);
      }),
    );
    this.activated = true;
  },

  deactivate() {
    this.activated = false;
    this.subscriptions?.dispose();
  },

  getForEditor(editor, key) {
    let grammar = editor.getGrammar();
    return atom.config.get(`symbol.${key}`, { scope: [grammar?.scopeName] });
  },

  get(key) {
    return atom.config.get(`symbol.${key}`);
  },

  set(key, value) {
    return atom.config.set(`symbol.${key}`, value);
  },

  observe(key, callback) {
    return atom.config.observe(`symbol.${key}`, callback);
  },

  onDidChange(callback) {
    // The registry subscribes at construction, which may precede `activate`
    // in tests; the emitter is shared either way.
    this.emitter ??= new Emitter();
    return this.emitter.on("did-change-config", callback);
  },
};

module.exports = Config;

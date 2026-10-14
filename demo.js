// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: ["language-javascript", "symbol-tree-sitter"],
  viewport: { width: 1100, height: 730 },
  async before() {},
  async prepare(context) {
    const { lumine, state, fixture, open } = context;
    state.editor = await open("editing/signal.js");
    await lumine.project.setPaths([fixture("editing")]);
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Browse the functions and symbols of a JavaScript file.",
      timeout: 60000,
      async run(context) {
        const { lumine, state } = context;
        {
          lumine.commands.dispatch(
            lumine.views.getView(state.editor),
            "symbol:toggle-file-symbols",
          );
        }
      },
      ready() {
        return Boolean(document.querySelector(".symbol")?.innerText.includes("SignalBuffer"));
      },
    },
  ],
  async cleanup() {},
};

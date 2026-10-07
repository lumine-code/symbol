const fs = require("fs");
const path = require("path");

function rgb(color) {
  const context = document.createElement("canvas").getContext("2d");
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
}

function luminance(channels) {
  const linear = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

describe("Symbol category badge CSS roles", () => {
  let stylesheet, container;
  beforeEach(() => {
    stylesheet = lumine.styles.addStyleSheet(
      fs.readFileSync(path.join(__dirname, "../styles/main.css"), "utf8"),
      { priority: 1000 },
    );
    container = document.createElement("div");
    container.style.setProperty("--ui-site-color-2", "hsl(0, 70%, 50%)");
    container.style.setProperty("--background-color-info", "rgb(255, 255, 255)");
    container.style.setProperty("--text-color-on-info", "rgb(255, 255, 255)");
    for (const variant of "0123456789abcdef") {
      const badge = document.createElement("span");
      badge.className = `badge badge-info badge-symbol-tag symbol-badge-variant-${variant}`;
      badge.textContent = "Category";
      container.appendChild(badge);
    }
    jasmine.attachToDOM(container);
  });
  afterEach(() => stylesheet.dispose());

  it("keeps sixteen distinct category hues with readable text on every final background", () => {
    const backgrounds = new Set();
    for (const badge of container.children) {
      const style = getComputedStyle(badge);
      const background = rgb(style.backgroundColor);
      const foreground = rgb(style.color);
      backgrounds.add(background.join(","));
      const bright = Math.max(luminance(background), luminance(foreground));
      const dark = Math.min(luminance(background), luminance(foreground));
      expect((bright + 0.05) / (dark + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
    expect(backgrounds.size).toBe(16);
  });
});

import { expect, test } from "bun:test";
import { InputRenderable, ScrollBoxRenderable, SelectRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i}`).join("\n");

test("OpenTUI preserves a manual scroll position during streaming updates", async () => {
  const { renderer, renderOnce } = await createTestRenderer({ width: 60, height: 12 });
  try {
    const scroll = new ScrollBoxRenderable(renderer, { width: 60, height: 10, stickyScroll: true, stickyStart: "bottom" });
    const text = new TextRenderable(renderer, { content: lines(80) });
    scroll.add(text);
    renderer.root.add(scroll);
    await renderOnce();
    scroll.scrollTo(15);
    await renderOnce();
    const before = scroll.scrollTop;
    expect(before).toBe(15);
    for (let count = 81; count < 86; count++) {
      text.content = lines(count);
      await renderOnce();
      expect(scroll.scrollTop).toBe(before);
    }
  } finally { renderer.destroy(); }
});

test("OpenTUI keeps a selected option stable across updates", async () => {
  const { renderer, renderOnce } = await createTestRenderer({ width: 60, height: 12 });
  try {
    const select = new SelectRenderable(renderer, { width: 60, height: 10, options: [
      { name: "alpha", description: "Ready", value: "alpha" },
      { name: "beta", description: "Running", value: "beta" },
    ], selectedIndex: 1 });
    renderer.root.add(select);
    await renderOnce();
    for (let i = 0; i < 5; i++) {
      select.options = select.options.map(option => ({ ...option, description: `update ${i}` }));
      await renderOnce();
      expect(select.getSelectedOption()?.value).toBe("beta");
    }
  } finally { renderer.destroy(); }
});

test("OpenTUI accepts typing while streamed content updates", async () => {
  const { renderer, renderOnce, mockInput } = await createTestRenderer({ width: 60, height: 12 });
  try {
    const text = new TextRenderable(renderer, { content: "stream" });
    const input = new InputRenderable(renderer, { width: 60 });
    renderer.root.add(text);
    renderer.root.add(input);
    input.focus();
    for (const [index, character] of [..."question"].entries()) {
      text.content = `stream update ${index}`;
      await mockInput.typeText(character);
      await renderOnce();
    }
    expect(input.value).toBe("question");
    expect(input.focused).toBe(true);
  } finally { renderer.destroy(); }
});

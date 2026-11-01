// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, mountPluginContentScripts } from "@get-bb/plugin-sdk/testing/app";
import app from "./app";
import { mountNativeTracker, nativeTrackerCss } from "./native-tracker";

afterEach(() => { document.body.replaceChildren(); document.querySelectorAll("style[data-focused-diff-native]").forEach(node => node.remove()); });

function composer(replaced: boolean, otherContext = "") {
  const element = document.createElement("div");
  element.setAttribute("data-app-composer", "");
  element.innerHTML = `${replaced ? '<div data-focused-diff-replacement></div>' : ''}<section aria-label="Thread context before sending"><div><button id="thread-prompt-banner-git-toggle">Uncommitted</button>${otherContext}</div><div id="thread-prompt-banner-git-body">Files</div></section>`;
  document.body.append(element);
  return element;
}
it("hides only the native Git controls in the composer with an active replacement", () => {
  const replaced = composer(true), untouched = composer(false);
  const dispose = mountNativeTracker();
  const hiddenSelectors = nativeTrackerCss.split("{")[0].split(",").map(value => value.trim());
  for (const selector of hiddenSelectors) {
    expect(replaced.querySelector(selector)).toBeTruthy();
    expect(untouched.querySelector(selector)).toBeNull();
  }
  expect(getComputedStyle(replaced.querySelector("section")!).display).toBe("none");
  expect(getComputedStyle(untouched.querySelector("section")!).display).not.toBe("none");
  dispose();
  expect(getComputedStyle(replaced.querySelector("section")!).display).not.toBe("none");
});
it("preserves parent-thread and pull-request context beside native Git controls", () => {
  const element = composer(true, '<button id="thread-prompt-banner-parent-thread-toggle">Parent</button><a href="/pr">PR #1</a>');
  const dispose = mountNativeTracker();
  expect(getComputedStyle(element.querySelector("section")!).display).not.toBe("none");
  expect(getComputedStyle(element.querySelector("#thread-prompt-banner-git-toggle")!).display).toBe("none");
  expect(getComputedStyle(element.querySelector("a")!).display).not.toBe("none");
  dispose();
});
function wrappedComposer(extra = "") {
  const element = document.createElement("div");
  element.setAttribute("data-app-composer", "");
  element.innerHTML = `<div data-focused-diff-replacement></div><section aria-label="Thread context before sending" style="min-height:35px"><div class="flex"><span class="contents" role="group"><button id="thread-prompt-banner-git-toggle">Uncommitted</button></span>${extra}</div><div data-slot><section id="thread-prompt-banner-git-body"><button type="button">Collapse changed files</button></section></div></section>`;
  document.body.append(element);
  return element;
}
it("hides the wrapped native Git shell when the card has no other context", () => {
  const element = wrappedComposer();
  const dispose = mountNativeTracker();
  const shell = element.querySelector("section[aria-label='Thread context before sending']")!;
  expect(getComputedStyle(shell).display).toBe("none");
  expect(getComputedStyle(element.querySelector("#thread-prompt-banner-git-toggle")!).display).toBe("none");
  expect(getComputedStyle(element.querySelector("#thread-prompt-banner-git-body")!).display).toBe("none");
  dispose();
  expect(getComputedStyle(shell).display).not.toBe("none");
});
it("keeps a wrapped shell that still shows another summary control", () => {
  const element = wrappedComposer('<button id="thread-prompt-banner-parent-thread-toggle">Parent</button>');
  const dispose = mountNativeTracker();
  const shell = element.querySelector("section[aria-label='Thread context before sending']")!;
  expect(getComputedStyle(shell).display).not.toBe("none");
  expect(getComputedStyle(element.querySelector("#thread-prompt-banner-git-toggle")!).display).toBe("none");
  expect(getComputedStyle(element.querySelector("#thread-prompt-banner-parent-thread-toggle")!).display).not.toBe("none");
  dispose();
});
it("keeps a wrapped shell when another section sits beside the Git file list", () => {
  const element = wrappedComposer();
  const other = document.createElement("div");
  other.innerHTML = '<a href="/parent">Parent thread</a>';
  element.querySelector("[data-slot]")!.after(other);
  const dispose = mountNativeTracker();
  const shell = element.querySelector("section[aria-label='Thread context before sending']")!;
  expect(getComputedStyle(shell).display).not.toBe("none");
  expect(getComputedStyle(other.querySelector("a")!).display).not.toBe("none");
  expect(getComputedStyle(element.querySelector("#thread-prompt-banner-git-body")!).display).toBe("none");
  dispose();
});
function stylesheetSelectors() {
  const found: string[] = [];
  const visit = (rules: CSSRuleList) => {
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules.item(index);
      if (rule === null) continue;
      if ("selectorText" in rule && typeof rule.selectorText === "string") found.push(rule.selectorText);
      if ("cssRules" in rule && rule.cssRules instanceof CSSRuleList) visit(rule.cssRules);
    }
  };
  for (let index = 0; index < document.styleSheets.length; index += 1) visit(document.styleSheets[index].cssRules);
  return found;
}
it("hides a narrow shell whose only extra control is the compact merge base", () => {
  const element = document.createElement("div");
  element.setAttribute("data-app-composer", "");
  element.innerHTML = `<div data-focused-diff-replacement></div><section aria-label="Thread context before sending" style="min-height:35px"><div class="flex"><span class="contents"><button id="thread-prompt-banner-git-toggle">Uncommitted</button></span><div data-promptbox-hide-compact=""><button type="button">Merge base</button></div></div><div data-slot><section id="thread-prompt-banner-git-body"><button type="button">Collapse changed files</button></section></div></section>`;
  document.body.append(element);
  const dispose = mountNativeTracker();
  const shell = element.querySelector("section[aria-label='Thread context before sending']")!;
  const selectors = stylesheetSelectors().filter(selector => selector.includes("Thread context before sending"));
  const base = selectors.find(selector => !selector.includes("data-promptbox-hide-compact"));
  const narrow = selectors.filter(selector => selector.includes("data-promptbox-hide-compact"));
  expect(base).toBeTruthy();
  expect(shell.matches(base!)).toBe(false);
  expect(narrow).toHaveLength(2);
  for (const selector of narrow) expect(shell.matches(selector)).toBe(true);
  dispose();
});
it("keeps a wide shell that still shows the merge base", () => {
  const element = document.createElement("div");
  element.setAttribute("data-app-composer", "");
  element.setAttribute("data-promptbox-shell", "");
  element.style.width = "900px";
  element.innerHTML = `<div data-focused-diff-replacement></div><section aria-label="Thread context before sending"><div class="flex"><span class="contents"><button id="thread-prompt-banner-git-toggle">Uncommitted</button></span><div data-promptbox-hide-compact=""><button type="button">Merge base</button></div></div><div data-slot><section id="thread-prompt-banner-git-body">Files</section></div></section>`;
  document.body.append(element);
  const dispose = mountNativeTracker();
  const shell = element.querySelector("section[aria-label='Thread context before sending']")!;
  expect(getComputedStyle(shell).display).not.toBe("none");
  expect(getComputedStyle(element.querySelector("[data-promptbox-hide-compact] button")!).display).not.toBe("none");
  dispose();
});
it("removes the replacement stylesheet on plugin disposal", async () => {
  const loaded = await loadPluginApp(app), scripts = await mountPluginContentScripts(loaded, { pluginId: "focused-diff", generation: 1 });
  expect(document.querySelectorAll("style[data-focused-diff-native]")).toHaveLength(1);
  await scripts.lifecycle.dispose();
  expect(document.querySelectorAll("style[data-focused-diff-native]")).toHaveLength(0);
});

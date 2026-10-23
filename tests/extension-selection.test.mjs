import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transformWithOxc } from "vite";

const source = (await readFile(new URL("../src/extensions.jsx", import.meta.url), "utf8"))
  .replace(/^import React[^;]*;\s*/, "")
  .replace("export default function ExtensionManager", "function ExtensionManager");
const { code } = await transformWithOxc(source, "extensions.jsx", { jsx: { runtime: "classic" } });
const nodes = (node) => !node || typeof node !== "object" ? [] :
  [node, ...(node.props?.children ?? []).flat(Infinity).flatMap(nodes)];
const text = (node) => typeof node === "string" ? node : !node || typeof node !== "object" ? "" :
  (node.props?.children ?? []).flat(Infinity).map(text).join("");

function fixture() {
  const slots = [], reads = [], writes = [], eventErrors = [];
  let cursor = 0, dirty = true, tree, effects = [];
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { value: typeof initial === "function" ? initial() : initial };
    return [slots[index].value, (next) => {
      const value = typeof next === "function" ? next(slots[index].value) : next;
      if (!Object.is(slots[index].value, value)) {
        slots[index].value = value;
        dirty = true;
      }
    }];
  };
  const changed = (previous, deps) => !previous || deps.some((value, index) => !Object.is(value, previous.deps[index]));
  const useCallback = (callback, deps) => {
    const index = cursor++;
    if (changed(slots[index], deps)) slots[index] = { deps, value: callback };
    return slots[index].value;
  };
  const useEffect = (effect, deps) => {
    const index = cursor++;
    if (changed(slots[index], deps)) effects.push(() => {
      slots[index]?.cleanup?.();
      slots[index] = { deps, cleanup: effect() };
    });
  };
  const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
  const packages = ["A", "B"].map((name, index) => ({
    id: "library:" + name.toLowerCase(), libraryId: "library", contentHash: String(index + 1).repeat(64),
    manifest: { id: name.toLowerCase(), name: "Package " + name, description: "Synthetic fixture", version: "1.0.0", type: "skill" },
    status: "unreviewed", enabled: false, activeLock: false, reviewed: false,
    capability: "context.workflow", commit: "fixture", files: [{ path: "SKILL.md", content: name + " SOURCE" }],
  }));
  const api = (url, method = "GET", body) => {
    if (url === "/extensions" && method === "GET")
      return Promise.resolve({ libraries: [], packages, errors: [] });
    const pending = { url, method, body, ...Promise.withResolvers(), settled: false };
    const list = method === "GET" ? reads : writes;
    list.push(pending);
    return pending.promise;
  };
  const Component = new Function("React", "useState", "useEffect", "useCallback", code + "\nreturn ExtensionManager;")(
    React, useState, useEffect, useCallback,
  );
  const render = () => {
    for (let attempts = 0; dirty; attempts++) {
      assert.ok(attempts < 20, "component must settle without a synchronous render loop");
      dirty = false;
      cursor = 0;
      effects = [];
      tree = Component({ running: false, api });
      for (const effect of effects) effect();
    }
    return tree;
  };
  const flush = async () => {
    // Render committed state between microtasks so effect cleanup follows selection changes.
    for (let turn = 0; turn < 10; turn++) {
      render();
      await Promise.resolve();
    }
    render();
    assert.deepEqual(eventErrors, []);
  };
  const section = () => nodes(render()).find((node) => node.type === "section" && node.props.className?.includes("extension-review"));
  const button = (label, parent = render()) => nodes(parent).find((node) => node.type === "button" && text(node) === label);
  const invoke = (callback, ...args) => {
    const result = callback(...args);
    if (result?.then) result.catch((error) => eventErrors.push(error));
    render();
  };
  const choose = async (name) => {
    const card = nodes(render()).find((node) => node.type === "article" && nodes(node).some((child) => child.type === "strong" && text(child) === "Package " + name));
    assert.ok(card, "package card exists");
    invoke(button("查看文件与差异", card).props.onClick);
    await flush();
  };
  const close = async () => {
    const control = button("收起", section());
    assert.ok(control, "a pending or loaded review can be closed");
    invoke(control.props.onClick);
    await flush();
  };
  const readFor = (name) => reads.findLast((request) => !request.settled && request.url === "/extensions/" + encodeURIComponent("library:" + name.toLowerCase()));
  const reply = async (request, name, error) => {
    assert.ok(request, "detail request exists");
    request.settled = true;
    if (error) request.reject(new Error(error));
    else request.resolve({ extension: packages.find((item) => item.manifest.name === "Package " + name), previousFiles: [] });
    await flush();
  };
  const load = async (name) => {
    await choose(name);
    await reply(readFor(name), name);
    assert.ok(text(section()).includes(name + " SOURCE"));
  };
  const approve = async () => {
    const control = button("批准当前内容并锁定版本", section());
    assert.ok(control && !control.props.disabled, "the visible review is approvable");
    invoke(control.props.onClick);
    await flush();
    return writes.at(-1);
  };
  return {
    packages, reads, writes, flush, render, section, button, choose, close, readFor, reply, load, approve,
    setNote: async (value) => {
      const input = nodes(section()).find((node) => node.type === "input");
      assert.ok(input, "the loaded review has a note input");
      invoke(input.props.onChange, { target: { value } });
      await flush();
    },
    alerts: () => nodes(render()).filter((node) => node.props?.role === "alert").map(text).join(" "),
    finishAction: async (request) => {
      request.settled = true;
      request.resolve({ approved: true });
      await flush();
      for (const pending of reads.filter((read) => !read.settled)) {
        const item = packages.find((p) => pending.url === "/extensions/" + encodeURIComponent(p.id));
        assert.ok(item, "only a package detail is refreshed");
        await reply(pending, item.manifest.name.at(-1));
      }
    },
    cleanup: () => { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test("switching extension reviews hides the old files and approval while the new package loads", async (t) => {
  const s = fixture(); t.after(s.cleanup);
  await s.flush(); await s.load("A");
  await s.choose("B");
  assert.ok(!text(s.section()).includes("A SOURCE"), "A's files must not remain visible for selection B");
  const approve = s.button("批准当前内容并锁定版本", s.section());
  assert.ok(!approve || approve.props.disabled, "loading B must not allow approval with A's hash");
  assert.ok(s.button("收起", s.section()), "the pending review remains closable");
  await s.reply(s.readFor("B"), "B");
  assert.ok(text(s.section()).includes("B SOURCE"));
});

test("out-of-order extension detail responses preserve the currently selected package", async (t) => {
  const s = fixture(); t.after(s.cleanup);
  await s.flush(); await s.choose("A"); const old = s.readFor("A");
  await s.choose("B"); await s.reply(s.readFor("B"), "B");
  await s.reply(old, "A");
  assert.ok(text(s.section()).includes("B SOURCE"), "late A must not replace the displayed B review");
  assert.ok(!text(s.section()).includes("A SOURCE"));
});

test("viewing the selected extension again still reloads its files", async (t) => {
  const s = fixture(); t.after(s.cleanup);
  await s.flush(); await s.load("A");
  await s.choose("A");
  assert.ok(s.readFor("A"), "viewing the same package must still issue a fresh detail read");
  assert.ok(!text(s.section()).includes("A SOURCE"), "old files are hidden until that read finishes");
  await s.reply(s.readFor("A"), "A");
  assert.ok(text(s.section()).includes("A SOURCE"));
});

for (const outcome of ["success", "failure"])
  test(`closing an extension review ignores an old detail ${outcome}`, async (t) => {
    const s = fixture(); t.after(s.cleanup);
    await s.flush(); await s.load("A");
    await s.choose("B"); const pending = s.readFor("B");
    await s.close();
    await s.reply(pending, "B", outcome === "failure" ? "obsolete detail failure" : undefined);
    assert.equal(s.section(), undefined, "late detail must not reopen a closed review");
    assert.equal(s.alerts(), "", "an obsolete detail error must not be presented after close");
  });

for (const next of ["B", "closed"])
  test(`finishing an action on A keeps the review ${next === "B" ? "on B" : "closed"}`, async (t) => {
    const s = fixture(); t.after(s.cleanup);
    await s.flush(); await s.load("A");
    const action = await s.approve();
    assert.equal(action.url, "/extensions/library%3Aa/review");
    if (next === "B") await s.load("B");
    else await s.close();
    await s.finishAction(action);
    if (next === "B") {
      assert.ok(text(s.section()).includes("B SOURCE"), "catalog refresh must retain the current B review");
      assert.ok(!text(s.section()).includes("A SOURCE"));
    } else assert.equal(s.section(), undefined, "an action's refresh must not reopen its former selection");
  });

test("current detail errors remain visible and approval uses the displayed package hash and note", async (t) => {
  const s = fixture(); t.after(s.cleanup);
  await s.flush(); await s.choose("B");
  await s.reply(s.readFor("B"), "B", "current detail unavailable");
  assert.match(s.alerts(), /current detail unavailable/);
  await s.load("A");
  await s.setNote("checked synthetic source");
  const action = await s.approve();
  assert.equal(action.url, "/extensions/library%3Aa/review");
  assert.equal(action.method, "POST");
  assert.deepEqual(action.body, { contentHash: s.packages[0].contentHash, note: "checked synthetic source" });
});

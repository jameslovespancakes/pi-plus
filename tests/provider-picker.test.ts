import test from "node:test";
import assert from "node:assert/strict";
import { STATE_TEXT, providerToggleStates, providerStateText, colourState, openProviderPicker, type StateKey } from "../src/domains/models/provider-picker.ts";

/**
 * Colour resolution depends on terminal capability, which `ui/format.ts` reads
 * from the environment at import time. These helpers pin it either way so both
 * branches are covered regardless of where the suite runs.
 */
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM ?? "") || !!process.env.WT_SESSION;

/** Records which theme colour each call requested, for the fallback branch. */
function recordingTheme() {
  const calls: string[] = [];
  return {
    calls,
    fg: (colour: string, text: string) => { calls.push(colour); return text; },
    bold: (text: string) => text,
    bg: (_c: string, text: string) => text,
  };
}

/** `\u001b[38;2;R;G;Bm` -> [R,G,B] */
function rgbOf(text: string): [number, number, number] | undefined {
  const match = /\u001b\[38;2;(\d+);(\d+);(\d+)m/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

test("each state has a distinct label", () => {
  const labels = Object.values(STATE_TEXT);
  assert.equal(new Set(labels).size, labels.length);
  assert.deepEqual(STATE_TEXT, {
    auto: "Allowed",
    approved: "Approved",
    blocked: "Needs Approval",
    denied: "Denied",
    zdr: "On (ZDR)",
  });
});

test("colourState returns the state text, and honours an override", () => {
  const theme = recordingTheme();
  assert.match(colourState(theme, "blocked"), /Needs Approval/);
  assert.match(colourState(theme, "auto", "●"), /●/, "reused for the status dot");
});

test("allowed reads green and needs-approval reads amber", () => {
  const theme = recordingTheme();
  const allowed = colourState(theme, "auto");
  const blocked = colourState(theme, "blocked");

  if (TRUECOLOR) {
    // Same ramp as the usage bars: green is dominated by its green channel,
    // amber carries a strong red channel alongside it.
    const [ar, ag] = rgbOf(allowed)!;
    const [br, bg] = rgbOf(blocked)!;
    assert.ok(ag > ar, `allowed should be green-dominant, got rgb(${ar},${ag},…)`);
    assert.ok(br > ar, `amber should carry more red than green does, got ${br} vs ${ar}`);
    assert.ok(bg > 0, "amber retains a green component");
  } else {
    assert.deepEqual(theme.calls, ["success", "warning"]);
  }
});

test("denied is distinct from needs-approval", () => {
  const theme = recordingTheme();
  const blocked = colourState(theme, "blocked");
  const denied = colourState(theme, "denied");
  assert.notEqual(blocked, denied);

  if (TRUECOLOR) {
    const [, bg] = rgbOf(blocked)!;
    const [, dg] = rgbOf(denied)!;
    assert.ok(dg < bg, "denied sits lower on the ramp than needs-approval");
  }
});

test("approved shares the allowed colour, distinguished by label", () => {
  const theme = recordingTheme();
  // Both mean usable; a third hue would imply a third risk level.
  assert.equal(colourState(theme, "approved", "x"), colourState(theme, "auto", "x"));
  assert.notEqual(STATE_TEXT.approved, STATE_TEXT.auto);
});

test("only OpenRouter offers the three-state privacy toggle", () => {
  assert.deepEqual(providerToggleStates("anthropic"), ["auto", "blocked"]);
  assert.deepEqual(providerToggleStates("openrouter").map((state) => providerStateText("openrouter", state)), ["Off", "On", "On (ZDR)"]);
  assert.equal(providerStateText("openrouter", "auto"), "On");
  assert.equal(providerStateText("openrouter", "denied"), "Denied");
});

test("OpenRouter cycles in place and policy-denied rows remain locked", async () => {
  let state: StateKey = "blocked";
  let toggles = 0;
  for (const denied of [false, true]) {
    await openProviderPicker({
      ui: {
        notify: () => {},
        custom: async (factory: any) => {
          const component = factory({}, recordingTheme(), {}, () => {});
          if (denied) {
            component.handleInput("\r");
            assert.match(component.render(100).join("\n"), /Denied/);
            assert.equal(toggles, 3);
            return;
          }
          for (const label of ["Off", "On", "On (ZDR)", "Off"]) {
            assert.ok(component.render(100).join("\n").includes(label));
            if (toggles < 3) component.handleInput("\r");
          }
        },
      },
    }, {
      rows: async () => [{ id: "openrouter", provider: "openrouter", display: "OpenRouter", state: denied ? "denied" : state }],
      toggle: () => { toggles++; state = state === "blocked" ? "approved" : state === "approved" ? "zdr" : "blocked"; return state; },
    });
  }
});

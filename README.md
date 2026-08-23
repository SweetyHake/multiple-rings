# Multiple Rings

**Different dynamic token rings for different tokens — in Foundry VTT v14.**

Foundry allows only one dynamic ring style per world. This module removes that limit: every token can wear its own ring, chosen from all installed ring packs (core steel & bronze plus any added by other modules).

Requires [lib-wrapper](https://foundryvtt.com/packages/lib-wrapper).

---

## What you get

- A **ring selector** in the regular token settings (and prototype token settings).
- **Active Effects support** — give a boss a different ring in its second phase.
- **DAE-friendly** — the effect value is a dropdown of available rings, not a text field.
- **Smart memory use** — ring packs load only when actually used, unused packs are unloaded automatically, and render quality adapts to your device.
- **Safe by design** — if anything goes wrong (GPU limits, Foundry updates, missing modules), tokens simply fall back to the normal world-wide ring. Nothing crashes.

---

## Usage

### Token or actor

Open **Configure Token** (or **Configure Prototype Token** on an actor sheet) → *Appearance* tab → ring section → pick a pack from **Token Ring** → save.

Leave it on **Default** to follow the usual priority:

```
Active Effect → token → actor prototype → world setting
```

### Through an Active Effect

Add a change to any effect:

| | |
|---|---|
| Key | `flags.multiple-rings.ringAppearance` |
| Mode | Override |
| Value | pick a ring from the dropdown |

In DAE's editor the key is searchable by name and the value is a select. Empty value = default ring.

---

## Settings

| Setting | Scope | What it does |
|---|---|---|
| Multiple dynamic ring support | World | Master switch. Off = vanilla behavior. |
| Resolution scale | Client | Auto keeps the best quality that fits your GPU. Force 100/75/50% if you prefer — lower values fit far more packs but look slightly softer up close. |

Each player picks their own resolution scale — rendering happens locally, so there is nothing to synchronize.

---

## Good to know

- **No FPS cost.** Rings render exactly like vanilla; everything happens when tokens are drawn, not every frame.
- **Memory scales with usage.** Only packs actually worn by someone are loaded. Roughly: two core packs ≈ 100 MB of texture memory; the auto scale shrinks this as needed.
- **Unused packs are evicted** after five minutes of nobody wearing them, so experimenting never bloats memory.
- **World setting stays untouched.** Tokens without a choice keep using it, and the module cleans up after itself if you ever turn it off.

---

## Troubleshooting

| Problem | Answer |
|---|---|
| Selector doesn't appear | Is lib-wrapper active? Is the module enabled? Check console lines starting with `multiple-rings \|`. |
| Token shows the default ring instead of my pick | That pack didn't fit into your GPU atlas — lower *Resolution scale* or wear fewer packs at once. |
| Rings look soft when zoomed way in | Auto scale lowered quality to fit your hardware. Set 100% manually if your GPU can afford it. |

---

## For macros and developers

```js
// Read or set a token's ring
token.document.getFlag("multiple-rings", "ringAppearance");     // e.g. "coreBronze" or ""
await token.document.update({ "flags.multiple-rings.ringAppearance": "coreBronze" });
```

Any Active Effect change with the same key works the same way.

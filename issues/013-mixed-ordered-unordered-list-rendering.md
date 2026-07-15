# Bug: a mixed ordered/unordered list renders every item as the first item's type

**Type:** bug (markdown rendering)
**Status:** open
**Area:** `server/markdown.js` (`renderList`)

## Problem

When a contiguous list block mixes ordered (`1.`) and unordered (`-` / `*` / `+`)
markers, the whole block renders as whichever type the **first** item is. An ordered
item that follows bullet items silently loses its number and renders as a plain disc
bullet.

Example source:

```
- first bullet
- second bullet
1. should be numbered
```

Renders as (all three under one `<ul>`, the `1.` reduced to a bullet with no number):

```html
<ul><li>first bullet</li><li>second bullet</li><li>should be numbered</li></ul>
```

Expected (CommonMark: a change of marker type starts a new list):

```html
<ul><li>first bullet</li><li>second bullet</li></ul><ol><li>should be numbered</li></ol>
```

## Root cause

`renderList` (`server/markdown.js:140-161`) collects a contiguous run of marker lines
into one `items` array, then `build(slice)` picks the list tag **once** from
`slice[0].ordered`:

```js
const tag = slice[0].ordered ? 'ol' : 'ol';   // one tag for the whole slice
```

Every sibling at that indent is emitted inside that single `<ul>`/`<ol>`, regardless of
its own `ordered` flag. The per-item `ordered` value is recorded (line 236) but never
consulted when choosing the tag, and the marker text itself was already stripped by the
collecting regex, so a mis-typed item shows no marker at all.

## Fix

In `build`, walk the siblings at a given indent and open a fresh `<ul>`/`<ol>` whenever
the `ordered` flag flips between consecutive siblings, closing the previous one. Children
(deeper indent) still recurse as today. This makes a `1.` after bullets render as its own
`<ol>` (numbered), and a `-` after `1.` render as its own `<ul>`.

## Acceptance criteria

- `- a\n- b\n1. c` renders `<ul>a,b</ul>` followed by `<ol>c</ol>`; the ordered item shows
  a number, not a disc.
- `1. a\n- b` renders `<ol>a</ol>` followed by `<ul>b</ul>`.
- A pure unordered list and a pure ordered list are unchanged (single `<ul>` / `<ol>`).
- Nested lists still nest; a type flip at the nested level splits there too.
- Task-list items (`- [ ]`) are unaffected (still unordered, checkbox preserved).

## Code pointers

- `server/markdown.js:140-161` — `renderList` / `build` (tag chosen from `slice[0]`).
- `server/markdown.js:232-240` — list-block collection (records per-item `ordered`).
- `test/e2e.js:1867+` — markdown render assertions live alongside the choice-block tests.

## Discovery

Found while fixing the task-list wrap-alignment bug (PR #24); called out there as a
separate pre-existing parsing quirk.

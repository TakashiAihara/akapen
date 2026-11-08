# DBML documents

`akapen schema.dbml` opens a DBML file and shows the entity-relationship diagram it describes.

This is one row in the table #139 defines, and it is written down separately only because DBML brings two things the other notations there do not: a parser of its own, and a rendering path that goes through the engine #83 introduces rather than straight to a renderer.

## What this depends on

| | What it provides | What is left here |
|---|---|---|
| #139 | Opening a file as a diagram: the extension-to-kind table, the whole file as one block, and the requirement that the block is built over the untouched source rather than a synthesised fence | Adding `.dbml` to the table |
| #83 | Graphviz as wasm in the browser, on its own bundle entry, loaded on demand | Producing DOT for it to lay out |

**#83 lands first.** DBML is drawn by graphviz, so building it before #83 means choosing a graphviz, and #83 then arrives to find one already there. Two wasm builds of the same engine in one binary is not a trade worth making for ordering.

## What DBML adds

A DBML parser, and a step that turns its output into DOT. Everything after the DOT string is #83's.

```mermaid
flowchart LR
  A["schema.dbml"] --> B["DBML parser"]
  B --> C["DOT"]
  C --> D["graphviz wasm (#83)"]
  D --> E["SVG"]
  E --> F["one block, the whole file"]
```

### Size

Measured as browser bundles, minified.

| | Size |
|---|---|
| DBML parser and checker alone | **92.66 KB** |
| The same package's full render path, graphviz included | 1.47 MB |

Nearly all of the difference is the engine. That is the number behind ordering after #83: on its own DBML costs 1.40 MiB in the binary (1.47% of 95.42 MiB), and after #83 it costs about 93 KB.

### The packaging problem this creates

`@egomobile/dbml-renderer` can emit DOT — `parseDMBL(input, 'dot')` returns a `digraph`, verified. But the function that builds the DOT sits in the same module that imports `@viz-js/viz` at the top level, so importing it pulls the engine in and the 93 KB figure is not reachable as the package stands.

Three ways out, none chosen yet:

1. Ask upstream to split DOT generation from rendering. Cheapest if it happens, and out of our hands if it does not.
2. Vendor the DOT layer. It is a serialiser over the parser's output; the hard part is the parser, and the parser is what the 93 KB already is.
3. Accept the engine twice for now and remove one later. Costs 1.4 MiB and needs somebody to come back.

## Rejected renderers

| | Browser bundle | Why not |
|---|---|---|
| `@softwaretechnik/dbml-renderer` | 2.65 MB | The same capability at 1.8x. `@egomobile/dbml-renderer` is a maintained fork of it. |
| `@dbml/core` with a layout of our own | 15.82 MB | The official parser alone, before any drawing exists, is ten times the chosen one. It carries an antlr4 runtime. |
| Kroki | nothing to bundle | Renders DBML natively over HTTP, and sends the schema under review to a third party. |
| Converting to mermaid `erDiagram` | nothing to bundle | Renders on GitHub for free, and drops the enums, notes and composite indexes that a schema review is about. |

## Putting the SVG on the page

The engine that produces the SVG is #83's, so this is #83's problem too. It is recorded here because the measurements were made against DBML input, and because DBML gives the input an unusual shape: table names and notes are free text that ends up inside graphviz's HTML-like labels.

markdown-it runs with `html: false`, so HTML in a document is shown rather than run. That is not a formatting choice. akapen's page holds an authenticated session and shares an origin with `/api/comments` and with `/api/doc`, which returns the file's absolute path. Script on that page can read the document, its path and its comments, and can write. An SVG is XML, not a picture: it can carry `<script>`, event handlers and `javascript:` links. Rendering one from attacker-controlled text and putting it on the page is the same hole through a different door.

### What was measured

| Injected into | Result |
|---|---|
| A table name, `<b onclick='alert(1)'>` | Entity-escaped in the SVG. Not a live handler. |
| A column note, the same | Same. |
| A table `Note`, `<font href='javascript:alert(1)'>` | Same. |
| A table name, `<img src='javascript:alert(1)'/>` | The renderer fails. No diagram. |

Each generated SVG was put into a real browser's `innerHTML`, and every element was checked for `on*` attributes and for `javascript:` in `href` and `xlink:href`. A positive control — a payload that is live — was run through the same check and was found, so the check distinguishes.

Three shapes is not a proof. graphviz interprets HTML-like labels, so another input shape can reach another place.

### Sanitize from an allowlist

Removing `<script>` and `on*` removes what is already known to be dangerous. Graphviz's output vocabulary is small and fixed, so listing what may stay is shorter and stays closed against elements nobody has considered.

`<foreignObject>` is why the distinction matters: it puts HTML inside an SVG, and it is the element a denylist forgets. An allowlist drops it by not naming it.

Worth naming as considered: `<script>`, `<foreignObject>`, every `on*` attribute, `href` and `xlink:href` beginning `javascript:`, and external references from `<use>`.

### The test keeps its positive control

The check above becomes the test, positive control included. Without one, no findings cannot be told apart from a test that looks at nothing.

An earlier pass of this investigation searched the SVG as a string for `onclick`, matched the entity-escaped text, and concluded the opposite of the truth. A string search over generated markup does not answer this; parsing it into a DOM and reading attributes does.

## DBML that does not parse

An error, and nothing more. The message is passed through — it carries a line number, which is where the reader has to go.

Falling back to the source is what #82 provides. Building a fallback now, to be replaced by it, is work that exists only in between.

Failing input is not exotic: the `<img src='javascript:...'/>` row above is a table name that stops the renderer.

## Words

To be added to `docs/glossary.md` with the implementation, so each entry still points at something that exists.

| Word | What it is | Where it exists |
|---|---|---|
| document kind | what akapen reads a file as. Decided by extension; only parser selection reads it | the extension-to-kind table (#139) |
| markdown document, dbml document | a document named by its kind. Bare "document" is whichever is open | — |
| diagram block | the block holding a figure | `Block`, `kind` |

## Accepted limits

- **A DBML document cannot be commented line by line.** The whole file is one block, so it is worth one comment. #82 is what changes that, and #85 is the version worth having.
- **A round's frozen copy is still `rounds/NNN/content.md`,** and the review directory for `schema.dbml` is `schema.dbml-<hash>`. The name stops being true for a document that is not markdown. Left alone here: changing it means a second read path for reviews already on disk. Tracked in #145.
- **Only `.dbml`.** Another extension is a row in #139's table, but none is claimed to work.

## Not in scope

- **A `dbml` fence inside markdown.** What is wanted is a preview of a file that is opened directly. A fence is a different feature and nobody has asked for it.
- **Pulling a DBML file into a markdown document.** Not part of markdown, and akapen does not define a dialect.

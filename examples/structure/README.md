# The structure set

Every paragraph in `examples/corpus/` is 150 to 400 words of prose with no
heading, list, or code in it. Real Markdown is not like that. Over this
repository's own documentation, two of every five blocks are headings, list
items, table rows, front matter or link definitions, and a third of the blocks
are under eight words.

The files here are the other half of the corpus: documents whose shapes are the
ones a checker meets and the clean corpus never tested. They hold no defect on
purpose. Every flag raised on them is a false positive, and that is the number
they exist to produce.

Point the eval at them:

```
snifftest eval --dry-run examples/structure
```

The countable rules stay quiet on all of it. The judgment arm is never asked
about a heading, a table row, a front matter block, a link definition or an
HTML comment: it runs the same filter `check` runs, and a block that fails it
is scored by the countable rules alone. A request about a heading costs what a
request about a paragraph costs and answers a question nobody asked. The run
says how many blocks it held back, in one sentence under the headline table, so
the number is auditable rather than promised.

| File | What it is made of |
|---|---|
| `handbook-page.md` | Front matter, headings, a table, nested lists, a block quote, link definitions |
| `faq.md` | Headings written as questions, short answers, a numbered procedure |

Both files were written for this repository and carry no defect from any rule.
A sentence added here has to be ordinary writing of that shape; anything meant
to trip a rule belongs in the seed bank instead.

# Sniff Test in Claude Code

Three ways to install, depending on how you like your tools. All three land the
same skill, and all three run the checker the same way: the countable rules
locally and free, the judgment rules only after you have said yes.

## As a plugin

```
/plugin marketplace add DanRWilloughby/snifftest
/plugin install snifftest@snifftest
```

The first line adds this repository as a marketplace. The second installs the
plugin from it. Restart Claude Code and `/snifftest` is there.

## As a skill

```sh
npx skills add DanRWilloughby/snifftest
```

This copies the skill into `~/.claude/skills/snifftest` without the plugin
machinery. Use it if you would rather have one file you can read and edit than
a marketplace entry.

## By hand

```sh
git clone https://github.com/DanRWilloughby/snifftest
cp -r snifftest/skills/snifftest ~/.claude/skills/snifftest
```

The same files, copied yourself.

## What it does once it is in

Say `/snifftest` with a file, or just hand Claude a draft and ask whether it
passes. It runs the countable rules, prints a line per flag, and offers a
rewrite for each one.

A flag reads:

```
path:line rule score message
```

`score` is how sure the checker is, between 0 and 1, not how bad the problem
is. A countable rule always scores 1.00.

## The judgment rules

The judgment rules send the draft to a model, so they are off until you ask.
Ask for them in the conversation. The first time, the tool prints what would
leave the machine and waits for your yes, and remembers the answer under your
config directory. Until then nothing is sent.

They need a key in `TYPESAFE_API_KEY`, in your environment. The skill never
reads it, prints it, or puts it in a command. The checker reads it when it
sends, and nowhere else.

If you have not said yes, the tool exits with code 3 and sends nothing. That is
not an error to work around. It is the question, asked.

## The version

The bundled script pins the version of the checker it fetches, currently
`0.1.0`, rather than taking whatever is newest. Set `SNIFFTEST_VERSION` to move
it, or `SNIFFTEST_BIN` to point at a build of your own.
